import type { Decision } from "../../core/types";

/**
 * Whether a metric is computed exactly or approximately. v1 metrics are all **exact** (replay output is
 * bounded, so an exact pass is cheap); the tag keeps the bit-exact columns structurally separate from any
 * future sketch-backed column (design §7 — never contaminate the exact core with a fuzzy number).
 */
export type MetricKind = "exact" | "approx";

/**
 * Across which candidates a metric is meaningfully comparable.
 *
 * - `any`           — comparable across *any* strategy (an admit/deny decision means the same everywhere).
 * - `same-strategy` — only comparable within one strategy: `retryAfterMs`/`remaining` have strategy-
 *                     specific meaning (GCRA smooth pacing vs fixed-window time-to-edge), so the scorecard
 *                     reports but does not rank them across a strategy change.
 */
export type ComparableAcross = "any" | "same-strategy";

/**
 * A named metric over a decision stream. `reduce` folds the (bounded) replayed `Decision`s to one number.
 * The bounded `reduce(array)` form is v1; a streaming `{ init; observe; finalize }` reducer + a
 * sketch-backed approximate reducer are the reserved seam for unbounded / fleet data (Phase B).
 *
 * @experimental Part of the opt-in replay testkit (see STABILITY.md).
 */
export interface ScoreReducer {
  /** Stable identifier (the scorecard column id). */
  readonly id: string;
  /** Exact or approximate (v1: always `"exact"`). */
  readonly kind: MetricKind;
  /** Across which candidates this column may be ranked. */
  readonly comparableAcross: ComparableAcross;
  /** Fold a decision stream to one number. */
  reduce(decisions: readonly Decision[]): number;
}

/**
 * Exact `p`-quantile (0..1) by **nearest-rank** over already-sorted ascending `values`. Empty ⇒ 0. For
 * `p=0.99` of a short array this returns the max — the honest "worst observed", not an interpolation.
 */
export function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(p * sorted.length) - 1;
  const idx = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[idx] as number;
}

function sortedAsc(decisions: readonly Decision[], pick: (d: Decision) => number): number[] {
  return decisions.map(pick).sort((a, b) => a - b);
}

/** Fraction of decisions that were admitted (0..1). Exact; comparable across any strategy. */
export const allowRate: ScoreReducer = {
  id: "allow-rate",
  kind: "exact",
  comparableAcross: "any",
  reduce: (ds) => (ds.length === 0 ? 0 : ds.filter((d) => d.allowed).length / ds.length),
};

/** Count of admitted decisions. Exact; comparable across any strategy. */
export const allowCount: ScoreReducer = {
  id: "allow-count",
  kind: "exact",
  comparableAcross: "any",
  reduce: (ds) => ds.filter((d) => d.allowed).length,
};

/** Count of denied decisions. Exact; comparable across any strategy. */
export const denyCount: ScoreReducer = {
  id: "deny-count",
  kind: "exact",
  comparableAcross: "any",
  reduce: (ds) => ds.filter((d) => !d.allowed).length,
};

/**
 * p99 of `retryAfterMs` over all decisions. Exact; **same-strategy** — the retry-after a strategy emits
 * is algorithm-specific, so it is reported but not ranked across a strategy change.
 */
export const retryP99: ScoreReducer = {
  id: "retry-p99-ms",
  kind: "exact",
  comparableAcross: "same-strategy",
  reduce: (ds) =>
    quantile(
      sortedAsc(ds, (d) => d.retryAfterMs),
      0.99,
    ),
};

/**
 * Median `remaining` over all decisions. Exact; **same-strategy** — `remaining` counts a strategy-
 * specific budget (window slots vs token-bucket tokens), so it is reported but not ranked across strategies.
 */
export const remainingP50: ScoreReducer = {
  id: "remaining-p50",
  kind: "exact",
  comparableAcross: "same-strategy",
  reduce: (ds) =>
    quantile(
      sortedAsc(ds, (d) => d.remaining),
      0.5,
    ),
};

/** The default scorecard columns: admit/deny (any-strategy) + retry/remaining (same-strategy). */
export const DEFAULT_REDUCERS: readonly ScoreReducer[] = [
  allowRate,
  allowCount,
  denyCount,
  retryP99,
  remainingP50,
];
