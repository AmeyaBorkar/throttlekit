/**
 * GALE Pillar 4 — Weighted Fair Escrow (WFE): weighted, work-conserving fairness across tenants.
 * Design + proofs: research/gale/PILLAR4-fairness.md.
 *
 * Pillars 1-3 fix the *total* credits per window (safety, lease size, adaptation); Pillar 4 fixes the
 * *split* — which tenant gets a contended credit — without ever changing the total, so the Pillar-1
 * overshoot bound (Delta = 0, independent of N) is inherited verbatim. The split target is the
 * weighted max-min fair allocation (water-filling): work-conserving (no idle budget while a tenant is
 * backlogged) AND weight-honoring (every backlogged tenant gets at least its guaranteed share g_i).
 *
 * Pure and deterministic: no clock, no RNG. The integer allocation is exact weighted max-min; the
 * float allocation is the continuous ideal it rounds (the >= 1-credit gap is the DRR quantum slack).
 */

/** Sum of a numeric vector. */
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

function validate(demands: readonly number[], weights: readonly number[], limit: number): void {
  if (demands.length !== weights.length)
    throw new RangeError(`demands/weights length mismatch: ${demands.length} vs ${weights.length}`);
  if (!Number.isFinite(limit) || limit < 0)
    throw new RangeError(`limit must be >= 0, got ${limit}`);
  for (const w of weights) if (!(w > 0)) throw new RangeError(`weights must be > 0, got ${w}`);
  for (const d of demands) if (!(d >= 0)) throw new RangeError(`demands must be >= 0, got ${d}`);
}

/**
 * Guaranteed weighted share floor(w_i / W * L) — each tenant's static slice, and the floor WFE never
 * drops a backlogged tenant below (Theorem T2). Sum over tenants is <= L.
 */
export function guaranteedShare(weights: readonly number[], limit: number): number[] {
  const W = sum(weights);
  return weights.map((w) => Math.floor((w / W) * limit));
}

/**
 * Continuous weighted max-min fair allocation (water-filling): raise a level lambda, give each tenant
 * min(d_i, w_i * lambda), until the budget is spent or all demand is met. Returns real-valued shares
 * summing to min(sum demand, limit). This is the fairness ideal that the integer scheme rounds.
 */
export function waterfill(
  demands: readonly number[],
  weights: readonly number[],
  limit: number,
): number[] {
  validate(demands, weights, limit);
  const n = demands.length;
  const alloc = new Array<number>(n).fill(0);
  // Process tenants in ascending demand-per-weight: the cheapest-to-satisfy saturate first.
  const order = [...Array(n).keys()].sort(
    (a, b) =>
      (demands[a] as number) / (weights[a] as number) -
      (demands[b] as number) / (weights[b] as number),
  );
  let rem = limit;
  let activeWeight = sum(weights);
  for (let k = 0; k < n; k++) {
    const i = order[k] as number;
    const w = weights[i] as number;
    const d = demands[i] as number;
    const level = activeWeight > 0 ? rem / activeWeight : 0;
    if (w * level >= d) {
      // Tenant i saturates at or below this level: fully served, free its weight for the rest.
      alloc[i] = d;
      rem -= d;
      activeWeight -= w;
    } else {
      // Tenant i (and every remaining, higher demand-per-weight tenant) is capped by the level.
      for (let j = k; j < n; j++) {
        const m = order[j] as number;
        alloc[m] = (weights[m] as number) * level;
      }
      break;
    }
  }
  return alloc;
}

/**
 * Exact integer weighted max-min fair allocation via unit drip: repeatedly give one credit to the
 * backlogged tenant with the smallest normalized allocation a_i / w_i. Sums to exactly
 * min(sum demand, limit); this is the realized credit split (credits are integral). O(limit * N).
 */
export function waterfillInt(
  demands: readonly number[],
  weights: readonly number[],
  limit: number,
): number[] {
  validate(demands, weights, limit);
  const n = demands.length;
  const alloc = new Array<number>(n).fill(0);
  let budget = Math.floor(limit);
  while (budget > 0) {
    let best = -1;
    let bestRatio = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      if ((alloc[i] as number) >= (demands[i] as number)) continue; // tenant fully served
      const ratio = (alloc[i] as number) / (weights[i] as number);
      if (ratio < bestRatio) {
        bestRatio = ratio;
        best = i;
      }
    }
    if (best === -1) break; // all demand satisfied before the budget ran out
    alloc[best] = (alloc[best] as number) + 1;
    budget--;
  }
  return alloc;
}

/**
 * Static weighted-share allocation: a_i = min(d_i, g_i) with g_i = floor(w_i/W * L). Weight-honoring
 * but NOT work-conserving — a tenant demanding below its share leaves the remainder stranded.
 */
