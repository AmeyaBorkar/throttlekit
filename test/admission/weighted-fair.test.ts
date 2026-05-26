import { describe, expect, it } from "vitest";
import { guaranteedShare, weightedFairShare, weightedMaxMin } from "../../src/admission";
import { ManualClock } from "../../src/core/clock";
import type { Decision } from "../../src/core/types";

/**
 * Weighted Fair Escrow shipped into the library: the proven weighted max-min allocator
 * (`weightedMaxMin`) and its online streaming limiter (`weightedFairShare`). The allocator's four
 * properties (safety / weighted-floor / work-conservation / bounded unfairness) are the GALE Pillar 4
 * theorems (research/gale/PILLAR4-fairness.md), here machine-checked on random instances against the
 * shipped code.
 */

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** Spread of normalized service a_i/w_i across still-backlogged tenants (0 == perfectly weight-fair). */
function normalizedSpread(
  alloc: readonly number[],
  weights: readonly number[],
  demands: readonly number[],
): number {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < alloc.length; i++) {
    if ((alloc[i] as number) >= (demands[i] as number)) continue; // not backlogged
    const norm = (alloc[i] as number) / (weights[i] as number);
    lo = Math.min(lo, norm);
    hi = Math.max(hi, norm);
  }
  return hi < lo ? 0 : hi - lo;
}

function expectValidDecision(d: Decision): void {
  expect(typeof d.allowed).toBe("boolean");
  for (const v of [d.limit, d.remaining, d.resetAt, d.retryAfterMs]) {
    expect(Number.isInteger(v)).toBe(true);
  }
  expect(d.remaining).toBeGreaterThanOrEqual(0);
  expect(d.remaining).toBeLessThanOrEqual(d.limit);
  expect(d.retryAfterMs === 0).toBe(d.allowed);
}

