/**
 * The TUI **shell** — the thin, impure driver around the pure renderer (`monitor/render.ts`). It owns the
 * terminal: enters the alternate screen buffer, hides the cursor, puts stdin in raw mode for key handling
 * (q / ↑↓ / p), repaints ~4×/s off `hub.snapshot()`, and reacts to resize. All rendering lives in the pure
 * `renderFrame`; this file only does I/O, so it stays small and the dashboard logic stays testable.
 *
 * A TUI inherently owns the terminal, so it can't be on-by-default like a loopback web page — the server
 * enables it with `--tui`. Headless/production monitoring stays on OpenTelemetry → Grafana.
 */

import type { LensHub } from "./monitor/hub.js";
import { TABS, type TabId, type ViewState, renderFrame } from "./monitor/render.js";
import type { LensPlanSnapshot, LensReplaySnapshot, LensSnapshot } from "./monitor/types.js";
import { corpusFromShadow } from "./policy/corpus.js";
import { runPolicyPlan } from "./policy/plan.js";
import { type ReplayDivergenceSnapshot, describeCandidate } from "./replay/whatif.js";
import type { WiredReplay } from "./replay/wire.js";

/** The last plan a `P` keypress produced, projected for {@link LensPlanSnapshot}. */
type PlanLast = NonNullable<LensPlanSnapshot["last"]>;

/** True only when both ends are a real interactive terminal (else the alt-screen / raw-mode dance fails). */
export function canRunTui(): boolean {
  return process.stdout.isTTY === true && process.stdin.isTTY === true;
}

/** A running TUI; `stop()` restores the terminal (idempotent). */
export interface RunningTui {
  stop(): void;
}

export interface RunTuiOptions {
  /** Stable node id shown in the status bar. */
  nodeId?: string;
  /** Repaint interval (ms). Default 250. */
  intervalMs?: number;
  /** Called when the user quits (q / Ctrl-C) — wire this to the server's graceful shutdown. */
  onQuit: () => void;
  /**
   * The wired deterministic-capture machinery (#290/#299), when an enabled `replay:` block is configured.
   * Drives the Replay tab's shadow status; the `r` key runs the configured what-if. Omit ⇒ the Replay tab
   * shows an honest "deterministic capture off" placeholder.
   */
  replay?: WiredReplay;
  /**
   * Whole-config Plan inputs (#312), when `--plan-candidate` is set: the current (running) + candidate config
   * texts. The `P` key diffs the candidate against the current over the LIVE shadow corpus (from {@link
   * replay}). Omit ⇒ the Plan tab shows an honest "no candidate" placeholder. Needs an enabled `replay:` block
   * too (the shadows ARE the corpus); without it the tab shows "no shadows".
   */
  plan?: { current: string; candidate: string; candidateLabel?: string };
}

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const HOME = "\x1b[H";
const CLEAR_EOL = "\x1b[K";
const DENY_HISTORY = 120;

/**
 * Start the terminal dashboard against `hub`. Returns a handle whose `stop()` tears the terminal back
 * down. Caller must check {@link canRunTui} first (this assumes a TTY).
 */
