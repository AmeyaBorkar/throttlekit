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
  let frozen = hub.snapshot();
  let stopped = false;

  const paint = (): void => {
    if (stopped) return;
    const snap = view.paused ? frozen : hub.snapshot();
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
      if (view.paused) frozen = hub.snapshot();
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
