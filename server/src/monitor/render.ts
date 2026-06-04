/**
 * The **pure** TUI renderer: a {@link LensSnapshot} + terminal dimensions → an array of exactly `rows`
 * lines. No I/O, no timers, no global state — so it is fully unit-testable (`render.test.ts`). The thin
 * imperative shell that drives the alt-screen, raw-mode keys, resize, and the refresh loop lives in
 * `server/src/tui.ts`.
 *
 * Width correctness with color: lines are built from styled **segments** (`{ t, c }`) whose width is the
 * plain-text length; padding / truncation are computed on that plain width and the ANSI SGR codes are
 * applied only at emit, so a line is exactly `cols` display-columns wide whether or not color is on. The
 * renderer deliberately uses only width-1 glyphs (ASCII + box/bar/sparkline blocks) — no emoji — so a
 * character count equals the display width.
 */

import type { AdmissionAnalyticsSnapshot } from "throttlekit";
import type { LensDenialRow, LensGuardSnapshot, LensSnapshot } from "./types.js";

/** Live view state owned by the shell and threaded through each render. */
export interface ViewState {
  /** Scroll offset (rows) into the denial feed, 0 = newest. */
  scroll: number;
  /** Whether the live feed is frozen. */
  paused: boolean;
}

/** Everything the pure renderer needs for one frame. */
export interface RenderOptions {
  cols: number;
  rows: number;
  /** Epoch-ms "now" for the clock / age display (passed in — the renderer reads no wall clock). */
  now: number;
  /** Recent per-frame deny counts for the throughput sparkline, oldest → newest. */
  denyHistory: readonly number[];
  view: ViewState;
  /** Emit ANSI color. `false` for tests and non-color terminals. */
  color: boolean;
}

type Color = "bold" | "dim" | "red" | "green" | "yellow" | "cyan" | "gray";

const SGR: Record<Color, string> = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};
const RESET = "\x1b[0m";

interface Seg {
  t: string;
  c?: Color;
}
type Line = Seg[];

const BLANK: Line = [{ t: "" }];

/** A bar of `width` cells filled to `frac` (0..1) with solid blocks, the remainder light shade. */
const BAR_FULL = "█";
const BAR_EMPTY = "░";
/** Sparkline ramp, low → high. */
const SPARK = "▁▂▃▄▅▆▇█";
/** Lane render order + accent color (extras append in encounter order). */
const LANE_ORDER = ["rate", "concurrency", "cost", "policy"] as const;
const LANE_COLOR: Record<string, Color> = {
  rate: "cyan",
  concurrency: "yellow",
  cost: "green",
  policy: "gray",
};

function seg(t: string, c?: Color): Seg {
  return c === undefined ? { t } : { t, c };
}

function segWidth(line: Line): number {
  let w = 0;
  for (const s of line) w += s.t.length;
  return w;
}

/** Truncate (with a trailing `…`) or pad a line of segments to exactly `cols` plain columns. */
function clamp(line: Line, cols: number): Line {
  if (cols <= 0) return [{ t: "" }];
  const w = segWidth(line);
  if (w === cols) return line;
  if (w < cols) return [...line, { t: " ".repeat(cols - w) }];
  const out: Line = [];
  let used = 0;
  for (const s of line) {
    if (used >= cols) break;
    const room = cols - used;
    if (s.t.length <= room) {
      out.push(s);
      used += s.t.length;
    } else {
      out.push(seg(room <= 1 ? s.t.slice(0, room) : `${s.t.slice(0, room - 1)}…`, s.c));
      used = cols;
    }
  }
  return out;
}

function emit(line: Line, color: boolean): string {
  if (!color) return line.map((s) => s.t).join("");
  return line.map((s) => (s.c !== undefined ? SGR[s.c] + s.t + RESET : s.t)).join("");
}

/** Compact integer: 1234 → "1.2k", 2_500_000 → "2.5M". */
function compact(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function pct(frac: number): string {
  return `${Math.round(frac * 100)}%`;
}

function bar(frac: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, frac));
  const full = Math.round(clamped * width);
  return BAR_FULL.repeat(full) + BAR_EMPTY.repeat(Math.max(0, width - full));
}

function sparkline(values: readonly number[], width: number): string {
  if (width <= 0) return "";
  const slice = values.slice(-width);
  if (slice.length === 0) return " ".repeat(width);
  const max = Math.max(1, ...slice);
  const spark = slice
    .map(
      (v) => SPARK[Math.min(SPARK.length - 1, Math.round((v / max) * (SPARK.length - 1)))] ?? " ",
    )
    .join("");
  return spark.padStart(width, " ");
}

