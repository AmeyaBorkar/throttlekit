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
import type {
  LensDenialRow,
  LensGuardSnapshot,
  LensPolicySnapshot,
  LensSnapshot,
} from "./types.js";

/** A dashboard tab. The body below the persistent header/throughput strip is per-tab. */
export type TabId = "overview" | "latency" | "fairness" | "capacity" | "guarantee";

/**
 * The tabs in display + cycle order. Exported so the shell (`tui.ts`) maps number keys / Tab to them
 * without re-declaring the list. `overview` is today's board; the rest land panel-by-panel (see
 * `research/dashboard/ROADMAP.md`).
 */
export const TABS: readonly { readonly id: TabId; readonly label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "latency", label: "Latency" },
  { id: "fairness", label: "Fairness" },
  { id: "capacity", label: "Capacity" },
  { id: "guarantee", label: "Guarantee" },
];

/** Live view state owned by the shell and threaded through each render. */
export interface ViewState {
  /** Scroll offset (rows) into the denial feed, 0 = newest. */
  scroll: number;
  /** Whether the live feed is frozen. */
  paused: boolean;
  /** The active tab; selects which body the frame renders below the persistent strip. */
  tab: TabId;
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
/** Where a not-yet-built tab points users — a stable, reachable URL, not a working-tree repo path
 * (research/ is not in the package, so a local path would be a dead pointer for npm installs). */
const DOCS_URL = "https://github.com/AmeyaBorkar/throttlekit/wiki/Monitoring-and-the-Lens";
/** The Latency view flags a policy's p99 yellow only when its tail is heavy relative to the policy's own
 * median AND above a small absolute floor — matching the dashboard's relative-coloring convention (the
 * concurrency panel yellows at inflight ≥ limit, not at a bare magnitude). */
const LATENCY_TAIL_MULTIPLE = 10;
const LATENCY_WARN_FLOOR_MS = 25;

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

/**
 * Compact milliseconds: 0.42 → "0.42ms", 12.5 → "12.5ms", 240 → "240ms", 1500 → "1.5s". Each branch tests
 * the value AT THE PRECISION IT WILL PRINT, so a sample that rounds up across a magnitude boundary (e.g.
 * 999.5 → "1.0s", not "1000ms") is shown by the right bracket rather than the one below it.
 */
function ms(v: number): string {
  const r1 = Number(v.toFixed(2));
  if (r1 < 10) return `${r1.toFixed(2)}ms`;
  const r2 = Number(v.toFixed(1));
  if (r2 < 100) return `${r2.toFixed(1)}ms`;
  if (Math.round(v) < 1000) return `${Math.round(v)}ms`;
  return `${(v / 1000).toFixed(1)}s`;
}

/** True when a policy's latency tail is worth flagging: heavy vs its own median AND above the floor. */
function latencyWarn(p50: number, p99: number): boolean {
  return p99 >= LATENCY_WARN_FLOOR_MS && p99 >= LATENCY_TAIL_MULTIPLE * p50;
}

/** A relative ETA from an absolute epoch-ms target: "now" once reached, else the compact ms distance. */
function etaMs(at: number, now: number): string {
  return at - now <= 0 ? "now" : ms(at - now);
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

/** The tab bar: every tab, the active one accented. `clamp` truncates it on a narrow terminal. */
function tabStrip(active: TabId, cols: number): Line {
  const line: Line = [seg(" ")];
  TABS.forEach((t, i) => {
    if (i > 0) line.push(seg(" │ ", "gray"));
    line.push(seg(t.label, t.id === active ? "cyan" : "dim"));
  });
  return clamp(line, cols);
}

/** The body for a tab that hasn't been built yet — an honest placeholder, not a crash or a blank. */
function placeholderBody(tab: TabId): Line[] {
  const label = TABS.find((t) => t.id === tab)?.label ?? tab;
  return [
    BLANK,
    [seg(`  ${label}`, "bold")],
    [seg("  — lands in a later throttlekit-server build —", "dim")],
    [seg(`  see ${DOCS_URL}`, "gray")],
  ];
}

/**
 * The Latency view: per-policy admit-path latency (avg / p50 / p99 / max) over the hub's sample ring.
 * A policy with no samples this window renders an honest "no samples" row rather than fabricated zeros.
 */
function latencyBody(snap: LensSnapshot, cols: number): Line[] {
  const nameW = 16;
  const colW = 9;
  const out: Line[] = [
    sectionHeader("LATENCY  ·  admit-path", cols),
    [
      seg("policy".padEnd(nameW), "dim"),
      seg("avg".padStart(colW), "dim"),
      seg("p50".padStart(colW), "dim"),
      seg("p99".padStart(colW), "dim"),
      seg("max".padStart(colW), "dim"),
      seg("n".padStart(7), "dim"),
    ],
  ];
  if (snap.policies.length === 0) {
    out.push([seg("(no policies configured)", "dim")]);
    return out;
  }
  for (const p of snap.policies) {
    const name = p.name.length > nameW ? `${p.name.slice(0, nameW - 1)}…` : p.name.padEnd(nameW);
    const lat = p.latency;
    if (lat === undefined) {
      out.push([seg(name), seg("— no samples yet —", "dim")]);
      continue;
    }
    out.push([
      seg(name),
      seg(ms(lat.avgMs).padStart(colW)),
      seg(ms(lat.p50Ms).padStart(colW)),
      seg(ms(lat.p99Ms).padStart(colW), latencyWarn(lat.p50Ms, lat.p99Ms) ? "yellow" : undefined),
      seg(ms(lat.maxMs).padStart(colW), "dim"),
      seg(compact(lat.n).padStart(7), "dim"),
    ]);
  }
  return out;
}

/** The shape a `kind: "wfe"` stats source carries (a subset of the core's WeightedFairEscrowStats). */
interface WfeStatsValue {
  effectiveLimit: number;
  totalUsed: number;
  pool: number;
  tenants: ReadonlyArray<{ tenant: string; weight: number; used: number }>;
}

/** Narrow an unknown `trackStats` value to the WFE shape — a malformed source renders nothing, not a crash. */
function asWfe(v: unknown): WfeStatsValue | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.effectiveLimit !== "number" || !Array.isArray(o.tenants)) return undefined;
  return o as unknown as WfeStatsValue;
}

