import { describe, expect, it } from "vitest";
import { learnedReservation, predictiveReservation } from "../../src/admission";
import {
  createPredictiveReservation,
  predictAdversarial,
  predictByRank,
  predictPerfect,
} from "../cost/predicted-reservation";
import { heavyTailLengths } from "../cost/token-budget";

/**
 * Tests for the shipped `predictiveReservation` (TALE Layer 3 — predictions with safety). As with
 * Layer 2, the first block proves the productized primitive in `src/admission` plays byte-identically
 * to the proven research kernel (`test/cost/predicted-reservation.ts`) — equivalence + drift guard.
 * The remaining blocks re-assert the consistency / robustness / weight-concentration triad on the
 * shipped code, with thresholds taken from the (calibrated) research suite.
 *
 * Cost model throughout: holdCost h = 1, overrunCost p = 4 (critical fractile τ = 0.8).
 */
const H = 1;
const P = 4;
const M = 512;

const pinball = (r: number, c: number): number => (r > c ? H * (r - c) : P * (c - r));

function runPredictive(
  policy: { reserve(p: number): number; observe(c: number): void },
  trace: readonly number[],
  preds: readonly number[],
): number {
  let cost = 0;
  for (let i = 0; i < trace.length; i++) {
    cost += pinball(policy.reserve(preds[i] ?? 0), trace[i] ?? 0);
    policy.observe(trace[i] ?? 0);
  }
  return cost;
}

/** Total cost of the robust (Layer-2) learner alone on a trace — the no-regret fallback baseline. */
function runRobust(trace: readonly number[]): number {
  const l = learnedReservation({ holdCost: H, overrunCost: P, maxReservation: M });
  let cost = 0;
  for (const c of trace) {
    cost += pinball(l.reserve(), c);
    l.observe(c);
  }
  return cost;
}

/** Cost of blindly obeying a (possibly adversarial) predictor: reserve exactly the clamped prediction. */
const pureFollow = (trace: readonly number[], preds: readonly number[]): number => {
  let cost = 0;
  for (let i = 0; i < trace.length; i++) {
    cost += pinball(Math.max(0, Math.min(M, preds[i] ?? 0)), trace[i] ?? 0);
  }
  return cost;
};

describe("predictiveReservation — equivalence to the proven TALE-L3 kernel", () => {
  it("plays byte-identically to research createPredictiveReservation (reservations + Hedge weights)", () => {
    const opts = { holdCost: H, overrunCost: P, maxReservation: M };
    for (const seed of [7, 21, 99, 123]) {
      const trace = heavyTailLengths(2000, 120, M, seed);
      const preds = predictByRank(trace, 0.3, seed + 1);
      const shipped = predictiveReservation(opts);
      const research = createPredictiveReservation(opts);
      for (let i = 0; i < trace.length; i++) {
        const pr = preds[i] ?? 0;
        expect(shipped.reserve(pr)).toBe(research.reserve(pr));
        expect(shipped.weights[0]).toBe(research.weights[0]);
        expect(shipped.weights[1]).toBe(research.weights[1]);
        shipped.observe(trace[i] ?? 0);
        research.observe(trace[i] ?? 0);
      }
    }
  });
});

describe("predictiveReservation — consistency, robustness, weight concentration", () => {
  // Same calibration trace as the research suite (seed 11), so the research-tuned thresholds transfer.
  const trace = heavyTailLengths(3000, 120, M, 11);
  const robustOnly = runRobust(trace);
  const mk = (): ReturnType<typeof predictiveReservation> =>
    predictiveReservation({ holdCost: H, overrunCost: P, maxReservation: M });

  it("CONSISTENCY: accurate predictions drive cost toward the clairvoyant optimum", () => {
    const perfect = runPredictive(mk(), trace, predictPerfect(trace));
    const good = runPredictive(mk(), trace, predictByRank(trace, 0.1, 21));
    expect(perfect).toBeLessThan(robustOnly * 0.01); // perfect advice ⇒ ~clairvoyant cost
    expect(good).toBeLessThan(robustOnly * 0.5); // a good rank-predictor still cuts cost hard
  });

  it("ROBUSTNESS: adversarial predictions fall back to the no-regret quantile", () => {
    const adv = predictAdversarial(trace); // longest output gets the shortest prediction
    const combined = runPredictive(mk(), trace, adv);
    expect(combined).toBeLessThanOrEqual(robustOnly * 1.02); // no worse than the robust learner
    expect(combined).toBeLessThan(pureFollow(trace, adv) * 0.7); // far better than obeying the adversary
  });

  it("the Hedge weight concentrates on the expert that is actually right", () => {
    const good = mk();
    runPredictive(good, trace, predictByRank(trace, 0.1, 21));
    expect(good.weights[0]).toBeGreaterThan(0.8); // follow-prediction wins under good advice

    const bad = mk();
    runPredictive(bad, trace, predictAdversarial(trace));
    expect(bad.weights[1]).toBeGreaterThan(0.8); // robust wins under adversarial advice
  });
});

describe("predictiveReservation — input validation", () => {
  it("rejects a non-positive learning rate and inherits the Layer-2 parameter checks", () => {
    expect(() =>
      predictiveReservation({ holdCost: 1, overrunCost: 1, maxReservation: 10, learningRate: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      predictiveReservation({ holdCost: 0, overrunCost: 1, maxReservation: 10 }),
    ).toThrow(RangeError);
    expect(() => predictiveReservation({ holdCost: 1, overrunCost: 1, maxReservation: 0 })).toThrow(
      RangeError,
    );
  });
});
