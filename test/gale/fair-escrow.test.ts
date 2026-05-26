import { describe, expect, it } from "vitest";
import { mulberry32 } from "./demand";
import {
  evaluateFairness,
  guaranteedShare,
  jainFairness,
  normalizedSpread,
  staticShareAlloc,
  waterfill,
  waterfillInt,
} from "./fair-escrow";

/**
 * GALE Pillar 4 — Weighted Fair Escrow. Design + proofs in research/gale/PILLAR4-fairness.md.
 * The split target is weighted max-min fairness (water-filling); these tests machine-check the four
 * theorems on random instances and measure the Workload-C contrast recorded in EVALUATION.md.
 */

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

describe("water-filling — weighted max-min fair allocation", () => {
  it("serves all demand when it fits (work-conserving, no overshoot)", () => {
    expect(waterfillInt([10, 20, 5], [1, 1, 1], 100)).toEqual([10, 20, 5]);
    expect(waterfill([10, 20, 5], [1, 1, 1], 100)).toEqual([10, 20, 5]);
  });

  it("splits a contended budget in proportion to weight", () => {
    // demands all exceed any possible share; weights 4:1:1:1, limit 70 -> 40:10:10:10.
    expect(waterfillInt([100, 100, 100, 100], [4, 1, 1, 1], 70)).toEqual([40, 10, 10, 10]);
  });

  it("reclaims an idle tenant's share for the backlogged ones (work-conserving)", () => {
    // High-weight tenant idle -> its share flows to the flooders, summing to the full limit.
    const a = waterfillInt([0, 100, 100, 100], [4, 1, 1, 1], 70);
    expect(sum(a)).toBe(70);
    expect(a[0]).toBe(0);
    expect(Math.max(...a.slice(1)) - Math.min(...a.slice(1))).toBeLessThanOrEqual(1); // equal ±quantum
  });

  it("gives a partially-demanding tenant exactly its demand, the rest to others", () => {
    // Tenant 0 wants only 5 (< its 40 share); surplus reclaimed by the flooders.
    const a = waterfillInt([5, 100, 100, 100], [4, 1, 1, 1], 70);
    expect(a[0]).toBe(5);
    expect(sum(a)).toBe(70);
  });
});

describe("Pillar 4 theorems — machine-checked on random instances", () => {
  it("T1 safety, T2 sharing-incentive, T3 work-conservation, T4 bounded unfairness", () => {
    const rng = mulberry32(99);
    const TRIALS = 20_000;
    for (let trial = 0; trial < TRIALS; trial++) {
      const n = 2 + Math.floor(rng() * 5); // 2..6 tenants
      const weights = Array.from({ length: n }, () => 1 + Math.floor(rng() * 8)); // 1..8
      const demands = Array.from({ length: n }, () => Math.floor(rng() * 200)); // 0..199
      const limit = 1 + Math.floor(rng() * 150);
      const W = sum(weights);
      const minW = Math.min(...weights);
      const g = guaranteedShare(weights, limit);
      const want = Math.min(sum(demands), limit);

      const aC = waterfill(demands, weights, limit);
      const aI = waterfillInt(demands, weights, limit);

      // T1 — safety: the integer split never exceeds the budget (composes with Pillar 1 => Delta=0).
      if (sum(aI) > limit) throw new Error(`T1 fail: sum ${sum(aI)} > ${limit}`);
      // T3 — work-conservation: both hit exactly min(sum demand, limit); no budget stranded.
      if (sum(aI) !== want) throw new Error(`T3 int fail: ${sum(aI)} != ${want}`);
      if (Math.abs(sum(aC) - want) > 1e-6) throw new Error(`T3 cont fail: ${sum(aC)} != ${want}`);

      for (let i = 0; i < n; i++) {
        const floor = Math.min(demands[i] as number, g[i] as number);
        // T2 — sharing incentive (continuous ideal, exact): never below the guaranteed weighted share.
        if ((aC[i] as number) < floor - 1e-9)
          throw new Error(`T2 cont fail node ${i}: ${aC[i]} < ${floor}`);
        // T2 — integer realization: within the proven DRR rounding slack w_i*n/W of that floor.
        const slack = ((weights[i] as number) * n) / W;
        if ((aI[i] as number) < floor - slack - 1e-9)
          throw new Error(`T2 int fail node ${i}: ${aI[i]} < ${floor} - ${slack}`);
      }

      // T4 — bounded unfairness: integer normalized-service spread <= one quantum (1/min weight);
      // the continuous ideal is perfectly level (~0). Independent of demand magnitude / window length.
      const spreadI = normalizedSpread(aI, weights, demands);
      const spreadC = normalizedSpread(aC, weights, demands);
      if (spreadI > 1 / minW + 1e-9)
        throw new Error(`T4 int fail: spread ${spreadI} > ${1 / minW}`);
      if (spreadC > 1e-6) throw new Error(`T4 cont fail: spread ${spreadC}`);
    }
    expect(TRIALS).toBe(20_000); // reached the end with no thrown invariant violation
  });

  it("the integer split equals the continuous ideal up to one quantum per tenant", () => {
    const rng = mulberry32(7);
    for (let t = 0; t < 5_000; t++) {
      const n = 2 + Math.floor(rng() * 4);
      const weights = Array.from({ length: n }, () => 1 + Math.floor(rng() * 6));
      const demands = Array.from({ length: n }, () => Math.floor(rng() * 150));
      const limit = 1 + Math.floor(rng() * 120);
      const aC = waterfill(demands, weights, limit);
      const aI = waterfillInt(demands, weights, limit);
      for (let i = 0; i < n; i++) {
        // |a_i^int - a_i^cont| <= w_i (the per-tenant quantum is w_i credits of normalized service).
        if (Math.abs((aI[i] as number) - (aC[i] as number)) > (weights[i] as number) + 1e-9)
          throw new Error(`int vs cont gap node ${i}: |${aI[i]} - ${aC[i]}| > ${weights[i]}`);
      }
    }
    expect(true).toBe(true);
  });
});

