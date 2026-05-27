import { describe, expect, it } from "vitest";
import { eoqOptimum, leaseSizer } from "../../src/twotier";
import { makeAdversarial, makeDrift, makeStationary } from "../gale/demand";
import { createLeaseSizer } from "../gale/lease-sizer";

/**
 * Tests for the shipped `leaseSizer` (GALE Pillar 2 — adaptive lease sizing as online EOQ). The first
 * block proves the productized primitive in `src/twotier/sizing.ts` plays byte-identically to the
 * proven research kernel (`test/gale/lease-sizer.ts`; design + O(√T) regret in
 * research/gale/PILLAR2-lease-sizing.md) — an equivalence proof and a permanent drift guard. The rest
 * re-assert the EOQ-tracking guarantee, output contract, and validation on the shipped code.
 *
 * Cost model throughout: orderCost c = 20, strandPenalty h = 1 (so EOQ b* = √(40·D)).
 */
const C = 20;
const H = 1;
const MAX = 1000;

describe("leaseSizer — equivalence to the proven GALE-Pillar-2 kernel", () => {
  const optionSets = [
    { orderCost: C, strandPenalty: H, maxSize: MAX },
    { orderCost: 5, strandPenalty: 2, minSize: 4, maxSize: 500 },
    { orderCost: 50, strandPenalty: 1, maxSize: 2000, initialSize: 100 },
  ];

  it("plays byte-identically to research createLeaseSizer across option sets and demand traces", () => {
    const traces = [
      makeStationary(2000, 100, 0.3, 7),
      makeDrift(2000, 100, 70, 4, 0.2, 11),
      makeAdversarial(2000, 20, 180, 20, 0.1, 13),
    ];
    for (const opts of optionSets) {
      for (const trace of traces) {
        const shipped = leaseSizer(opts);
        const research = createLeaseSizer(opts);
        for (const d of trace) {
          expect(shipped.size()).toBe(research.size());
          expect(shipped.continuous).toBe(research.continuous);
          shipped.observe(d);
          research.observe(d);
        }
        expect(shipped.continuous).toBe(research.continuous);
      }
    }
  });
});

describe("leaseSizer — tracks the EOQ optimum", () => {
  it("converges near the EOQ size under stationary demand", () => {
    const sizer = leaseSizer({ orderCost: C, strandPenalty: H, maxSize: MAX });
    for (const d of makeStationary(6400, 100, 0.3, 7)) sizer.observe(d);
    const eoq = eoqOptimum(C, H, 100); // ~63.2
    expect(sizer.continuous).toBeGreaterThan(eoq * 0.7);
    expect(sizer.continuous).toBeLessThan(eoq * 1.3);
  });

  it("adapts upward when demand rises (the steady size tracks the new regime)", () => {
    const sizer = leaseSizer({ orderCost: C, strandPenalty: H, maxSize: MAX });
    for (const d of makeStationary(4000, 50, 0.2, 3)) sizer.observe(d);
    const lowDemand = sizer.continuous;
    for (const d of makeStationary(4000, 400, 0.2, 4)) sizer.observe(d);
    const highDemand = sizer.continuous;
    expect(highDemand).toBeGreaterThan(lowDemand); // EOQ grows like √D, so the batch follows demand up
  });
});

describe("leaseSizer — output contract", () => {
  it("size() is always an integer within [minSize, maxSize]", () => {
    const sizer = leaseSizer({ orderCost: C, strandPenalty: H, minSize: 5, maxSize: 200 });
    for (const d of makeStationary(500, 100, 0.3, 5)) {
      const b = sizer.size();
      expect(Number.isInteger(b)).toBe(true);
      expect(b).toBeGreaterThanOrEqual(5);
      expect(b).toBeLessThanOrEqual(200);
      sizer.observe(d);
    }
  });
});

describe("eoqOptimum", () => {
  it("is √(2·c·D/h)", () => {
    expect(eoqOptimum(20, 1, 100)).toBeCloseTo(Math.sqrt(4000), 6);
    expect(eoqOptimum(20, 1, 0)).toBe(0); // no demand ⇒ no order
  });

  it("rejects non-positive cost parameters", () => {
    expect(() => eoqOptimum(0, 1, 100)).toThrow(RangeError);
    expect(() => eoqOptimum(1, 0, 100)).toThrow(RangeError);
  });
});

describe("leaseSizer — input validation", () => {
  it("rejects non-positive cost parameters and bad size bounds", () => {
    expect(() => leaseSizer({ orderCost: 0, strandPenalty: 1 })).toThrow(RangeError);
    expect(() => leaseSizer({ orderCost: 1, strandPenalty: -1 })).toThrow(RangeError);
    expect(() => leaseSizer({ orderCost: 1, strandPenalty: 1, minSize: 0 })).toThrow(RangeError);
    expect(() => leaseSizer({ orderCost: 1, strandPenalty: 1, minSize: 10, maxSize: 5 })).toThrow(
      RangeError,
    );
  });
});
