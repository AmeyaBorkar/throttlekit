import { describe, expect, it } from "vitest";
import { makeAdversarial, makeDrift, makeStationary } from "./demand";
import {
  bestFixedCost,
  createEwmaSizer,
  createLeaseSizer,
  eoqOptimum,
  simulate,
  windowCost,
} from "./lease-sizer";
import { simulateWindowCoupled } from "./window-coupled-sim";

/**
 * GALE Pillar 2 — adaptive lease sizing as online EOQ. Empirical validation of the design in
 * research/gale/PILLAR2-lease-sizing.md. All traces are seeded (deterministic), so every threshold
 * below is reproducible; the numbers were calibrated with research/gale/explore-regret.ts.
 *
 * Fixed cost model throughout: orderCost c = 20, strandPenalty h = 1 (so EOQ b* = sqrt(40·D)).
 */
const C = 20;
const H = 1;
const MAX = 1000;
const CANDIDATES = Array.from({ length: 200 }, (_u, i) => i + 1); // fixed sizes 1..200 for hindsight

describe("GALE Pillar 2 — cost model", () => {
  it("eoqOptimum is sqrt(2·c·D/h)", () => {
    expect(eoqOptimum(20, 1, 100)).toBeCloseTo(Math.sqrt(4000), 6);
    expect(eoqOptimum(20, 1, 0)).toBe(0);
  });

  it("windowCost charges leases + stranded credits", () => {
    expect(windowCost(50, 100, C, H)).toBe(2 * 20 + 0); // 2 exact leases, nothing stranded
    expect(windowCost(50, 120, C, H)).toBe(3 * 20 + (150 - 120) * 1); // 3 leases, 30 stranded
    expect(windowCost(50, 0, C, H)).toBe(0); // no demand, no cost
    expect(windowCost(1, 100, C, H)).toBe(100 * 20); // size 1: a lease per request, no stranding
  });
});

describe("GALE Pillar 2 — online regret", () => {
  it("static regret is sublinear on stationary demand (avg regret → 0)", () => {
    const avg: number[] = [];
    for (const t of [100, 400, 1600, 6400]) {
      const trace = makeStationary(t, 100, 0.3, 7);
      const { cost } = simulate(
        trace,
        createLeaseSizer({ orderCost: C, strandPenalty: H, maxSize: MAX }),
        C,
        H,
      );
      const best = bestFixedCost(trace, C, H, CANDIDATES);
      const regret = cost - best.cost;
      // Best-fixed is genuinely strong on stationary demand, so the online learner pays positive regret.
      expect(regret).toBeGreaterThan(0);
      avg.push(regret / t);
    }
    // No-regret signature: average regret per round strictly decreases and approaches 0.
    for (let i = 0; i + 1 < avg.length; i++) {
      expect(avg[i + 1]).toBeLessThan(avg[i] as number);
    }
    expect(avg[avg.length - 1]).toBeLessThan(1.0); // ~0.63 at T=6400
  });

  it("tracks the EOQ optimum under stationary demand", () => {
    const sizer = createLeaseSizer({ orderCost: C, strandPenalty: H, maxSize: MAX });
    simulate(makeStationary(6400, 100, 0.3, 7), sizer, C, H);
    const eoq = eoqOptimum(C, H, 100); // 63.2
    expect(sizer.continuous).toBeGreaterThan(eoq * 0.7);
    expect(sizer.continuous).toBeLessThan(eoq * 1.3);
  });

  it("adapts: matches/beats the best fixed size under non-stationary demand", () => {
    // Smooth drift: online tracking stays within a couple percent of the best fixed size.
    {
      const trace = makeDrift(3000, 100, 70, 4, 0.2, 11);
      const ogd = simulate(
        trace,
        createLeaseSizer({ orderCost: C, strandPenalty: H, maxSize: MAX }),
        C,
        H,
      );
      const best = bestFixedCost(trace, C, H, CANDIDATES);
      expect(ogd.cost).toBeLessThanOrEqual(best.cost * 1.02);
    }
    // Adversarial square wave: adapting strictly beats ANY single fixed size (negative regret).
    {
      const trace = makeAdversarial(3000, 20, 180, 20, 0.1, 13);
      const ogd = simulate(
        trace,
        createLeaseSizer({ orderCost: C, strandPenalty: H, maxSize: MAX }),
        C,
        H,
      );
      const best = bestFixedCost(trace, C, H, CANDIDATES);
      expect(ogd.cost).toBeLessThan(best.cost * 0.95); // ~0.84 measured
    }
  });

  it("is competitive with the EWMA plug-in baseline", () => {
    for (const trace of [
      makeDrift(3000, 100, 70, 4, 0.2, 11),
      makeAdversarial(3000, 20, 180, 20, 0.1, 13),
    ]) {
      const ogd = simulate(
        trace,
        createLeaseSizer({ orderCost: C, strandPenalty: H, maxSize: MAX }),
        C,
        H,
      );
      const ewma = simulate(
        trace,
        createEwmaSizer({
          orderCost: C,
          strandPenalty: H,
          maxSize: MAX,
          alpha: 0.3,
          initialDemand: 100,
        }),
        C,
        H,
      );
      expect(ogd.cost).toBeLessThanOrEqual(ewma.cost * 1.05);
    }
  });
});