/**
 * The Fairness view: for each weighted-fair-escrow policy, per-tenant guaranteed share vs used vs
 * borrowed against the shared budget L. The guaranteed share gᵢ = ⌊wᵢ/ΣW · L_effective⌋ is recomputed
 * over the active set (ΣW = total weight of the reporting tenants); the bar splits each tenant's use
 * into the part within its guarantee (green) and the part borrowed from idle tenants' surplus (yellow).
 */
function fairnessBody(snap: LensSnapshot, cols: number): Line[] {
  const wfes = snap.stats.filter((s) => s.kind === "wfe");
  if (wfes.length === 0) {
    return [
      sectionHeader("FAIRNESS  ·  weighted-fair-escrow", cols),
      BLANK,
      [seg("  (no fair-share policies reporting)", "dim")],
      [
        seg(
          `  weighted-fair-escrow splits one budget across tenants by weight — ${DOCS_URL}`,
          "gray",
        ),
      ],
    ];
  }
  const out: Line[] = [];
  const nameW = 18;
  const numW = 7;
  for (const s of wfes) {
    out.push(sectionHeader(`FAIRNESS  ·  ${s.name}`, cols));
    const w = asWfe(s.value);
    if (w === undefined) {
      out.push([seg("  (stats unavailable)", "dim")]);
      continue;
    }
    const L = w.effectiveLimit;
    out.push([
      seg(`  L ${compact(L)}`, "dim"),
      seg(`   used ${compact(w.totalUsed)}`, "dim"),
      seg(`   free ${compact(w.pool)}`, w.pool > 0 ? "green" : "yellow"),
    ]);
    // Coerce each tenant defensively — trackStats takes an arbitrary thunk, so a non-core source could
    // hand a malformed row; a bad element must render nothing, never throw (which would collapse every tab).
    const tenants = (w.tenants as readonly unknown[]).map((raw) => {
      const t = (raw ?? {}) as { tenant?: unknown; weight?: unknown; used?: unknown };
      return {
        tenant: String(t.tenant ?? "?"),
        weight: Math.max(0, Number(t.weight) || 0),
        used: Math.max(0, Number(t.used) || 0),
      };
    });
    if (tenants.length === 0) {
      out.push([seg("  (no active tenants this window)", "dim")]);
      continue;
    }
    // ΣW covers ALL reporting tenants (not just the rendered top-K). Use the core's exact operation order
    // — ⌊w·L/ΣW⌋ (multiply-then-divide) — so the displayed guarantee is bit-identical to the core's gᵢ
    // (divide-then-multiply drifts by ±1 in ~0.1% of float cases).
    const totalWeight = tenants.reduce((a, t) => a + t.weight, 0) || 1;
    const withGuar = tenants.map((t) => ({ ...t, guar: Math.floor((t.weight * L) / totalWeight) }));
    // Rank by max(used, guarantee), so a starved high-weight tenant (low used, high guar — the textbook
    // unfairness signal) stays visible rather than sorting to the bottom behind busy borrowers.
    withGuar.sort((a, b) => Math.max(b.used, b.guar) - Math.max(a.used, a.guar));
    const rows = withGuar.slice(0, 10);
    const barW = Math.max(6, Math.min(28, cols - nameW - numW * 3 - 4));
    out.push([
      seg("  tenant".padEnd(nameW), "dim"),
      seg("used".padStart(numW), "dim"),
      seg("guar".padStart(numW), "dim"),
      seg("borrow".padStart(numW), "dim"),
    ]);
    for (const t of rows) {
      const within = Math.min(t.used, t.guar);
      const borrow = Math.max(0, t.used - t.guar);
      const greenW = L > 0 ? Math.max(0, Math.min(barW, Math.round((within / L) * barW))) : 0;
      const yellowW =
        L > 0 ? Math.max(0, Math.min(barW - greenW, Math.round((borrow / L) * barW))) : 0;
      const emptyW = Math.max(0, barW - greenW - yellowW);
      const name = `  ${t.tenant}`;
      out.push([
        seg(name.length > nameW ? `${name.slice(0, nameW - 1)}…` : name.padEnd(nameW)),
        seg(compact(t.used).padStart(numW)),
        seg(compact(t.guar).padStart(numW), "dim"),
        seg(
          (borrow > 0 ? `+${compact(borrow)}` : "—").padStart(numW),
          borrow > 0 ? "yellow" : "dim",
        ),
        seg("  "),
        seg(BAR_FULL.repeat(greenW), "green"),
        seg(BAR_FULL.repeat(yellowW), "yellow"),
        seg(BAR_EMPTY.repeat(emptyW), "gray"),
      ]);
    }
    const hidden = withGuar.slice(10);
    if (hidden.length > 0) {
      const starved = hidden.filter((t) => t.used < t.guar).length;
      out.push([
        seg(
          `  … +${hidden.length} more${starved > 0 ? ` (${starved} below guarantee)` : ""}`,
          "dim",
        ),
      ]);
    }
  }
  return out;
}

