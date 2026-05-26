import { describe, expect, it } from "vitest";
import { makeDrift, predictConstant, predictNoisy, predictPerfect } from "./demand";
import { clairvoyantCost, createLeaseSizer, eoqOptimum, simulate, windowCost } from "./lease-sizer";
import { createPredictiveSizer, simulatePredictive } from "./predictive-sizer";
import { simulateWindowCoupledPredictive } from "./window-coupled-sim";

/**
 * GALE Pillar 3 — learning-augmented lease sizing. Validates the consistency/robustness/safety
 * triad of the Hedge-over-{follow-prediction, robust-OGD} design (research/gale/PILLAR3-predictions.md).
 * All traces/predictions are seeded; thresholds calibrated with research/gale/explore-all.ts.
 */
const C = 20;
const H = 1;
const MAX = 1000;
const ETA = 0.01;
const CANDIDATES = Array.from({ length: 200 }, (_u, i) => i + 1);

const trace = makeDrift(3000, 100, 70, 4, 0.2, 11);
const clair = clairvoyantCost(trace, C, H, CANDIDATES);
const robustOnly = simulate(
  trace,
  createLeaseSizer({ orderCost: C, strandPenalty: H, maxSize: MAX }),
  C,
  H,
).cost;
const mk = () =>
  createPredictiveSizer({ orderCost: C, strandPenalty: H, maxSize: MAX, learningRate: ETA });

/** Cost of blindly following a (possibly bad) oracle: play the EOQ size for each prediction. */
function pureFollowCost(predictions: readonly number[]): number {
  let cost = 0;
  for (let t = 0; t < trace.length; t++) {
    const d = predictions[t] ?? 0;
    const b = Math.round(Math.max(1, Math.min(MAX, d > 0 ? eoqOptimum(C, H, d) : 1)));
    cost += windowCost(b, trace[t] ?? 0, C, H);
  }
  return cost;
}

describe("GALE Pillar 3 — learning-augmented leasing", () => {
  it("CONSISTENCY: with accurate predictions, cost approaches the offline optimum", () => {
    const perfect = simulatePredictive(trace, predictPerfect(trace), mk(), C, H);
    const noisy = simulatePredictive(trace, predictNoisy(trace, 0.1, 21), mk(), C, H);
    // Perfect advice recovers the clairvoyant per-window optimum; a little noise barely dents it.
    expect(perfect.cost).toBeLessThanOrEqual(clair * 1.02); // measured ~1.000
    expect(noisy.cost).toBeLessThanOrEqual(clair * 1.05); // measured ~1.001
  });

  it("ROBUSTNESS: with adversarial predictions, cost stays near the no-regret learner", () => {
    const adversarial = predictConstant(trace, 5); // a useless oracle that ignores reality
    const combined = simulatePredictive(trace, adversarial, mk(), C, H).cost;
    // Falls back to the robust learner instead of blowing up like blindly following the oracle.
    expect(combined).toBeLessThanOrEqual(robustOnly * 1.05); // measured ~1.000
    expect(combined).toBeLessThan(pureFollowCost(adversarial) * 0.7); // far better than obeying it
  });

  it("the Hedge weight concentrates on the expert that is actually right", () => {
    const good = mk();
    simulatePredictive(trace, predictPerfect(trace), good, C, H);
    expect(good.weights[0]).toBeGreaterThan(0.8); // follow-prediction wins under good advice

    const bad = mk();
    simulatePredictive(trace, predictConstant(trace, 5), bad, C, H);
    expect(bad.weights[1]).toBeGreaterThan(0.8); // robust wins under bad advice
  });

  it("SAFETY is unconditional: adversarial predictions never breach the cap", () => {
    const limit = 100;
    const windows = 400;
    const nodeTraces = [30, 30, 30, 30, 30].map((m, i) =>
      makeDrift(windows, m, 20, 3, 0.3, 400 + i),
    );
    // Every node fed a deliberately wrong constant prediction.
    const nodePreds = nodeTraces.map(() => predictConstant(nodeTraces[0] as number[], 5));
    const sizers = nodeTraces.map(() => mk());
    const results = simulateWindowCoupledPredictive(nodeTraces, nodePreds, sizers, limit);
    for (const r of results) expect(r.admitted).toBeLessThanOrEqual(limit);
  });

  it("rejects a non-positive learning rate", () => {
    expect(() =>
      createPredictiveSizer({ orderCost: 1, strandPenalty: 1, learningRate: 0 }),
    ).toThrow(RangeError);
  });
});