export function staticShareAlloc(
  demands: readonly number[],
  weights: readonly number[],
  limit: number,
): number[] {
  validate(demands, weights, limit);
  const g = guaranteedShare(weights, limit);
  return demands.map((d, i) => Math.min(d, g[i] as number));
}

/** Jain's fairness index of a vector in (0, 1]; 1 == perfectly equal. */
export function jainFairness(values: readonly number[]): number {
  if (values.length === 0) return 1;
  const s = sum(values);
  const sq = sum(values.map((v) => v * v));
  return sq > 0 ? (s * s) / (values.length * sq) : 1;
}

/**
 * Spread of normalized service a_i / w_i across tenants still backlogged (a_i < d_i). For weighted
 * max-min this is ~0 (all level-capped tenants share one lambda); for a weight-blind (equal) split it
 * is large when weights differ. Tenants fully served (a_i == d_i) are excluded — they are not behind.
 */
export function normalizedSpread(
  alloc: readonly number[],
  weights: readonly number[],
  demands: readonly number[],
): number {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < alloc.length; i++) {
    if ((alloc[i] as number) >= (demands[i] as number)) continue; // not backlogged
    const norm = (alloc[i] as number) / (weights[i] as number);
    if (norm < lo) lo = norm;
    if (norm > hi) hi = norm;
  }
  return hi < lo ? 0 : hi - lo; // 0 when no tenant is backlogged
}

/** Round trips to acquire `alloc` credits at the given lease sizes: sum of ceil(a_i / size_i). */
export function leaseRoundTrips(alloc: readonly number[], sizes: readonly number[]): number {
  let trips = 0;
  for (let i = 0; i < alloc.length; i++) {
    const a = alloc[i] as number;
    if (a > 0) trips += Math.ceil(a / Math.max(1, sizes[i] as number));
  }
  return trips;
}

/** How a contended window's budget is split across tenants. */
export type FairSplit = "static" | "weightBlind" | "wfe";

export interface FairnessMetrics {
  /** Worst-case per-window overshoot above the limit (0 for every window-coupled split). */
  readonly overshoot: number;
  /** Mean per-window utilization, admitted / min(sum demand, limit) in [0, 1]. */
  readonly meanUtil: number;
  /** Fraction of (window, backlogged-tenant) pairs served below their guaranteed share g_i. */
  readonly shareViolationRate: number;
  /** Worst per-window normalized-service spread among backlogged tenants (0 == perfectly fair). */
  readonly worstSpread: number;
  /** Total L2 round trips across the run (0 for the pre-authorized static split). */
  readonly coordination: number;
}

/**
 * Multi-tenant fairness simulator. Each window, the contended budget is split by `split`:
 *   - static      : min(d_i, g_i)            — weight-honoring, NOT work-conserving (strands idle share)
 *   - weightBlind  : unweighted max-min       — work-conserving, ignores weights (GALE P1-2 behaviour)
 *   - wfe          : weighted max-min         — work-conserving AND weight-honoring (Pillar 4)
 * All three are window-coupled, so all keep overshoot 0; they differ on utilization and fairness.
 */
export function evaluateFairness(
  traces: readonly (readonly number[])[],
  weights: readonly number[],
  limit: number,
  split: FairSplit,
  sizes?: readonly number[],
): FairnessMetrics {
  const n = traces.length;
  const windows = traces[0]?.length ?? 0;
  const ones = weights.map(() => 1);
  const g = guaranteedShare(weights, limit);
  const leaseSizes = sizes ?? weights.map(() => 1);

  let overshoot = 0;
  let utilSum = 0;
  let violations = 0;
  let backloggedPairs = 0;
  let worstSpread = 0;
  let coordination = 0;

  for (let w = 0; w < windows; w++) {
    const demands = traces.map((t) => t[w] ?? 0);
    const alloc =
      split === "static"
        ? staticShareAlloc(demands, weights, limit)
        : waterfillInt(demands, split === "wfe" ? weights : ones, limit);

    const admitted = sum(alloc);
    const demand = sum(demands);
    overshoot = Math.max(overshoot, Math.max(0, admitted - limit));
    const serveable = Math.min(demand, limit);
    utilSum += serveable > 0 ? admitted / serveable : 1;
    worstSpread = Math.max(worstSpread, normalizedSpread(alloc, weights, demands));
    if (split !== "static") coordination += leaseRoundTrips(alloc, leaseSizes);

    for (let i = 0; i < n; i++) {
      if ((demands[i] as number) <= 0) continue; // not backlogged this window
      backloggedPairs++;
      if ((alloc[i] as number) < Math.min(demands[i] as number, g[i] as number)) violations++;
    }
  }

  return {
    overshoot,
    meanUtil: utilSum / Math.max(1, windows),
    shareViolationRate: backloggedPairs > 0 ? violations / backloggedPairs : 0,
    worstSpread,
    coordination,
  };
}
