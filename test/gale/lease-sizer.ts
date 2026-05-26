/**
 * GALE Pillar 2 — adaptive lease-sizing learner and its cost model.
 * Design + guarantees: research/gale/PILLAR2-lease-sizing.md.
 *
 * A node sizes its leases online to minimise the per-window cost
 *   f_D(b) = orderCost * D / b   +   strandPenalty * b / 2
 * (coordination + stranding) whose minimiser is the EOQ b* = sqrt(2*orderCost*D/strandPenalty).
 * Demand D is observed each window (full information), so we run AdaGrad on the convex loss in
 * log-space — scale-free, no learning-rate tuning, O(sqrt T) regret vs the best fixed size.
 *
 * Pure and deterministic: no clock, no RNG. Safety (the global cap) is NOT this module's concern —
 * Pillar 1 enforces it for any sizes; this module only governs coordination/stranding efficiency.
 */

/** A size policy: commit a lease size, then learn from the realised demand. */
export interface LeaseSizer {
  /** Integer lease size to use for the next refill (>= minSize >= 1). */
  size(): number;
  /** Feed the demand the node saw this window; updates the size for subsequent windows. */
  observe(demand: number): void;
  /** The continuous internal size (before rounding/clamping), for introspection/tests. */
  readonly continuous: number;
}

export interface LeaseSizerOptions {
  /** Order cost c: cost charged per lease (one L2 round trip). */
  readonly orderCost: number;
  /** Stranding penalty h: cost per leased-but-unused credit forfeited at the window boundary. */
  readonly strandPenalty: number;
  /** Lower clamp on lease size (>= 1). Default 1. */
  readonly minSize?: number;
  /** Upper clamp on lease size. Default 1e6. */
  readonly maxSize?: number;
  /** Initial lease size. Default minSize. */
  readonly initialSize?: number;
  /** AdaGrad scale η₀ in step η₀/sqrt(ε + Σ g²). Default = log-domain diameter (ln max − ln min). */
  readonly stepScale?: number;
  /** AdaGrad numerical floor ε. Default 1e-8. */
  readonly epsilon?: number;
}

const clampNum = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The Economic Order Quantity optimum b* = sqrt(2 c D / h) — the per-window minimiser of f_D. */
export function eoqOptimum(orderCost: number, strandPenalty: number, demand: number): number {
  return Math.sqrt((2 * orderCost * demand) / strandPenalty);
}

/**
 * Amortised per-window cost of using lease size `size` under demand `demand`:
 *   orderCost · demand / size   +   strandPenalty · size / 2
 * the expected coordination (≈ demand/size leases, each a round trip) plus the expected holding /
 * stranding opportunity cost (average idle leased inventory ≈ size/2 — capacity checked out of L2
 * that other nodes cannot use). This is the classic EOQ cost, minimised at b* = sqrt(2·c·D/h); it
 * captures mid-window hoarding, not merely end-of-window forfeiture, so it is the faithful objective
 * the learner both minimises and is measured against (no model/metric mismatch).
 */
export function windowCost(
  size: number,
  demand: number,
  orderCost: number,
  strandPenalty: number,
): number {
  if (demand <= 0) return 0;
  return (orderCost * demand) / size + (strandPenalty * size) / 2;
}

