import { describe, expect, it } from "vitest";
import { criticalFractile, learnedReservation } from "../../src/admission";
import { createOnlineReservation, quantile } from "../cost/learned-reservation";
import { heavyTailLengths } from "../cost/token-budget";

/**
 * Tests for the shipped `learnedReservation` (TALE Layer 2). The first block is the load-bearing one:
 * it proves the productized primitive in `src/admission` plays **byte-identically** to the proven,
 * separately-tested research kernel in `test/cost/learned-reservation.ts` (design + O(√T) regret proof
 * in research/cost-uncertainty/REGRET-ANALYSIS.md). That equivalence is what lets the shipped code
 * inherit the kernel's guarantees, and it is a permanent drift guard — any future divergence between
 * the two implementations turns this suite red.
 */

describe("learnedReservation — equivalence to the proven TALE-L2 kernel", () => {
  const optionSets = [
    { holdCost: 1, overrunCost: 4, maxReservation: 512 },
    { holdCost: 3, overrunCost: 1, maxReservation: 256, minReservation: 8 },
    { holdCost: 2, overrunCost: 2, maxReservation: 1024, initialReservation: 100 },
    { holdCost: 1, overrunCost: 9, maxReservation: 200, minReservation: 5, initialReservation: 50 },
  ];

  it("plays byte-identically to research createOnlineReservation across option sets and seeds", () => {
    for (const opts of optionSets) {
      for (const seed of [7, 21, 99, 123, 2024]) {
        const shipped = learnedReservation(opts);
        const research = createOnlineReservation(opts);
        for (const c of heavyTailLengths(2000, 120, opts.maxReservation, seed)) {
          // Same reservation committed, same continuous internal state — before every observation.
          expect(shipped.reserve()).toBe(research.reserve());
          expect(shipped.continuous).toBe(research.continuous);
          shipped.observe(c);
          research.observe(c);
        }
        expect(shipped.continuous).toBe(research.continuous);
      }
    }
  });
});

describe("learnedReservation — descends onto the critical-fractile quantile", () => {
  it("converges near the oracle τ-quantile on a stationary heavy-tail cost stream", () => {
    const h = 1;
    const p = 4;
    const M = 512;
    const tau = criticalFractile(h, p); // 0.8 — reserve the 80th percentile (an abort is 4× a stranded token)
    const trace = heavyTailLengths(6400, 120, M, 7);
    const policy = learnedReservation({ holdCost: h, overrunCost: p, maxReservation: M });
    for (const c of trace) policy.observe(c);
    const oracleQ = quantile(trace, tau); // the best fixed reservation in hindsight
    expect(policy.continuous).toBeGreaterThan(oracleQ * 0.8);
    expect(policy.continuous).toBeLessThan(oracleQ * 1.3);
  });

  it("adapts to a distribution shift (the steady reservation tracks the new regime)", () => {
    const h = 1;
    const p = 4;
    const M = 512;
    const policy = learnedReservation({ holdCost: h, overrunCost: p, maxReservation: M });
    // Output-length regime change: median 80 → 300. The learned reservation should rise to follow it.
    for (const c of heavyTailLengths(3000, 80, M, 21)) policy.observe(c);
    const lowRegime = policy.continuous;
    for (const c of heavyTailLengths(3000, 300, M, 22)) policy.observe(c);
    const highRegime = policy.continuous;
    expect(highRegime).toBeGreaterThan(lowRegime);
  });
});

describe("learnedReservation — output contract", () => {
  it("reserve() is always an integer within [minReservation, maxReservation]", () => {
    const policy = learnedReservation({
      holdCost: 1,
      overrunCost: 9,
      maxReservation: 100,
      minReservation: 10,
    });
    for (const c of heavyTailLengths(500, 50, 100, 5)) {
      const r = policy.reserve();
      expect(Number.isInteger(r)).toBe(true);
      expect(r).toBeGreaterThanOrEqual(10);
      expect(r).toBeLessThanOrEqual(100);
      policy.observe(c);
    }
  });
});

describe("criticalFractile", () => {
  it("is p/(h+p)", () => {
    expect(criticalFractile(1, 4)).toBe(0.8);
    expect(criticalFractile(1, 1)).toBe(0.5); // symmetric ⇒ the median
    expect(criticalFractile(3, 1)).toBe(0.25);
  });

  it("rejects non-positive costs", () => {
    expect(() => criticalFractile(0, 1)).toThrow(RangeError);
    expect(() => criticalFractile(1, -1)).toThrow(RangeError);
  });
});

describe("learnedReservation — input validation", () => {
  it("rejects non-positive cost parameters and bad reservation bounds", () => {
    expect(() => learnedReservation({ holdCost: 0, overrunCost: 1, maxReservation: 10 })).toThrow(
      RangeError,
    );
    expect(() => learnedReservation({ holdCost: 1, overrunCost: 0, maxReservation: 10 })).toThrow(
      RangeError,
    );
    expect(() => learnedReservation({ holdCost: 1, overrunCost: 1, maxReservation: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      learnedReservation({ holdCost: 1, overrunCost: 1, maxReservation: 10, minReservation: 20 }),
    ).toThrow(RangeError);
    expect(() =>
      learnedReservation({ holdCost: 1, overrunCost: 1, maxReservation: 10, minReservation: -1 }),
    ).toThrow(RangeError);
    expect(() =>
      learnedReservation({ holdCost: 1, overrunCost: 1, maxReservation: 10, stepScale: -1 }),
    ).toThrow(RangeError);
  });
});