describe("fairness metrics", () => {
  it("guaranteedShare floors to a weighted split summing to <= limit", () => {
    expect(guaranteedShare([4, 1, 1, 1], 70)).toEqual([40, 10, 10, 10]);
    expect(sum(guaranteedShare([3, 3, 2], 100))).toBeLessThanOrEqual(100);
  });

  it("Jain index is 1 for equal allocations and drops with skew", () => {
    expect(jainFairness([5, 5, 5, 5])).toBeCloseTo(1, 10);
    expect(jainFairness([20, 0, 0, 0])).toBeCloseTo(0.25, 10); // 1/n for a single grabber
    expect(jainFairness([])).toBe(1);
  });

  it("normalizedSpread is 0 for a weighted-fair split, large for an equal (weight-blind) one", () => {
    const demands = [100, 100, 100, 100];
    const weights = [4, 1, 1, 1];
    expect(
      normalizedSpread(waterfillInt(demands, weights, 70), weights, demands),
    ).toBeLessThanOrEqual(1);
    // Equal split [18,18,17,17] under true weights 4:1:1:1 -> normalized 4.5 vs 18 -> spread 13.5.
    expect(normalizedSpread([18, 18, 17, 17], weights, demands)).toBeCloseTo(13.5, 10);
  });

  it("staticShareAlloc caps each tenant at its guaranteed share", () => {
    expect(staticShareAlloc([100, 100, 100, 100], [4, 1, 1, 1], 70)).toEqual([40, 10, 10, 10]);
    expect(staticShareAlloc([5, 100, 100, 100], [4, 1, 1, 1], 70)).toEqual([5, 10, 10, 10]); // strands 35
  });
});

describe("input validation", () => {
  it("rejects malformed inputs", () => {
    expect(() => waterfill([1, 2], [1], 10)).toThrow(/length mismatch/);
    expect(() => waterfill([1], [0], 10)).toThrow(/weights must be > 0/);
    expect(() => waterfill([-1], [1], 10)).toThrow(/demands must be >= 0/);
    expect(() => waterfill([1], [1], -5)).toThrow(/limit must be >= 0/);
  });
});

/**
 * Workload C — weighted multi-tenant overload (the Pillar-4 headline). One high-priority tenant H
 * (weight 4) steady ~40/window but idle every 5th window; three low-priority flooders (weight 1)
 * demanding ~100/window. Limit 70 (W=7 => H's share 40, each flooder 10). Exact seeded numbers are
 * recorded in research/gale/EVALUATION.md.
 */
describe("Workload C — WFE is the only split good on every axis (measured)", () => {
  const WINDOWS = 400;
  const LIMIT = 70;
  const weights = [4, 1, 1, 1];
  const rng = mulberry32(1234);
  const H: number[] = [];
  const floods: number[][] = [[], [], []];
  for (let t = 0; t < WINDOWS; t++) {
    H.push(t % 5 === 4 ? 0 : Math.round(40 + (rng() - 0.5) * 6));
    for (let f = 0; f < 3; f++) (floods[f] as number[]).push(Math.round(100 + (rng() - 0.5) * 20));
  }
  const traces = [H, ...floods];
  const staticM = evaluateFairness(traces, weights, LIMIT, "static");
  const blind = evaluateFairness(traces, weights, LIMIT, "weightBlind");
  const wfe = evaluateFairness(traces, weights, LIMIT, "wfe");

  it("all three splits keep overshoot at 0 (window-coupled => Pillar-1 bound inherited)", () => {
    expect(staticM.overshoot).toBe(0);
    expect(blind.overshoot).toBe(0);
    expect(wfe.overshoot).toBe(0);
  });

  it("static is fair but NOT work-conserving (strands the idle high-priority share)", () => {
    expect(staticM.shareViolationRate).toBe(0); // never below the guaranteed share
    expect(staticM.worstSpread).toBe(0);
    expect(staticM.meanUtil).toBeLessThan(0.9); // ~0.876 — wastes H's share when H is idle
  });

  it("weight-blind leasing is work-conserving but UNFAIR (starves the high-priority tenant)", () => {
    expect(blind.meanUtil).toBeCloseTo(1, 5); // reclaims everything
    expect(blind.shareViolationRate).toBeGreaterThan(0.2); // H starved below its share most windows
    expect(blind.worstSpread).toBeGreaterThan(10); // equal split ignores the 4x weight
  });

  it("WFE is work-conserving AND weight-fair — dominates both baselines", () => {
    expect(wfe.overshoot).toBe(0);
    expect(wfe.meanUtil).toBeCloseTo(1, 5); // matches weight-blind on utilization
    expect(wfe.shareViolationRate).toBe(0); // matches static on the share guarantee
    expect(wfe.worstSpread).toBeLessThanOrEqual(1); // within one quantum (T4)
    // Strictly better than each baseline on the axis that baseline fails:
    expect(wfe.meanUtil).toBeGreaterThan(staticM.meanUtil); // beats static on utilization
    expect(wfe.shareViolationRate).toBeLessThan(blind.shareViolationRate); // beats blind on fairness
  });
});