/** The AdaGrad-in-log-space online lease sizer (the GALE policy). */
export function createLeaseSizer(options: LeaseSizerOptions): LeaseSizer {
  const c = options.orderCost;
  const h = options.strandPenalty;
  if (!Number.isFinite(c) || c <= 0) throw new RangeError(`orderCost must be > 0, got ${c}`);
  if (!Number.isFinite(h) || h <= 0) throw new RangeError(`strandPenalty must be > 0, got ${h}`);
  const minSize = options.minSize ?? 1;
  const maxSize = options.maxSize ?? 1_000_000;
  if (minSize < 1) throw new RangeError(`minSize must be >= 1, got ${minSize}`);
  if (maxSize < minSize) throw new RangeError(`maxSize must be >= minSize, got ${maxSize}`);

  const lnMin = Math.log(minSize);
  const lnMax = Math.log(maxSize);
  const stepScale = options.stepScale ?? Math.max(lnMax - lnMin, 1e-6);
  const epsilon = options.epsilon ?? 1e-8;

  let x = Math.log(clampNum(options.initialSize ?? minSize, minSize, maxSize));
  let sumSq = 0;

  return {
    size(): number {
      return Math.round(clampNum(Math.exp(x), minSize, maxSize));
    },
    observe(demand: number): void {
      const b = Math.exp(x);
      // dg/dx for g(x) = c*D*e^{-x} + (h/2)*e^{x}, evaluated at b = e^x.
      const grad = -(c * demand) / b + (h / 2) * b;
      sumSq += grad * grad;
      const step = stepScale / Math.sqrt(epsilon + sumSq);
      x = clampNum(x - step * grad, lnMin, lnMax);
    },
    get continuous(): number {
      return Math.exp(x);
    },
  };
}

/**
 * The EWMA plug-in baseline (what AdapTBF-style schemes effectively do): estimate demand with an
 * exponential moving average and play the EOQ size for that estimate. No regret guarantee.
 */
export function createEwmaSizer(
  options: LeaseSizerOptions & { readonly alpha: number; readonly initialDemand?: number },
): LeaseSizer {
  const c = options.orderCost;
  const h = options.strandPenalty;
  const minSize = options.minSize ?? 1;
  const maxSize = options.maxSize ?? 1_000_000;
  const alpha = options.alpha;
  if (!(alpha > 0 && alpha <= 1)) throw new RangeError(`alpha must be in (0,1], got ${alpha}`);
  let dHat = options.initialDemand ?? 0;
  return {
    size(): number {
      const b = dHat > 0 ? eoqOptimum(c, h, dHat) : minSize;
      return Math.round(clampNum(b, minSize, maxSize));
    },
    observe(demand: number): void {
      dHat = alpha * demand + (1 - alpha) * dHat;
    },
    get continuous(): number {
      return dHat > 0 ? eoqOptimum(c, h, dHat) : minSize;
    },
  };
}

/** Run a sizer over a demand trace; return total realised (integer) cost and the sizes it played. */
export function simulate(
  trace: readonly number[],
  sizer: LeaseSizer,
  orderCost: number,
  strandPenalty: number,
): { cost: number; sizes: number[] } {
  let cost = 0;
  const sizes: number[] = [];
  for (const demand of trace) {
    const b = sizer.size(); // committed before observing this window's demand
    sizes.push(b);
    cost += windowCost(b, demand, orderCost, strandPenalty);
    sizer.observe(demand);
  }
  return { cost, sizes };
}

/** Total cost of the best single fixed lease size in hindsight, searched over `candidateSizes`. */
export function bestFixedCost(
  trace: readonly number[],
  orderCost: number,
  strandPenalty: number,
  candidateSizes: readonly number[],
): { cost: number; size: number } {
  let best = Number.POSITIVE_INFINITY;
  let bestSize = candidateSizes[0] ?? 1;
  for (const b of candidateSizes) {
    let cost = 0;
    for (const demand of trace) cost += windowCost(b, demand, orderCost, strandPenalty);
    if (cost < best) {
      best = cost;
      bestSize = b;
    }
  }
  return { cost: best, size: bestSize };
}

/**
 * The offline (clairvoyant) optimum: for each window, the cost of the size that is best for *that*
 * window's demand — a lower bound no online or fixed policy can beat. Used to measure consistency.
 */
export function clairvoyantCost(
  trace: readonly number[],
  orderCost: number,
  strandPenalty: number,
  candidateSizes: readonly number[],
): number {
  let total = 0;
  for (const demand of trace) {
    if (demand <= 0) continue;
    let best = Number.POSITIVE_INFINITY;
    for (const b of candidateSizes) {
      const cost = windowCost(b, demand, orderCost, strandPenalty);
      if (cost < best) best = cost;
    }
    total += best;
  }
  return total;
}
