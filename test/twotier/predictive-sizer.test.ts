import { describe, expect, it } from "vitest";
import { leaseSizer, predictiveLeaseSizer } from "../../src/twotier";
import { makeDrift, predictConstant, predictNoisy, predictPerfect } from "../gale/demand";
import { clairvoyantCost, eoqOptimum, windowCost } from "../gale/lease-sizer";
import { createPredictiveSizer } from "../gale/predictive-sizer";

/**
 * Tests for the shipped `predictiveLeaseSizer` (GALE Pillar 3 — predictions with safety). The first
 * block proves the productized primitive plays byte-identically to the proven research kernel
 * (`test/gale/predictive-sizer.ts`; design in research/gale/PILLAR3-predictions.md) — equivalence +
 * drift guard. The rest re-assert the consistency / robustness / weight-concentration triad on the
 * shipped code, using thresholds from the (calibrated) research suite. The eval baselines
 * (clairvoyant / pure-follow / robust-only) are computed with the research harness helpers.
 *
 * Cost model throughout: orderCost c = 20, strandPenalty h = 1, Hedge η = 0.01.
 */
const C = 20;
const H = 1;
const MAX = 1000;
const ETA = 0.01;
const CANDIDATES = Array.from({ length: 200 }, (_u, i) => i + 1);

/** Run a predictive sizer over a (demand, prediction) trace; return total EOQ cost. */
function runPredictive(
  sizer: { size(p: number): number; observe(d: number): void },
  trace: readonly number[],
  preds: readonly number[],
): number {
  let cost = 0;
  for (let t = 0; t < trace.length; t++) {
    cost += windowCost(sizer.size(preds[t] ?? 0), trace[t] ?? 0, C, H);
    sizer.observe(trace[t] ?? 0);
  }
  return cost;
}

/** Total cost of the robust (Pillar-2) learner alone — the no-regret fallback baseline. */
function runRobust(trace: readonly number[]): number {
  const s = leaseSizer({ orderCost: C, strandPenalty: H, maxSize: MAX });
  let cost = 0;
  for (const d of trace) {
    cost += windowCost(s.size(), d, C, H);
    s.observe(d);
  }
  return cost;
}

/** Cost of blindly obeying a (possibly bad) oracle: play the EOQ size for each prediction. */
const pureFollow = (trace: readonly number[], preds: readonly number[]): number => {
  let cost = 0;
  for (let t = 0; t < trace.length; t++) {
    const d = preds[t] ?? 0;
    const b = Math.round(Math.max(1, Math.min(MAX, d > 0 ? eoqOptimum(C, H, d) : 1)));
    cost += windowCost(b, trace[t] ?? 0, C, H);
  }
  return cost;
};

describe("predictiveLeaseSizer — equivalence to the proven GALE-Pillar-3 kernel", () => {
  it("plays byte-identically to research createPredictiveSizer (sizes + Hedge weights)", () => {
    const opts = { orderCost: C, strandPenalty: H, maxSize: MAX, learningRate: ETA };
    for (const seed of [11, 21, 33]) {
      const trace = makeDrift(2000, 100, 70, 4, 0.2, seed);
      const preds = predictNoisy(trace, 0.2, seed + 1);
      const shipped = predictiveLeaseSizer(opts);
      const research = createPredictiveSizer(opts);
      for (let t = 0; t < trace.length; t++) {
        const pd = preds[t] ?? 0;
        expect(shipped.size(pd)).toBe(research.size(pd));
        expect(shipped.weights[0]).toBe(research.weights[0]);
        expect(shipped.weights[1]).toBe(research.weights[1]);
        shipped.observe(trace[t] ?? 0);
        research.observe(trace[t] ?? 0);
      }
    }
  });
});

describe("predictiveLeaseSizer — consistency, robustness, weight concentration", () => {
  // Same calibration trace as the research suite (seed 11), so the research-tuned thresholds transfer.
  const trace = makeDrift(3000, 100, 70, 4, 0.2, 11);
  const clair = clairvoyantCost(trace, C, H, CANDIDATES);
  const robustOnly = runRobust(trace);
  const mk = (): ReturnType<typeof predictiveLeaseSizer> =>
    predictiveLeaseSizer({ orderCost: C, strandPenalty: H, maxSize: MAX, learningRate: ETA });

  it("CONSISTENCY: accurate predictions approach the offline optimum", () => {
    expect(runPredictive(mk(), trace, predictPerfect(trace))).toBeLessThanOrEqual(clair * 1.02);
    expect(runPredictive(mk(), trace, predictNoisy(trace, 0.1, 21))).toBeLessThanOrEqual(
      clair * 1.05,
    );
  });

  it("ROBUSTNESS: adversarial predictions stay near the no-regret learner", () => {
    const adv = predictConstant(trace, 5); // a useless oracle that ignores reality
    const combined = runPredictive(mk(), trace, adv);
    expect(combined).toBeLessThanOrEqual(robustOnly * 1.05); // no worse than the robust learner
    expect(combined).toBeLessThan(pureFollow(trace, adv) * 0.7); // far better than obeying it
  });

  it("the Hedge weight concentrates on the expert that is actually right", () => {
    const good = mk();
    runPredictive(good, trace, predictPerfect(trace));
    expect(good.weights[0]).toBeGreaterThan(0.8); // follow-prediction wins under good advice

    const bad = mk();
    runPredictive(bad, trace, predictConstant(trace, 5));
    expect(bad.weights[1]).toBeGreaterThan(0.8); // robust wins under bad advice
  });
});

describe("predictiveLeaseSizer — input validation", () => {
  it("rejects a non-positive learning rate and inherits the Pillar-2 parameter checks", () => {
    expect(() => predictiveLeaseSizer({ orderCost: 1, strandPenalty: 1, learningRate: 0 })).toThrow(
      RangeError,
    );
    expect(() => predictiveLeaseSizer({ orderCost: 0, strandPenalty: 1 })).toThrow(RangeError);
    expect(() =>
      predictiveLeaseSizer({ orderCost: 1, strandPenalty: 1, minSize: 10, maxSize: 5 }),
    ).toThrow(RangeError);
  });
});