/** mulberry32 — seeded PRNG for the property sweep. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("weightedMaxMin — the proven WFE allocator", () => {
  it("validates inputs", () => {
    expect(() => weightedMaxMin([1, 2], [1], 10)).toThrow(RangeError); // length mismatch
    expect(() => weightedMaxMin([1], [0], 10)).toThrow(RangeError); // non-positive weight
    expect(() => weightedMaxMin([1], [1], -1)).toThrow(RangeError); // negative limit
    expect(() => weightedMaxMin([-1], [1], 10)).toThrow(RangeError); // negative demand
  });

  it("splits a contended budget in proportion to weight", () => {
    // One weight-4 tenant vs three weight-1, all demanding 100, budget 100 (W = 7).
    const alloc = weightedMaxMin([100, 100, 100, 100], [4, 1, 1, 1], 100);
    expect(sum(alloc)).toBe(100); // work-conserving: the whole budget is spent
    expect(alloc[0]).toBeGreaterThan(3 * (alloc[1] as number)); // ~4× the share of a weight-1 tenant
    // All three weight-1 tenants are treated alike (within the 1-credit integer gap).
    expect(
      Math.max(alloc[1] as number, alloc[2] as number, alloc[3] as number) -
        Math.min(alloc[1] as number, alloc[2] as number, alloc[3] as number),
    ).toBeLessThanOrEqual(1);
  });

  it("is work-conserving: an idle tenant's share flows to the backlogged ones", () => {
    // Tenant 0 (weight 1) wants only 5; tenants 1,2 (weight 1) are backlogged. Budget 100.
    const alloc = weightedMaxMin([5, 100, 100], [1, 1, 1], 100);
    expect(alloc[0]).toBe(5); // served its small demand
    expect(sum(alloc)).toBe(100); // …and the other 95 is NOT stranded — it goes to 1 and 2
    expect(alloc[1]).toBeGreaterThan(40);
    expect(alloc[2]).toBeGreaterThan(40);
  });

  it("equal weights reduce to ordinary (unweighted) max-min", () => {
    const alloc = weightedMaxMin([100, 100, 100, 100], [1, 1, 1, 1], 100);
    expect(sum(alloc)).toBe(100);
    for (const a of alloc) expect(a).toBe(25); // perfectly even
  });

  it("never exceeds demand or the budget; leaves surplus when demand is light", () => {
    const alloc = weightedMaxMin([10, 20, 5], [1, 2, 1], 1000); // total demand 35 << budget
    expect(alloc).toEqual([10, 20, 5]); // everyone fully served, nothing invented
  });

  it("THEOREMS T1–T4 hold on 5k random instances (machine-checked)", () => {
    const r = rng(12345);
    for (let trial = 0; trial < 5_000; trial++) {
      const n = 1 + Math.floor(r() * 6);
      const weights = Array.from({ length: n }, () => 1 + Math.floor(r() * 4)); // 1..4
      const demands = Array.from({ length: n }, () => Math.floor(r() * 200));
      const limit = Math.floor(r() * 400);
      const alloc = weightedMaxMin(demands, weights, limit);
      const g = guaranteedShare(weights, limit);

      // T1 (safety) + T3 (work-conservation): sum is exactly min(Σ demand, limit), never over budget.
      expect(sum(alloc)).toBe(Math.min(sum(demands), limit));
      for (let i = 0; i < n; i++) {
        expect(alloc[i]).toBeLessThanOrEqual(demands[i] as number); // never over-serve a tenant
        expect(alloc[i]).toBeGreaterThanOrEqual(0);
        // T2 (weighted floor): a tenant gets at least min(its demand, its guaranteed weighted share).
        expect(alloc[i]).toBeGreaterThanOrEqual(Math.min(demands[i] as number, g[i] as number));
      }
      // T4 (bounded unfairness): normalized service a_i/w_i across backlogged tenants is within the
      // integer drip gap (≤ 1/min-weight ≤ 1 here).
      expect(normalizedSpread(alloc, weights, demands)).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});

describe("weightedFairShare — online weighted limiter", () => {
  it("validates options and inputs", () => {
    expect(() => weightedFairShare({ limit: 0, windowMs: 1000 })).toThrow(RangeError);
    expect(() => weightedFairShare({ limit: 10, windowMs: 0 })).toThrow(RangeError);
    const fs = weightedFairShare({ limit: 10, windowMs: 1000, clock: new ManualClock(0) });
    expect(() => fs.checkSync("a", 0)).toThrow(RangeError); // cost must be positive
    expect(() => fs.checkSync("a", 1, -1)).toThrow(RangeError); // weight must be positive
  });

  it("splits the budget by weight: a weight-4 tenant admits ~4× a weight-1 tenant", () => {
    const clock = new ManualClock(0);
    const fs = weightedFairShare({
      limit: 100,
      windowMs: 1000,
      clock,
      weightOf: (t) => (t === "big" ? 4 : 1),
    });
    let big = 0;
    let small = 0;
    // Both flood; interleave so the active-weight sum is established early.
    for (let i = 0; i < 200; i++) {
      if (fs.checkSync("big").allowed) big++;
      if (fs.checkSync("small").allowed) small++;
    }
    // W = 5 ⇒ big cap ~80, small cap ~20.
    expect(big).toBeGreaterThan(3 * small);
    expect(big + small).toBeLessThanOrEqual(100); // hard global cap
  });

  it("no starvation: a low-weight tenant active alongside a whale still gets its weighted floor", () => {
    const clock = new ManualClock(0);
    const fs = weightedFairShare({
      limit: 100,
      windowMs: 1000,
      clock,
      weightOf: (t) => (t === "whale" ? 9 : 1),
    });
    // Both active concurrently (interleaved) ⇒ W = 10, so the mouse's weighted cap is floor(1/10·100).
    let small = 0;
    let whale = 0;
    for (let i = 0; i < 200; i++) {
      if (fs.checkSync("whale").allowed) whale++;
      if (fs.checkSync("mouse").allowed) small++;
    }
    expect(small).toBeGreaterThanOrEqual(9); // ≈ its weighted floor of 10 — the whale can't starve it
    expect(whale).toBeGreaterThan(small * 5); // …while the whale still gets the lion's share (~90)
  });

  it("enforces a hard global cap and resets each window", () => {
    const clock = new ManualClock(0);
    const fs = weightedFairShare({ limit: 30, windowMs: 1000, clock });
    let admitted = 0;
    for (let i = 0; i < 100; i++) if (fs.checkSync(`t${i % 5}`).allowed) admitted++;
    expect(admitted).toBe(30); // never over the budget
    clock.advance(1000); // next window
    expect(fs.checkSync("t0").allowed).toBe(true); // budget refreshed
  });

  it("equal weights behave like fairShare (even split); reset works", () => {
    const clock = new ManualClock(0);
    const fs = weightedFairShare({ limit: 100, windowMs: 1000, clock }); // default weight 1
    const counts = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      const t = `t${i % 4}`;
      if (fs.checkSync(t).allowed) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    for (const c of counts.values()) expect(c).toBe(25); // 4 tenants, even 25 each
    expectValidDecision(fs.checkSync("t0"));
    fs.reset();
    expect(fs.checkSync("fresh").allowed).toBe(true);
  });
});