function clock(now: number): string {
  const d = new Date(now);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The shared analytics fields every policy snapshot carries (limiter or admitter). */
interface CommonAnalytics {
  allowed: number;
  denied: number;
  total: number;
  topDenied: { key: string; count: number }[];
}

function common(a: unknown): CommonAnalytics {
  const o = a as CommonAnalytics;
  return {
    allowed: o.allowed ?? 0,
    denied: o.denied ?? 0,
    total: o.total ?? 0,
    topDenied: Array.isArray(o.topDenied) ? o.topDenied : [],
  };
}

// ── panels ──────────────────────────────────────────────────────────────────

function headerLine(snap: LensSnapshot, opts: RenderOptions): Line {
  const h = snap.health;
  const backend = h?.backend ?? "memory";
  const failMode = h?.failMode ?? "open";
  const left = `ThrottleKit · ${backend} · fail-${failMode} · ${snap.policies.length} policies`;
  const right = `${clock(opts.now)} · ${Math.round(snap.meta.windowMs / 1000)}s window`;
  const gap = Math.max(1, opts.cols - left.length - right.length);
  return [seg(left, "bold"), seg(" ".repeat(gap)), seg(right, "dim")];
}

function throughputLine(snap: LensSnapshot, opts: RenderOptions): Line {
  let allowed = 0;
  let denied = 0;
  for (const p of snap.policies) {
    const c = common(p.analytics);
    allowed += c.allowed;
    denied += c.denied;
  }
  const total = allowed + denied;
  const rate = total > 0 ? denied / total : 0;
  const line: Line = [
    seg("ALLOW ", "dim"),
    seg(compact(allowed).padEnd(7), "green"),
    seg("DENY ", "dim"),
    seg(compact(denied).padEnd(7), denied > 0 ? "red" : "green"),
    seg(`${pct(rate)} deny`.padEnd(12), "dim"),
  ];
  const used = segWidth(line);
  const sparkW = Math.min(24, Math.max(0, opts.cols - used));
  if (sparkW > 0) line.push(seg(sparkline(opts.denyHistory, sparkW), "red"));
  return line;
}

function sectionHeader(title: string, cols: number): Line {
  const label = ` ${title} `;
  const rule = "─".repeat(Math.max(0, cols - label.length - 1));
  return [seg("─", "gray"), seg(label, "bold"), seg(rule, "gray")];
}

/** The binding-axis hero for the first unified admitter (the niche nobody else renders). */
function bindingAxisPanel(snap: LensSnapshot, width: number, budget: number): Line[] {
  const admitter = snap.policies.find((p) => p.kind === "admitter");
  if (admitter === undefined) {
    return [[seg("(needs a unified policy — rate × concurrency)", "dim")]];
  }
  const a = admitter.analytics as AdmissionAnalyticsSnapshot;
  const byLane = (a.deniedByLane ?? {}) as Record<string, number>;
  const denied = a.denied ?? 0;
  const lanes = [
    ...LANE_ORDER.filter((l) => l in byLane),
    ...Object.keys(byLane).filter((l) => !LANE_ORDER.includes(l as (typeof LANE_ORDER)[number])),
  ];
  const out: Line[] = [[seg(admitter.name, "bold"), seg(`  ${denied} denied`, "dim")]];
  const labelW = 12;
  const barW = Math.max(4, Math.min(20, width - labelW - 7));
  for (const lane of lanes.slice(0, budget - 1)) {
    const n = byLane[lane] ?? 0;
    const frac = denied > 0 ? n / denied : 0;
    out.push([
      seg(lane.padEnd(labelW)),
      seg(bar(frac, barW), LANE_COLOR[lane] ?? "cyan"),
      seg(` ${pct(frac)}`, "dim"),
    ]);
  }
  return out;
}

/** Top denied keys merged across every policy (the universal "who is getting throttled"). */
function topKeysPanel(snap: LensSnapshot, width: number, budget: number): Line[] {
  const merged = new Map<string, number>();
  for (const p of snap.policies) {
    for (const hit of common(p.analytics).topDenied) {
      merged.set(hit.key, Math.max(merged.get(hit.key) ?? 0, hit.count));
    }
  }
  const rows = [...merged.entries()].sort((x, y) => y[1] - x[1]).slice(0, budget);
  if (rows.length === 0) return [[seg("(no denials this window)", "dim")]];
  const max = rows[0]?.[1] ?? 1;
  const countW = 6;
  const keyW = Math.max(8, Math.floor((width - countW - 1) * 0.5));
  const barW = Math.max(3, width - keyW - countW - 2);
  return rows.map(([key, count]) => [
    seg(key.length > keyW ? `${key.slice(0, keyW - 1)}…` : key.padEnd(keyW)),
    seg(` ${bar(count / max, barW)} `, "yellow"),
    seg(compact(count).padStart(countW), "dim"),
  ]);
}

/** Place two panels side by side in `cols`, with a 2-space gutter. */
function twoColumn(left: Line[], right: Line[], cols: number): Line[] {
  const gutter = 2;
  const leftW = Math.floor((cols - gutter) / 2);
  const rightW = cols - gutter - leftW;
  const rows = Math.max(left.length, right.length);
  const out: Line[] = [];
  for (let i = 0; i < rows; i++) {
    const l = clamp(left[i] ?? BLANK, leftW);
    const r = clamp(right[i] ?? BLANK, rightW);
    out.push([...l, { t: " ".repeat(gutter) }, ...r]);
  }
  return out;
}

function concurrencyLines(guards: LensGuardSnapshot[]): Line[] {
  if (guards.length === 0) return [[seg("(no concurrency policies configured)", "dim")]];
  return guards.map((g) => {
    const line: Line = [
      seg(g.name.padEnd(16)),
      seg(`${g.inflight}/${g.limit}`.padEnd(8), g.inflight >= g.limit ? "yellow" : "green"),
      seg(`rtt ${Math.round(g.rttNoload)}ms`.padEnd(11), "dim"),
    ];
    if (g.nodes !== undefined)
      line.push(seg(`share ${g.share}/${g.lGlobal} · ${g.nodes}n  `, "dim"));
    if (g.fenced === true) line.push(seg("FENCED", "red"));
    return line;
  });
}

function denialLine(row: LensDenialRow): Line {
  const line: Line = [
    seg(`${clock(row.at)} `, "gray"),
    seg(row.policy.padEnd(14).slice(0, 14)),
    seg(` ${row.key.padEnd(16).slice(0, 16)}`),
  ];
  if (row.lane !== undefined) {
    line.push(seg(` [${row.lane}]`, LANE_COLOR[row.lane] ?? "cyan"));
  }
  line.push(seg(`  rem ${row.decision.remaining}`, "dim"));
  if (row.decision.retryAfterMs > 0) {
    const ra = row.decision.retryAfterMs;
    line.push(seg(`  retry ${ra >= 1000 ? `${(ra / 1000).toFixed(1)}s` : `${ra}ms`}`, "dim"));
  }
  return line;
}

function statusBar(opts: RenderOptions, nodeId: string | undefined): Line {
  const left: Line = [
    seg("q", "bold"),
    seg(" quit  ", "dim"),
    seg("↑↓", "bold"),
    seg(" scroll  ", "dim"),
  ];
  left.push(seg("p", "bold"), seg(" pause", "dim"));
  if (opts.view.paused) left.push(seg("  PAUSED", "yellow"));
  const right = nodeId ?? "";
  const used = segWidth(left) + right.length;
  const gap = Math.max(1, opts.cols - used);
  return [...left, seg(" ".repeat(gap)), seg(right, "dim")];
}

/** Render one full frame: exactly `opts.rows` strings, each exactly `opts.cols` display-columns wide. */
export function renderFrame(snap: LensSnapshot, opts: RenderOptions): string[] {
  const cols = Math.max(20, opts.cols);
  const rows = Math.max(6, opts.rows);

  const content: Line[] = [];
  content.push(headerLine(snap, opts));
  content.push(throughputLine(snap, opts));
  content.push(BLANK);

  content.push(sectionHeader("BINDING AXIS  /  TOP DENIED KEYS", cols));
  const heroBudget = 5;
  // Build each panel to the EXACT column width twoColumn will place it in (gutter 2), so the right
  // column's count field isn't clipped by the final clamp.
  const heroGutter = 2;
  const leftW = Math.floor((cols - heroGutter) / 2);
  const left = bindingAxisPanel(snap, leftW, heroBudget);
  const right = topKeysPanel(snap, cols - heroGutter - leftW, heroBudget);
  content.push(...twoColumn(left, right, cols));
  content.push(BLANK);

  content.push(sectionHeader("CONCURRENCY", cols));
  content.push(...concurrencyLines(snap.guards));
  content.push(BLANK);

  content.push(sectionHeader(opts.view.paused ? "DENIALS (paused)" : "DENIALS (live)", cols));

  // The denial feed is the flex panel: it takes whatever is left above the pinned status bar.
  const feedBudget = Math.max(0, rows - 1 - content.length);
  const feed = snap.recentDenials.slice().reverse();
  const start = Math.max(0, Math.min(opts.view.scroll, Math.max(0, feed.length - feedBudget)));
  const visible = feed.slice(start, start + feedBudget);
  if (visible.length === 0) {
    content.push([seg("(no denials yet — drive some traffic)", "dim")]);
  } else {
    for (const row of visible) content.push(denialLine(row));
  }

  // Pin the status bar to the last row; pad/truncate the content above it to fill exactly rows-1.
  const body = content.slice(0, rows - 1);
  while (body.length < rows - 1) body.push(BLANK);
  const lines = [...body, statusBar(opts, snap.meta.nodeId)];

  return lines.map((line) => emit(clamp(line, cols), opts.color));
}
