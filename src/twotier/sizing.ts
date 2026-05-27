/**
 * Adaptive lease sizing for two-tier `leased` mode — GALE Pillar 2. Design + guarantees:
 * `research/gale/PILLAR2-lease-sizing.md`.
 *
 * In {@link twoTier} `leased` mode each node leases a `batch` of credits from L2 per refill. The batch
 * is a trade-off: large batches cut coordination (fewer L2 round trips) but strand more capacity that
 * other nodes can't use; small batches coordinate often but waste little. The right batch depends on a
 * node's *demand*, which drifts. {@link leaseSizer} sizes it online to minimise the classic EOQ cost
 *
 * ```text
 *   f_D(b) = orderCost·D/b   +   strandPenalty·b/2     (coordination + stranding)
 * ```
 *
 * whose per-window minimiser is the Economic Order Quantity `b* = √(2·orderCost·D/strandPenalty)`.
 * Demand `D` is observed each window (full information), so the learner runs **AdaGrad on the convex
 * loss in log-space** — scale-free, no learning-rate tuning, `O(√T)` regret versus the best fixed
 * batch in hindsight.
 *
 * **Safety is not this learner's concern.** GALE Pillar 1 enforces the global cap for *any* batch:
 * with `lease.windowCoupled` the per-window overshoot is exactly `Limit` *independent of the batch*
 * (the batch only sets coordination frequency, not the bound), so adaptive sizing can never loosen the
 * proven guarantee — it only trades coordination against stranding.
 *
 * **Using it with {@link twoTier} today.** This is a standalone, pure learner: keep one per leasing
 * node, and each window feed it the demand you observed ({@link LeaseSizer.observe}) and read back the
 * batch to use next ({@link LeaseSizer.size}) — e.g. reconstruct the limiter with the new
 * `lease.batch`, or use it to choose the batch at startup from a demand estimate. Wiring the sizer
 * *into* the `twoTier` lease loop as live in-flight adaptation is a deliberate follow-up (it changes
 * the async hot path and is best validated by the at-scale cluster eval); the learner itself ships now.
 *
 * Pure and deterministic: no clock, no RNG.
 */
import { requireAtLeast, requirePositive } from "../core/validate";

/** Clamp `v` into the closed interval `[lo, hi]`. */
const clampNum = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** A lease-size policy: commit a size for the next refill, then learn from the realised demand. */
export interface LeaseSizer {
  /** The integer lease size to use for the next refill (`>= minSize >= 1`). */
  size(): number;
  /** Feed the demand the node saw this window; updates the size for subsequent windows. */
  observe(demand: number): void;
  /** The continuous internal size (before rounding/clamping), for introspection. */
  readonly continuous: number;
}

/** Options for {@link leaseSizer}. */
export interface LeaseSizerOptions {
  /** Order cost `c`: cost charged per lease (one L2 round trip). Must be `> 0`. */
  orderCost: number;
  /** Strand penalty `h`: cost per leased-but-unused credit forfeited at the window boundary. Must be `> 0`. */
  strandPenalty: number;
  /** Lower clamp on lease size (`>= 1`). Default `1`. */
  minSize?: number;
  /** Upper clamp on lease size. Default `1e6`. */
  maxSize?: number;
  /** Initial lease size. Default `minSize`. */
  initialSize?: number;
  /** AdaGrad step scale `η₀` in `η₀/√(ε + Σg²)`. Default the log-domain diameter `ln(maxSize) − ln(minSize)`. */
  stepScale?: number;
  /** AdaGrad numerical floor `ε`. Default `1e-8`. */
  epsilon?: number;
}

/**
 * The Economic Order Quantity optimum `b* = √(2·orderCost·demand/strandPenalty)` — the per-window
 * minimiser of the lease-sizing cost, and the size {@link leaseSizer} descends onto under stationary
 * demand.
 */
export function eoqOptimum(orderCost: number, strandPenalty: number, demand: number): number {
  requirePositive("eoqOptimum.orderCost", orderCost);
  requirePositive("eoqOptimum.strandPenalty", strandPenalty);
  requireAtLeast("eoqOptimum.demand", demand, 0);
  return Math.sqrt((2 * orderCost * demand) / strandPenalty);
}

/**
 * **Online adaptive lease sizer** (GALE Pillar 2) — learn the L2 lease `batch` that minimises the
 * coordination-vs-stranding EOQ cost, online, as a node's demand drifts.
 *
 * Each refill it commits the current {@link LeaseSizer.size}; each window you feed it the realised
 * demand via {@link LeaseSizer.observe}, and it takes one **AdaGrad step in log-space** on the convex
 * EOQ loss (log-space because the optimum spans orders of magnitude and the gradient is unbounded and
 * smooth — AdaGrad's adaptivity earns the scale-freedom; contrast the bounded pinball subgradient of
 * `learnedReservation`, where plain OGD is optimal). It attains `O(√T)` regret versus the best fixed
 * batch in hindsight and tracks a drifting optimum.
 *
 * @example
 * const sizer = leaseSizer({ orderCost: 20, strandPenalty: 1 });
 * // per window on a leasing node:
 * const batch = sizer.size();          // use this as twoTier lease.batch
 * // …serve the window, counting how many credits this node actually demanded…
 * sizer.observe(demandThisWindow);     // learn for next window
 */
export function leaseSizer(options: LeaseSizerOptions): LeaseSizer {
  const c = options.orderCost;
  const h = options.strandPenalty;
  requirePositive("leaseSizer.orderCost", c);
  requirePositive("leaseSizer.strandPenalty", h);
  const minSize = options.minSize ?? 1;
  const maxSize = options.maxSize ?? 1_000_000;
  requireAtLeast("leaseSizer.minSize", minSize, 1);
  if (maxSize < minSize) {
    throw new RangeError(`leaseSizer.maxSize must be >= minSize, got ${maxSize} < ${minSize}`);
  }
  if (options.stepScale !== undefined) requirePositive("leaseSizer.stepScale", options.stepScale);
  if (options.epsilon !== undefined) requirePositive("leaseSizer.epsilon", options.epsilon);

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
      // dg/dx for g(x) = c·D·e^{-x} + (h/2)·e^{x}, evaluated at b = e^x.
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
