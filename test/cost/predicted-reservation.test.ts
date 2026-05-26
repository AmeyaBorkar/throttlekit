import { describe, expect, it } from "vitest";
import {
  type ReservationPolicy,
  bestFixedReservationCost,
  createOnlineReservation,
  reservationCost,
  simulateAdmission,
  simulateReservation,
} from "./learned-reservation";
import {
  createPredictiveReservation,
  predictAdversarial,
  predictByRank,
  predictPerfect,
  predictiveReservationPolicy,
  simulatePredictiveReservation,
} from "./predicted-reservation";
import { heavyTailLengths } from "./token-budget";

/**
 * Cost-uncertainty kernel (TALE Layer 3) — predictions-with-safety. Validates the
 * consistency / robustness / safety triad of the Hedge-over-{follow-prediction, robust-quantile}
 * reservation (research/cost-uncertainty/PROPOSAL.md § Layer 3); the cost-axis sibling of GALE
 * Pillar 3. All traces/predictions seeded; thresholds calibrated with
 * research/cost-uncertainty/explore-prediction.ts.
 *
 * Cost model: holdCost h = 1, overrunCost p = 4 (critical fractile τ = 0.8).
 */
const H = 1;
const P = 4;
const M = 512;
const CAND = Array.from({ length: M + 1 }, (_u, i) => i);

const trace = heavyTailLengths(3000, 120, M, 11);
const robustOnly = simulateReservation(
  trace,
  createOnlineReservation({ holdCost: H, overrunCost: P, maxReservation: M }),
  H,
  P,
).cost;
const bestFixed = bestFixedReservationCost(trace, H, P, CAND).cost;
const mk = () => createPredictiveReservation({ holdCost: H, overrunCost: P, maxReservation: M });

/** Cost of blindly following a (possibly adversarial) predictor: reserve exactly the prediction. */
const pureFollowCost = (predictions: readonly number[]): number => {
  let cost = 0;
  for (let t = 0; t < trace.length; t++)
    cost += reservationCost(Math.max(0, Math.min(M, predictions[t] ?? 0)), trace[t] ?? 0, H, P);
  return cost;
};

describe("TALE Layer 3 — learning-augmented reservation", () => {
  it("CONSISTENCY: accurate predictions drive cost to the clairvoyant optimum", () => {
    const perfect = simulatePredictiveReservation(trace, predictPerfect(trace), mk(), H, P);
    const good = simulatePredictiveReservation(trace, predictByRank(trace, 0.1, 21), mk(), H, P);
    // Perfect advice ⇒ essentially the clairvoyant cost (0); a good rank-predictor still cuts it hard.
    expect(perfect.cost).toBeLessThan(robustOnly * 0.01); // measured ~229 vs robust ~725.7k
    expect(good.cost).toBeLessThan(robustOnly * 0.5); // measured ~0.379× — predictions cut cost 62%
  });

  it("ROBUSTNESS: adversarial predictions fall back to the no-regret quantile", () => {
    const adversarial = predictAdversarial(trace); // longest output gets the shortest prediction
    const combined = simulatePredictiveReservation(trace, adversarial, mk(), H, P).cost;
    // Stays at the robust learner's cost instead of blowing up like obeying the bad predictor.
    expect(combined).toBeLessThanOrEqual(robustOnly * 1.02); // measured ~1.000×
    expect(combined).toBeLessThan(pureFollowCost(adversarial) * 0.7); // measured ~0.47× of obeying it
  });

  it("the Hedge weight concentrates on the expert that is actually right", () => {
    const good = mk();
    simulatePredictiveReservation(trace, predictByRank(trace, 0.1, 21), good, H, P);
    expect(good.weights[0]).toBeGreaterThan(0.8); // follow-prediction wins under good advice

    const bad = mk();
    simulatePredictiveReservation(trace, predictAdversarial(trace), bad, H, P);
    expect(bad.weights[1]).toBeGreaterThan(0.8); // robust wins under adversarial advice
  });

  it("rejects a non-positive learning rate", () => {
    expect(() =>
      createPredictiveReservation({
        holdCost: 1,
        overrunCost: 1,
        maxReservation: 10,
        learningRate: 0,
      }),
    ).toThrow(RangeError);
  });
});

describe("TALE Layer 3 — SAFETY is unconditional (no prediction can breach the budget)", () => {
  const opts = { budget: 1000, slots: 16, maxTokens: M, chunk: 1, rounds: 400 } as const;
  const queue = heavyTailLengths(400, 120, M, 7);
  const warmedPredictive = (): ReservationPolicy => {
    const pr = createPredictiveReservation({ holdCost: H, overrunCost: P, maxReservation: M });
    for (const c of heavyTailLengths(3000, 120, M, 99)) pr.observe(c);
    return predictiveReservationPolicy(pr);
  };
  // The strongest adversary: a policy that blindly reserves the (anti-correlated) prediction.
  const followAdversarial: ReservationPolicy = {
    reserve: (_trueCost, prediction) => prediction,
    settle: () => {},
  };

  it("the predictive policy holds overshoot at 0 under good AND adversarial predictions (g=1)", () => {
    const good = simulateAdmission(queue, warmedPredictive(), opts, predictByRank(queue, 0.1, 21));
    const adversarial = simulateAdmission(
      queue,
      warmedPredictive(),
      opts,
      predictAdversarial(queue),
    );
    expect(good.overshoot).toBe(0);
    expect(adversarial.overshoot).toBe(0); // identical safety regardless of prediction quality
  });

  it("even BLINDLY following adversarial predictions cannot breach the budget", () => {
    const r = simulateAdmission(queue, followAdversarial, opts, predictAdversarial(queue));
    // Systematic under-reservation of the costly requests ⇒ maximal over-admission… yet the meter
    // caps production at exactly L: overshoot 0 at g=1. (This is the predictions-with-safety result.)
    expect(r.overshoot).toBe(0);
    expect(r.completed + r.aborts).toBe(r.admitted);
  });

  it("the chunked meter bound composes with admission: overshoot ≤ g−1 even under bad predictions", () => {
    const r = simulateAdmission(
      queue,
      followAdversarial,
      { ...opts, chunk: 8 },
      predictAdversarial(queue),
    );
    expect(r.overshoot).toBeLessThanOrEqual(7); // ≤ g−1, independent of slots and of the predictor
  });
});

// Reference the hindsight optimum so an unused-binding lint can't hide a broken baseline.
it("baseline sanity: best fixed reservation is a sensible fraction of the robust cost", () => {
  expect(bestFixed).toBeGreaterThan(0);
  expect(bestFixed).toBeLessThanOrEqual(robustOnly);
});
