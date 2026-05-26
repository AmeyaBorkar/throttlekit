/**
 * Cost-uncertainty kernel (TALE Layer 3) — learning-augmented reservation with output-length
 * predictions (consistency + robustness + unconditional safety). Design: research/cost-uncertainty/
 * PROPOSAL.md (§ Layer 3). The cost-axis sibling of GALE Pillar 3 (test/gale/predictive-sizer.ts).
 *
 * Per-request output-length *predictions* exist and work: predicting the exact length is infeasible,
 * but the relative *rank* is predictable (Fu et al., "Efficient LLM Scheduling by Learning to Rank",
 * NeurIPS'24). We feed the predicted length `ĉ` as one reservation expert against the Layer-2 robust
 * quantile learner, and let a Hedge meta-learner pick convex weights from each expert's realised
 * pinball loss; we play the weighted-average reservation. Because the pinball loss is convex, Jensen
 * gives loss(blend) ≤ weighted-average expert loss, and Hedge drives weight onto the better expert:
 *   - good predictions  ⇒ weight → follow ⇒ cost → the clairvoyant optimum   (CONSISTENCY)
 *   - bad  predictions  ⇒ weight → robust ⇒ cost → the no-regret quantile     (ROBUSTNESS)
 * Safety is untouched: the reservation is just a number the Layer-1 streaming meter overrides, so no
 * prediction — however adversarial — can breach the budget (the *first* predictions-with-safety
 * result for token budgets).
 *
 * Pure and deterministic (seeded PRNG, no clock/Math.random).
 */
import {
  type OnlineReservationOptions,
  type ReservationPolicy,
  createOnlineReservation,
  reservationCost,
} from "./learned-reservation";

const clampNum = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// ---- Seeded predictors (the rank-based output-length predictor and its corners) ------------------

/** mulberry32 PRNG — fast, deterministic uniform in [0,1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Approximate standard normal via the central-limit sum of 12 uniforms. */
function gaussian(rng: () => number): number {
  let s = 0;
  for (let i = 0; i < 12; i++) s += rng();
  return s - 6;
}

/** Ascending rank of each element (rank[i] = position of trace[i] in sorted order, ties by index). */
function ranks(trace: readonly number[]): number[] {
  const order = [...trace.keys()].sort(
    (a, b) => (trace[a] as number) - (trace[b] as number) || a - b,
  );
  const rank = new Array<number>(trace.length);
  order.forEach((orig, r) => {
    rank[orig] = r;
  });
  return rank;
}

/** A perfect (clairvoyant) prediction: the realised cost itself. */
export function predictPerfect(trace: readonly number[]): number[] {
  return trace.slice();
}

/**
 * A *rank-based* predictor (the realistic LLM case): the predictor recovers the relative order of
 * output lengths with some error, then maps ranks back to magnitudes through the (calibrated) length
 * distribution. `rankNoise = 0` is a perfect ranker; larger values progressively scramble the order
 * (Kendall-τ → 0) while keeping the predicted *multiset* of lengths equal to the true one — exactly
 * what a learning-to-rank predictor degrades to. Deterministic given `seed`.
 */
export function predictByRank(trace: readonly number[], rankNoise: number, seed: number): number[] {
  const n = trace.length;
  if (n === 0) return [];
  const rng = mulberry32(seed);
  const trueRank = ranks(trace);
  // Perturb each item's rank key by noise ∝ n, then read off the predicted order.
  const score = trace.map((_u, i) => (trueRank[i] as number) + rankNoise * n * gaussian(rng));
  const predRank = ranks(score);
  const sortedCosts = [...trace].sort((a, b) => a - b);
  // Assign each item the calibrated magnitude at its *predicted* rank position.
  return trace.map((_u, i) => sortedCosts[predRank[i] as number] as number);
}

/**
 * The strongest adversary: assign every item the magnitude of its *opposite* rank (the longest output
 * gets the shortest prediction and vice versa). Following it systematically under-reserves the costly
 * requests — the worst possible advice for budget overrun. Calibrated marginal, anti-correlated order.
 */
export function predictAdversarial(trace: readonly number[]): number[] {
  const n = trace.length;
  if (n === 0) return [];
  const trueRank = ranks(trace);
  const sortedCosts = [...trace].sort((a, b) => a - b);
  return trace.map((_u, i) => sortedCosts[n - 1 - (trueRank[i] as number)] as number);
}

// ---- The Hedge-over-{follow-prediction, robust-quantile} predictive reservation ------------------

export interface PredictiveReservation {
  /** Commit a reservation for the next request, given its predicted output length. */
  reserve(prediction: number): number;
  /** Learn from the realised cost: update both experts' weights and the robust learner. */
  observe(cost: number): void;
  /** Current expert weights `[followPrediction, robust]` (sum to 1), for introspection/tests. */
  readonly weights: readonly [number, number];
}

export interface PredictiveReservationOptions extends OnlineReservationOptions {
  /** Hedge learning rate η (weights ∝ exp(−η · cumulative expert loss)). Default 0.01. */
  readonly learningRate?: number;
}

export function createPredictiveReservation(
  options: PredictiveReservationOptions,
): PredictiveReservation {
  const h = options.holdCost;
  const p = options.overrunCost;
  const minR = options.minReservation ?? 0;
  const maxR = options.maxReservation;
  const eta = options.learningRate ?? 0.01;
  if (!Number.isFinite(eta) || eta <= 0)
    throw new RangeError(`learningRate must be > 0, got ${eta}`);

  const robust = createOnlineReservation(options); // validates h, p, bounds
  let cumFollow = 0;
  let cumRobust = 0;
  let lastFollow = minR;
  let lastRobust = minR;

  /** Hedge weights via a numerically-stable softmax of the negated, η-scaled cumulative losses. */
  function weights(): [number, number] {
    const m = Math.min(cumFollow, cumRobust);
    const ef = Math.exp(-eta * (cumFollow - m));
    const er = Math.exp(-eta * (cumRobust - m));
    const z = ef + er;
    return [ef / z, er / z];
  }

  return {
    reserve(prediction: number): number {
      lastFollow = clampNum(prediction, minR, maxR);
      lastRobust = robust.reserve();
      const [wf, wr] = weights();
      return Math.round(clampNum(wf * lastFollow + wr * lastRobust, minR, maxR));
    },
    observe(cost: number): void {
      // Score each expert on its own counterfactual pinball loss for this request (full information).
      cumFollow += reservationCost(lastFollow, cost, h, p);
      cumRobust += reservationCost(lastRobust, cost, h, p);
      robust.observe(cost);
    },
    get weights(): [number, number] {
      return weights();
    },
  };
}

/** Run a predictive reservation over a (cost, prediction) trace; return total pinball cost + plays. */
export function simulatePredictiveReservation(
  trace: readonly number[],
  predictions: readonly number[],
  predictive: PredictiveReservation,
  holdCost: number,
  overrunCost: number,
): { cost: number; reservations: number[] } {
  let cost = 0;
  const reservations: number[] = [];
  for (let t = 0; t < trace.length; t++) {
    const r = predictive.reserve(predictions[t] ?? 0);
    reservations.push(r);
    cost += reservationCost(r, trace[t] ?? 0, holdCost, overrunCost);
    predictive.observe(trace[t] ?? 0);
  }
  return { cost, reservations };
}

/** Wrap a predictive reservation as an admission policy (feeds per-request predictions through). */
export function predictiveReservationPolicy(predictive: PredictiveReservation): ReservationPolicy {
  return {
    reserve: (_trueCost, prediction) => predictive.reserve(prediction),
    settle: (trueCost) => predictive.observe(trueCost),
  };
}
