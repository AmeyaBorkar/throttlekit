/**
 * GALE Pillar 3 — learning-augmented lease sizing (predictions with consistency + robustness).
 * Design: research/gale/PILLAR3-predictions.md.
 *
 * Two experts each window: "follow the prediction" plays the EOQ size for the predicted demand;
 * "robust" is the Pillar-2 AdaGrad learner. A Hedge meta-learner over the two (exponentiated by each
 * expert's realised window loss) sets convex weights, and we play the weighted-average size. Because
 * the per-window cost is convex, Jensen gives loss(blend) <= weighted-average expert loss, and Hedge
 * drives the weight onto the better expert, so:
 *   - good predictions  ⇒ weight → follow ⇒ cost → offline optimum   (CONSISTENCY)
 *   - bad  predictions  ⇒ weight → robust ⇒ cost → the no-regret bound (ROBUSTNESS)
 * Safety is untouched: the size is a number gated by Pillar 1, so no prediction can breach the cap.
 */
import { type LeaseSizerOptions, createLeaseSizer, eoqOptimum, windowCost } from "./lease-sizer";

export interface PredictiveLeaseSizer {
  /** Commit a lease size for the upcoming window, given its predicted demand. */
  size(predictedDemand: number): number;
  /** Learn from the realised demand: update both experts' weights and the robust learner. */
  observe(demand: number): void;
  /** Current expert weights `[followPrediction, robust]` (sum to 1), for introspection/tests. */
  readonly weights: readonly [number, number];
}

export interface PredictiveLeaseSizerOptions extends LeaseSizerOptions {
  /** Hedge learning rate η (weights ∝ exp(−η · cumulative expert loss)). Default 0.01. */
  readonly learningRate?: number;
}

export function createPredictiveSizer(options: PredictiveLeaseSizerOptions): PredictiveLeaseSizer {
  const c = options.orderCost;
  const h = options.strandPenalty;
  if (!Number.isFinite(c) || c <= 0) throw new RangeError(`orderCost must be > 0, got ${c}`);
  if (!Number.isFinite(h) || h <= 0) throw new RangeError(`strandPenalty must be > 0, got ${h}`);
  const minSize = options.minSize ?? 1;
  const maxSize = options.maxSize ?? 1_000_000;
  const eta = options.learningRate ?? 0.01;
  if (!Number.isFinite(eta) || eta <= 0)
    throw new RangeError(`learningRate must be > 0, got ${eta}`);

  const robust = createLeaseSizer(options);
  let cumFollow = 0;
  let cumRobust = 0;
  let lastFollow = minSize;
  let lastRobust = minSize;

  const clampSize = (b: number): number => Math.round(Math.min(maxSize, Math.max(minSize, b)));

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
      // Score each expert on its own counterfactual loss for this window (full information).
      cumFollow += windowCost(lastFollow, demand, c, h);
      cumRobust += windowCost(lastRobust, demand, c, h);
      robust.observe(demand);
    },
    get weights(): [number, number] {
      return weights();
    },
  };
}

/** Run a predictive sizer over a (demand, prediction) trace; return total cost and sizes played. */
export function simulatePredictive(
  trace: readonly number[],
  predictions: readonly number[],
  sizer: PredictiveLeaseSizer,
  orderCost: number,
  strandPenalty: number,
): { cost: number; sizes: number[] } {
  let cost = 0;
  const sizes: number[] = [];
  for (let t = 0; t < trace.length; t++) {
    const b = sizer.size(predictions[t] ?? 0);
    sizes.push(b);
    cost += windowCost(b, trace[t] ?? 0, orderCost, strandPenalty);
    sizer.observe(trace[t] ?? 0);
  }
  return { cost, sizes };
}