/**
 * The Capacity view: per policy, a non-consuming forecast for the hottest key — how many requests are
 * spendable now, when capacity next returns, and when it is fully replenished. A policy without a forecast
 * (an async store, an admitter, or no traffic yet) renders "n/a" honestly rather than a fabricated number.
 */
function capacityBody(snap: LensSnapshot, cols: number): Line[] {
  const nameW = 16;
  const keyW = 18;
  const numW = 9;
  // Anchor ETAs to when the forecast was taken (snapshot time), NOT the render wall clock — so a paused
  // (frozen) snapshot's ETAs stay consistent with its frozen spendable count instead of drifting to "now".
  const at = snap.meta.generatedAt;
  const out: Line[] = [
    sectionHeader("CAPACITY  ·  forecast for the hottest key", cols),
    [
      seg("  policy".padEnd(nameW), "dim"),
      seg("key".padEnd(keyW), "dim"),
      seg("spendable".padStart(numW), "dim"),
      seg("+1 in".padStart(numW), "dim"),
      seg("full in".padStart(numW), "dim"),
    ],
  ];
  if (snap.policies.length === 0) {
    out.push([seg("  (no policies configured)", "dim")]);
    return out;
  }
  for (const p of snap.policies) {
    const rawName = `  ${p.name}`;
    const name = rawName.length > nameW ? `${rawName.slice(0, nameW - 1)}…` : rawName.padEnd(nameW);
    const f = p.forecast;
    if (f === undefined) {
      out.push([
        seg(name),
        seg(forecastUnavailableLabel(p).padEnd(keyW), "dim"),
        seg("n/a".padStart(numW), "dim"),
        seg("n/a".padStart(numW), "dim"),
        seg("n/a".padStart(numW), "dim"),
      ]);
      continue;
    }
    const key = f.key.length > keyW - 1 ? `${f.key.slice(0, keyW - 2)}…` : f.key.padEnd(keyW);
    out.push([
      seg(name),
      seg(key),
      seg(compact(f.spendableNow).padStart(numW), f.spendableNow > 0 ? "green" : "yellow"),
      seg(etaMs(f.nextReplenishAt, at).padStart(numW), "dim"),
      seg(etaMs(f.fullAt, at).padStart(numW), "dim"),
    ]);
  }
  return out;
}

/** The honest reason a policy has no forecast — distinguishing an async store from idle / no-forecast. */
function forecastUnavailableLabel(p: LensPolicySnapshot): string {
  if (p.kind === "admitter") return "(admitter)";
  switch (p.forecastUnavailable) {
    case "async":
      return "(async store)";
    case "unsupported":
      return "(no forecast)";
    default:
      return "(no traffic yet)";
  }
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
    seg("1-5/Tab", "bold"),
    seg(" views  ", "dim"),
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
  // The tab strip takes the row that used to be blank, so the overview's layout is unchanged.
  content.push(tabStrip(opts.view.tab, cols));

  if (opts.view.tab === "overview") {
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
  } else if (opts.view.tab === "latency") {
    content.push(...latencyBody(snap, cols));
  } else if (opts.view.tab === "fairness") {
    content.push(...fairnessBody(snap, cols));
  } else if (opts.view.tab === "capacity") {
    content.push(...capacityBody(snap, cols));
  } else {
    content.push(...placeholderBody(opts.view.tab));
  }

  // Pin the status bar to the last row; pad/truncate the content above it to fill exactly rows-1.
  const body = content.slice(0, rows - 1);
  while (body.length < rows - 1) body.push(BLANK);
  const lines = [...body, statusBar(opts, snap.meta.nodeId)];

  return lines.map((line) => emit(clamp(line, cols), opts.color));
}