export function runTui(hub: LensHub, opts: RunTuiOptions): RunningTui {
  const out = process.stdout;
  const input = process.stdin;
  const color = out.isTTY === true && !process.env.NO_COLOR;
  const view: ViewState = { scroll: 0, paused: false, tab: "overview" };
  const denyHistory: number[] = [];
  let prevDenied = 0;
  let stopped = false;

  // Deterministic-capture (#290): the Replay tab reads live shadow status + the last `r`-triggered what-if.
  const replay = opts.replay;
  let lastReplay: ReplayDivergenceSnapshot | undefined;
  const buildReplaySnapshot = (): LensReplaySnapshot | undefined => {
    if (replay === undefined) return undefined;
    const shadows = [...replay.shadows.entries()].map(([policy, s]) => ({
      policy,
      steps: s.steps,
      truncated: s.truncated,
      poisoned: s.poisoned,
    }));
    const cc = replay.config.candidate;
    return {
      enabled: replay.enabled,
      shadows,
      ...(cc !== undefined
        ? { candidate: { policy: cc.policy, label: describeCandidate(cc.candidate) } }
        : {}),
      ...(lastReplay !== undefined ? { lastResult: lastReplay } : {}),
    };
  };
  // Whole-config Plan (#312): the `P` key diffs the candidate config vs the current over the LIVE shadow
  // corpus. The Plan tab needs BOTH the shadows (corpus) and a --plan-candidate (the candidate config).
  const planOpt = opts.plan;
  let lastPlan: PlanLast | undefined;
  /** Run a whole-config plan off the decision path; `undefined` when the Plan tab isn't fully wired. */
  const runPlan = (): PlanLast | undefined => {
    if (planOpt === undefined || replay === undefined || !replay.enabled) return undefined;
    const ranAt = Date.now();
    const { corpus } = corpusFromShadow(replay.shadows);
    const result = runPolicyPlan({
      currentConfig: planOpt.current,
      candidateConfig: planOpt.candidate,
      corpus,
    });
    if (!result.ok || result.plan === undefined) {
      return {
        ok: false,
        ranAt,
        corpusSteps: 0,
        corpusPolicies: 0,
        truncated: false,
        allowToDeny: 0,
        denyToAllow: 0,
        affectedKeys: 0,
        replayable: 0,
        policies: 0,
        diffs: [],
        ...(result.error !== undefined ? { error: result.error } : {}),
      };
    }
    const pl = result.plan;
    return {
      ok: true,
      ranAt,
      corpusSteps: pl.corpus.steps,
      corpusPolicies: pl.corpus.policies,
      truncated: pl.corpus.truncated,
      allowToDeny: pl.summary.allowToDeny,
      denyToAllow: pl.summary.denyToAllow,
      affectedKeys: pl.summary.affectedKeys,
      replayable: pl.summary.replayable,
      policies: pl.summary.policies,
      diffs: pl.diffs.map((d) => ({
        policy: d.policy,
        state: d.state,
        allowToDeny: d.allowToDeny,
        denyToAllow: d.denyToAllow,
        steps: d.steps,
      })),
    };
  };
  const buildPlanSnapshot = (): LensPlanSnapshot => {
    const haveShadows = replay?.enabled === true && replay.shadows.size > 0;
    const enabled = planOpt !== undefined && haveShadows;
    const snap: LensPlanSnapshot = { enabled };
    if (!enabled) snap.off = planOpt === undefined ? "no-candidate" : "no-shadows";
    if (planOpt?.candidateLabel !== undefined) snap.candidateLabel = planOpt.candidateLabel;
    if (lastPlan !== undefined) snap.last = lastPlan;
    return snap;
  };

  // The hub snapshot, augmented with the Replay + Plan panels (additive — each absent when not wired).
  const composeSnapshot = (): LensSnapshot => {
    const base = hub.snapshot();
    const rs = buildReplaySnapshot();
    return {
      ...base,
      ...(rs !== undefined ? { replay: rs } : {}),
      plan: buildPlanSnapshot(),
    };
  };
  let frozen = composeSnapshot();

  const paint = (): void => {
    if (stopped) return;
    const snap = view.paused ? frozen : composeSnapshot();
    if (!view.paused) {
      // Per-frame new denials = the sparkline's "activity" signal (resets cleanly each analytics window).
      let denied = 0;
      for (const p of snap.policies) denied += (p.analytics as { denied?: number }).denied ?? 0;
      denyHistory.push(Math.max(0, denied - prevDenied));
      if (denyHistory.length > DENY_HISTORY) denyHistory.shift();
      prevDenied = denied;
    }
    let frame: string[];
    try {
      frame = renderFrame(snap, {
        cols: out.columns ?? 80,
        rows: out.rows ?? 24,
        now: Date.now(),
        denyHistory,
        view,
        color,
      });
    } catch (err) {
      frame = [`render error: ${err instanceof Error ? err.message : String(err)}`];
    }
    out.write(HOME + frame.map((line) => line + CLEAR_EOL).join("\r\n"));
  };

  const timer = setInterval(paint, opts.intervalMs ?? 250);

  /**
   * Jump to a tab, resetting the feed scroll only when the view actually changes — so re-pressing the
   * current view's number key doesn't throw away the user's scroll position.
   */
  const goToTab = (id: TabId): void => {
    if (id === view.tab) return;
    view.tab = id;
    view.scroll = 0;
  };

  /** Move the active tab by `dir` (wrapping). */
  const switchTab = (dir: number): void => {
    const i = TABS.findIndex((t) => t.id === view.tab);
    const next = TABS[(i + dir + TABS.length) % TABS.length];
    if (next !== undefined) goToTab(next.id);
  };

  const onKey = (data: Buffer): void => {
    const k = data.toString("utf8");
    if (k === "q" || k === "\x03") {
      stop();
      opts.onQuit();
      return;
    }
    if (k === "\x1b[A")
      view.scroll += 1; // up → older
    else if (k === "\x1b[B")
      view.scroll = Math.max(0, view.scroll - 1); // down → newer
    else if (k === "\x1b[5~")
      view.scroll += 10; // page up
    else if (k === "\x1b[6~")
      view.scroll = Math.max(0, view.scroll - 10); // page down
    else if (k === "g")
      view.scroll = 1_000_000; // oldest (clamped by the renderer)
    else if (k === "G")
      view.scroll = 0; // newest
    else if (k === "\t")
      switchTab(1); // Tab → next view
    else if (k === "\x1b[Z")
      switchTab(-1); // Shift-Tab → previous view
    else if (k.length === 1 && k >= "1" && k <= "9") {
      // A single digit jumps to that view. The `length === 1` guard keeps coalesced reads (e.g. a digit
      // arriving in the same chunk as a following arrow) out of this branch so they aren't swallowed.
      const t = TABS[Number(k) - 1];
      if (t === undefined) return; // out-of-range digit: no-op
      goToTab(t.id);
    } else if (k === "p") {
      view.paused = !view.paused;
      if (view.paused) frozen = composeSnapshot();
    } else if (k === "r") {
      // Run the configured what-if (off the decision path, over the shadow's isolated store) and show it on
      // the Replay tab. A no-op what-if (no replay/candidate wired) just navigates there — the tab explains
      // what to configure. Refresh the frozen snapshot if paused so the new result is visible.
      if (replay !== undefined) {
        const res = replay.runConfiguredWhatIf();
        if (res !== undefined) lastReplay = res;
        if (view.paused) frozen = composeSnapshot();
      }
      goToTab("replay");
    } else if (k === "P") {
      // Run a WHOLE-CONFIG plan (the candidate vs the current over the live shadow corpus, off the decision
      // path) and show it on the Plan tab. A no-op when the tab isn't fully wired — it then just navigates
      // and the tab explains what to configure. Refresh the frozen snapshot if paused so the plan is visible.
      const res = runPlan();
      if (res !== undefined) lastPlan = res;
      if (view.paused) frozen = composeSnapshot();
      goToTab("plan");
    } else return;
    paint();
  };

  const onResize = (): void => paint();

  if (input.setRawMode) input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  input.on("data", onKey);
  out.on("resize", onResize);
  out.write(ALT_ON + CURSOR_HIDE);
  paint();

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    input.off("data", onKey);
    out.off("resize", onResize);
    if (input.setRawMode) input.setRawMode(false);
    input.pause();
    out.write(CURSOR_SHOW + ALT_OFF);
  }

  return { stop };
}
