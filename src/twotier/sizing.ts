/**
 * Adaptive lease sizing for two-tier `leased` mode — GALE Pillar 2 ({@link leaseSizer}) and its
 * prediction-augmented sibling Pillar 3 ({@link predictiveLeaseSizer}). Design + guarantees:
 * `research/gale/PILLAR2-lease-sizing.md` and `research/gale/PILLAR3-predictions.md`.
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
 * **Using it with {@link twoTier}.** Set `lease.adaptive` (these {@link LeaseSizerOptions}, or a
 * `() => LeaseSizer` factory) and the limiter drives one of these learners *per key* automatically:
 * each L2 window it feeds the learner the demand that key actually served and leases at the size it
 * reads back, with safety unchanged (Pillar 1 caps admissions for any size). You can also still drive
 * a sizer by hand — call {@link LeaseSizer.observe} each window and reconstruct the limiter with the
 * new `lease.batch` — e.g. to pick a startup batch from a demand estimate, or to use
 * {@link predictiveLeaseSizer} (which needs a per-window demand hint the in-loop wiring can't supply).
 *
 * Pure and deterministic: no clock, no RNG.
 */
import { clamp } from "../core/math";
import { requireAtLeast, requirePositive } from "../core/validate";

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
 *
 * @experimental Excluded from the 1.x SemVer guarantee (may change in a minor). See STABILITY.md.
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

  let x = Math.log(clamp(options.initialSize ?? minSize, minSize, maxSize));
  let sumSq = 0;

  return {
    size(): number {
      return Math.round(clamp(Math.exp(x), minSize, maxSize));
    },
    observe(demand: number): void {
      const b = Math.exp(x);
      // dg/dx for g(x) = c·D·e^{-x} + (h/2)·e^{x}, evaluated at b = e^x.
      const grad = -(c * demand) / b + (h / 2) * b;
      sumSq += grad * grad;
      const step = stepScale / Math.sqrt(epsilon + sumSq);
      x = clamp(x - step * grad, lnMin, lnMax);
    },
    get continuous(): number {
      return Math.exp(x);
    },
  };
}

/**
 * Amortised per-window cost of lease size `size` under `demand`:
 * `orderCost·demand/size + strandPenalty·size/2` — the expected coordination (`≈ demand/size` leases,
 * each a round trip) plus the expected stranding (average idle leased inventory `≈ size/2`). The
 * classic EOQ cost, minimised at the {@link eoqOptimum} size.
 */
function windowCost(
  size: number,
  demand: number,
  orderCost: number,
  strandPenalty: number,
): number {
  if (demand <= 0) return 0;
  return (orderCost * demand) / size + (strandPenalty * size) / 2;
}

/** Options for {@link predictiveLeaseSizer}. */
export interface PredictiveLeaseSizerOptions extends LeaseSizerOptions {
  /** Hedge learning rate `η` (expert weights ∝ `exp(−η · cumulative expert loss)`). Default `0.01`. */
  learningRate?: number;
}

/** A predictions-with-safety lease sizer: blend a per-window demand hint against the robust learner. */
export interface PredictiveLeaseSizer {
  /** Commit a lease size for the upcoming window, given its predicted demand. */
  size(predictedDemand: number): number;
  /** Learn from the realised demand: update both experts' weights and the robust learner. */
  observe(demand: number): void;
  /** Current expert weights `[followPrediction, robust]` (sum to 1), for introspection. */
  readonly weights: readonly [number, number];
}

/**
 * **Learning-augmented lease sizer** (GALE Pillar 3) — like {@link leaseSizer}, but able to exploit a
 * per-window *demand prediction* when one is available, without trusting it.
 *
 * Two experts each window: "follow the prediction" plays the {@link eoqOptimum} size for the predicted
 * demand; "robust" is the {@link leaseSizer} AdaGrad learner. A **Hedge** meta-learner sets convex
 * weights from each expert's realised window cost and plays the weighted-average size. Convexity +
 * Jensen give `cost(blend) ≤ weighted-average expert cost`, and Hedge drives weight onto the better
 * expert:
 *
 * - **accurate predictions ⇒ weight → follow ⇒ cost → the offline optimum** (consistency);
 * - **bad predictions ⇒ weight → robust ⇒ cost → the no-regret bound** (robustness).
 *
 * Safety is untouched: the size is a number GALE Pillar 1 gates, so no prediction can breach the cap.
 *
 * @example
 * const sizer = predictiveLeaseSizer({ orderCost: 20, strandPenalty: 1 });
 * const batch = sizer.size(predictedDemandNextWindow); // blends the hint with the robust learner
 * // …serve the window…
 * sizer.observe(realisedDemand);
 *
 * @experimental Excluded from the 1.x SemVer guarantee (may change in a minor). See STABILITY.md.
 */
export function predictiveLeaseSizer(options: PredictiveLeaseSizerOptions): PredictiveLeaseSizer {
  const c = options.orderCost;
  const h = options.strandPenalty;
  requirePositive("predictiveLeaseSizer.orderCost", c);
  requirePositive("predictiveLeaseSizer.strandPenalty", h);
  const minSize = options.minSize ?? 1;
  const maxSize = options.maxSize ?? 1_000_000;
  const eta = options.learningRate ?? 0.01;
  requirePositive("predictiveLeaseSizer.learningRate", eta);

  const robust = leaseSizer(options); // validates the size bounds (and re-validates c, h)
  let cumFollow = 0;
  let cumRobust = 0;
  let lastFollow = minSize;
  let lastRobust = minSize;

  const clampSize = (b: number): number => Math.round(clamp(b, minSize, maxSize));

  /** Hedge weights via a numerically-stable softmax of the negated, η-scaled cumulative losses. */
  function weights(): [number, number] {
    const m = Math.min(cumFollow, cumRobust);
    const ef = Math.exp(-eta * (cumFollow - m));
    const er = Math.exp(-eta * (cumRobust - m));
    const z = ef + er;
    return [ef / z, er / z];
  }

  return {
    size(predictedDemand: number): number {
      lastFollow = clampSize(predictedDemand > 0 ? eoqOptimum(c, h, predictedDemand) : minSize);
      lastRobust = robust.size();
      const [wf, wr] = weights();
      return clampSize(wf * lastFollow + wr * lastRobust);
    },
    observe(demand: number): void {
      // Score each expert on its own counterfactual window cost for this window (full information).
      cumFollow += windowCost(lastFollow, demand, c, h);
      cumRobust += windowCost(lastRobust, demand, c, h);
      robust.observe(demand);
    },
    get weights(): [number, number] {
      return weights();
    },
  };
}