describe("GALE Pillar 1 ⊕ Pillar 2 — safety holds for any learned sizes", () => {
  const limit = 100;
  const windows = 500;
  const scenarios: ReadonlyArray<readonly [string, number[][]]> = [
    // Balanced overload: 5 nodes each ~30 (total ~150) vs limit 100.
    [
      "balanced overload",
      [30, 30, 30, 30, 30].map((m, i) => makeStationary(windows, m, 0.3, 100 + i)),
    ],
    // Skewed: one hot node (~80) + 4 cold (~5).
    [
      "skewed (1 hot, 4 cold)",
      [80, 5, 5, 5, 5].map((m, i) => makeStationary(windows, m, 0.3, 200 + i)),
    ],
    // Drifting per-node demand.
    ["drifting nodes", [0, 1, 2, 3, 4].map((i) => makeDrift(windows, 30, 20, 3, 0.3, 300 + i))],
  ];

  it.each(scenarios)(
    "admitted never exceeds the limit, and stays work-conserving: %s",
    (_label, nodeTraces) => {
      const sizers = nodeTraces.map(() =>
        createLeaseSizer({ orderCost: C, strandPenalty: H, maxSize: MAX }),
      );
      const results = simulateWindowCoupled(nodeTraces, sizers, limit);

      let utilSum = 0;
      for (const r of results) {
        // Hard safety invariant: global admissions per window never exceed the cap, for ANY sizes.
        expect(r.admitted).toBeLessThanOrEqual(limit);
        const cap = Math.min(r.demand, limit);
        utilSum += cap > 0 ? r.admitted / cap : 1;
      }
      // Work-conserving: it actually serves most of the available budget (measured 0.80–0.89).
      expect(utilSum / results.length).toBeGreaterThan(0.7);
    },
  );
});

describe("GALE Pillar 2 — input validation", () => {
  it("rejects non-positive cost parameters and bad size bounds", () => {
    expect(() => createLeaseSizer({ orderCost: 0, strandPenalty: 1 })).toThrow(RangeError);
    expect(() => createLeaseSizer({ orderCost: 1, strandPenalty: -1 })).toThrow(RangeError);
    expect(() => createLeaseSizer({ orderCost: 1, strandPenalty: 1, minSize: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      createLeaseSizer({ orderCost: 1, strandPenalty: 1, minSize: 10, maxSize: 5 }),
    ).toThrow(RangeError);
    expect(() => createEwmaSizer({ orderCost: 1, strandPenalty: 1, alpha: 0 })).toThrow(RangeError);
    expect(() => createEwmaSizer({ orderCost: 1, strandPenalty: 1, alpha: 1.5 })).toThrow(
      RangeError,
    );
  });
});
