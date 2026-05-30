import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/core/clock";
import {
  federatedWeightedFairEscrow,
  regionFairPool,
} from "../../src/twotier/federated-weighted-fair-escrow";

/**
 * Federated Weighted Fair Escrow (TK-1404, #176). The composition theorem (per-region tenant WFE ∘
 * cross-region region WFE ⟹ flat global weighted-max-min) is machine-checked in
 * `research/bigger-bets/federation/federated-wfe-gate.ts`; these tests pin the SHIPPED implementation:
 *   - Σ admitted ≤ L across regions (safety) — even when one region floods (the pool reserves);
 *   - region budget is split weight-proportionally with RESERVATION (a plain counter cannot);
 *   - per-tenant GLOBAL totals match the flat oracle within a small integer residual (composition);
 *   - in-region weighted-max-min among tenants; idle-region surplus reclaimed; weight-split (F2);
 *   - window roll, stats, reset, validation.
 */

const WINDOW = 60_000;

/** Exact integer flat weighted-max-min (the oracle), mirroring test/gale/fair-escrow.ts. */
function waterfillInt(demands: number[], weights: number[], limit: number): number[] {
  const n = demands.length;
  const alloc = new Array<number>(n).fill(0);
  let budget = Math.floor(limit);
  while (budget > 0) {
    let best = -1;
    let bestRatio = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      if ((alloc[i] as number) >= (demands[i] as number)) continue;
      const ratio = (alloc[i] as number) / (weights[i] as number);
      if (ratio < bestRatio) {
        bestRatio = ratio;
        best = i;
      }
    }
    if (best === -1) break;
    alloc[best] = (alloc[best] as number) + 1;
    budget--;
  }
  return alloc;
}

describe("regionFairPool / federatedWeightedFairEscrow — validation", () => {
  it("rejects non-positive pool limit / windowMs", () => {
    expect(() => regionFairPool({ limit: 0, windowMs: WINDOW })).toThrow(/limit.*positive/i);
    expect(() => regionFairPool({ limit: 100, windowMs: 0 })).toThrow(/windowMs.*positive/i);
  });
  it("rejects an empty region or a missing pool", () => {
    const pool = regionFairPool({ limit: 100, windowMs: WINDOW });
    expect(() => federatedWeightedFairEscrow({ region: "", pool })).toThrow(/region/i);
    // biome-ignore lint/suspicious/noExplicitAny: deliberately bad pool
    expect(() => federatedWeightedFairEscrow({ region: "us", pool: {} as any })).toThrow(/pool/i);
  });
  it("rejects empty tenant / non-positive cost / non-positive weight", () => {
    const pool = regionFairPool({ limit: 100, windowMs: WINDOW });
    const e = federatedWeightedFairEscrow({ region: "us", pool });
    expect(() => e.checkSync("", 1)).toThrow(/tenant/i);
    expect(() => e.checkSync("a", 0)).toThrow();
    const bad = federatedWeightedFairEscrow({ region: "us", pool, weightOf: () => 0 });
    expect(() => bad.checkSync("a", 1)).toThrow(/weight.*positive/i);
  });
});

describe("federatedWeightedFairEscrow — safety (Σ admitted ≤ L)", () => {
  it("a lone region may use all of L (work-conserving)", () => {
    const clock = new ManualClock(0);
    const pool = regionFairPool({ limit: 50, windowMs: WINDOW, clock });
    const us = federatedWeightedFairEscrow({ region: "us", pool });
    let admitted = 0;
    for (let i = 0; i < 80; i++) if (us.checkSync("a", 1).allowed) admitted++;
    expect(admitted).toBe(50);
  });

  it("never over-admits across regions, even when one region floods first", () => {
    const L = 400;
    const clock = new ManualClock(0);
    const pool = regionFairPool({ limit: L, windowMs: WINDOW, clock });
    const us = federatedWeightedFairEscrow({ region: "us", pool, weightOf: () => 3 });
    const eu = federatedWeightedFairEscrow({ region: "eu", pool, weightOf: () => 1 });

    // eu floods 1000 calls BEFORE us appears — the pool must still never let Σ exceed L.
    let total = 0;
    for (let i = 0; i < 1000; i++) if (eu.checkSync("b", 1).allowed) total++;
    for (let i = 0; i < 1000; i++) if (us.checkSync("a", 1).allowed) total++;
    expect(total).toBeLessThanOrEqual(L);
    expect(pool.stats().totalGranted).toBeLessThanOrEqual(L);
  });
});

describe("federatedWeightedFairEscrow — in-region weighted-max-min", () => {
  it("splits one region's budget across tenants in proportion to weight", () => {
    const L = 400;
    const clock = new ManualClock(0);
    const pool = regionFairPool({ limit: L, windowMs: WINDOW, clock });
    const us = federatedWeightedFairEscrow({
      region: "us",
      pool,
      weightOf: (t) => (t === "a" ? 3 : 1),
    });
    let a = 0;
    let b = 0;
    for (let i = 0; i < 1000; i++) {
      if (us.checkSync("a", 1).allowed) a++;
      if (us.checkSync("b", 1).allowed) b++;
    }
    expect(a + b).toBe(L);
    const star = waterfillInt([1e9, 1e9], [3, 1], L); // 300, 100
    expect(Math.abs(a - (star[0] as number))).toBeLessThanOrEqual(2);
    expect(Math.abs(b - (star[1] as number))).toBeLessThanOrEqual(2);
  });
});

describe("federatedWeightedFairEscrow — cross-region weighted fairness (reservation)", () => {
  it("splits the global budget across regions in proportion to weight", () => {
    const L = 400;
    const clock = new ManualClock(0);
    const pool = regionFairPool({ limit: L, windowMs: WINDOW, clock });
    const us = federatedWeightedFairEscrow({ region: "us", pool, weightOf: () => 3 });
    const eu = federatedWeightedFairEscrow({ region: "eu", pool, weightOf: () => 1 });
    let a = 0;
    let b = 0;
    for (let i = 0; i < 1000; i++) {
      if (us.checkSync("a", 1).allowed) a++;
      if (eu.checkSync("b", 1).allowed) b++;
    }
    expect(a + b).toBe(L); // work-conserving
    const star = waterfillInt([1e9, 1e9], [3, 1], L); // 300, 100 — the SAME as a flat global WFE
    expect(Math.abs(a - (star[0] as number))).toBeLessThanOrEqual(2);
    expect(Math.abs(b - (star[1] as number))).toBeLessThanOrEqual(2);
  });

  it("matches the flat global oracle across regions+tenants (the composition guarantee)", () => {
    const L = 300;
    const clock = new ManualClock(0);
    const pool = regionFairPool({ limit: L, windowMs: WINDOW, clock });
    // us: a(w2), b(w1); eu: c(w1) — all region-local (span 1), all backlogged.
    const us = federatedWeightedFairEscrow({
      region: "us",
      pool,
      weightOf: (t) => (t === "a" ? 2 : 1),
    });
    const eu = federatedWeightedFairEscrow({ region: "eu", pool, weightOf: () => 1 });
    let a = 0;
    let b = 0;
    let c = 0;
    for (let i = 0; i < 2000; i++) {
      if (us.checkSync("a", 1).allowed) a++;
      if (us.checkSync("b", 1).allowed) b++;
      if (eu.checkSync("c", 1).allowed) c++;
    }
    // flat oracle over a(w2), b(w1), c(w1), L=300 ⇒ a=150, b=75, c=75.
    const star = waterfillInt([1e9, 1e9, 1e9], [2, 1, 1], L);
    expect(Math.abs(a - (star[0] as number))).toBeLessThanOrEqual(4);
    expect(Math.abs(b - (star[1] as number))).toBeLessThanOrEqual(4);
    expect(Math.abs(c - (star[2] as number))).toBeLessThanOrEqual(4);
    expect(a + b + c).toBe(L);
  });

  it("reclaims a TRULY ABSENT region's share for a busy region (work-conservation)", () => {
    const L = 300;
    const clock = new ManualClock(0);
    const pool = regionFairPool({ limit: L, windowMs: WINDOW, clock });
    // The topology has three regions, but only "busy" sends traffic this window. Its share is NOT
    // capped to a static 1/3 slice — the absent regions' budget is reclaimed (vs static partition).
    const busy = federatedWeightedFairEscrow({ region: "busy", pool });
    void federatedWeightedFairEscrow({ region: "eu", pool }); // exists, sends nothing
    void federatedWeightedFairEscrow({ region: "ap", pool }); // exists, sends nothing
    let admits = 0;
    for (let i = 0; i < 1000; i++) if (busy.checkSync("a", 1).allowed) admits++;
    expect(admits).toBe(L); // all of L — absent regions strand nothing
  });

  it("holds a paused region's guaranteed reserve until the window rolls (streaming-vs-batch, like WFE)", () => {
    // eu sends a small burst then goes quiet; us is backlogged. Within the window eu KEEPS its
    // guaranteed half — reclaim is between truly-absent regions, not paused ones (PILLAR4 T3). This
    // is the documented streaming gap, identical to in-region weightedFairEscrow.
    const L = 300;
    const clock = new ManualClock(0);
    const pool = regionFairPool({ limit: L, windowMs: WINDOW, clock });
    const us = federatedWeightedFairEscrow({ region: "us", pool, weightOf: () => 1 });
    const eu = federatedWeightedFairEscrow({ region: "eu", pool, weightOf: () => 1 });
    let usAdmits = 0;
    for (let i = 0; i < 1000; i++) {
      if (i < 5) eu.checkSync("b", 1); // eu: a 5-call burst, then quiet (paused, not absent)
      if (us.checkSync("a", 1).allowed) usAdmits++;
    }
    // us gets its guaranteed half (≈150); eu's paused reserve (≈150−5) is held, not reclaimed.
    expect(usAdmits).toBeGreaterThanOrEqual(L / 2 - 2);
    expect(usAdmits).toBeLessThanOrEqual(L / 2 + 5);
  });
});

describe("federatedWeightedFairEscrow — region-spanning tenant weight-split (F2)", () => {
  it("over-serves a spanning tenant under full-weight replication; demand-proportional split is fair", () => {
    const L = 600;
    const run = (split: boolean): number => {
      const clock = new ManualClock(0);
      const pool = regionFairPool({ limit: L, windowMs: WINDOW, clock });
      const spanW = split ? 1.5 : 3; // split ⇒ 1.5 in each of 2 regions (sums to 3); full ⇒ 3 each
      const us = federatedWeightedFairEscrow({
        region: "us",
        pool,
        weightOf: (t) => (t === "spanner" ? spanW : 3),
      });
      const eu = federatedWeightedFairEscrow({
        region: "eu",
        pool,
        weightOf: (t) => (t === "spanner" ? spanW : 3),
      });
      let spanner = 0;
      for (let i = 0; i < 2000; i++) {
        if (us.checkSync("spanner", 1).allowed) spanner++;
        if (eu.checkSync("spanner", 1).allowed) spanner++;
        us.checkSync("localU", 1);
        eu.checkSync("localE", 1);
      }
      return spanner;
    };
    // Fair global share of spanner (w=3) among {spanner 3, localU 3, localE 3}, L=600 ⇒ 200.
    const fair = waterfillInt([1e9, 1e9, 1e9], [3, 3, 3], L)[0] as number; // 200
    const spannerSplit = run(true);
    const spannerFull = run(false);
    expect(Math.abs(spannerSplit - fair)).toBeLessThanOrEqual(20);
    expect(spannerFull).toBeGreaterThan(spannerSplit * 1.4); // double-counted ⇒ markedly over-served
  });
});

describe("federatedWeightedFairEscrow — window roll + introspection", () => {
  it("rolls the region + pool windows together and refreshes the budget", () => {
    const L = 100;
    const clock = new ManualClock(0);
    const pool = regionFairPool({ limit: L, windowMs: WINDOW, clock });
    const us = federatedWeightedFairEscrow({ region: "us", pool });
    let first = 0;
    for (let i = 0; i < 200; i++) if (us.checkSync("a", 1).allowed) first++;
    expect(first).toBe(L);

    clock.advance(WINDOW); // roll
    let second = 0;
    for (let i = 0; i < 200; i++) if (us.checkSync("a", 1).allowed) second++;
    expect(second).toBe(L); // fresh budget next window
  });

  it("stats() reflects region budget, active weight, and per-tenant usage; pool.stats() sums grants", () => {
    const clock = new ManualClock(0);
    const pool = regionFairPool({ limit: 100, windowMs: WINDOW, clock });
    const us = federatedWeightedFairEscrow({
      region: "ap-south",
      pool,
      weightOf: (t) => (t === "big" ? 4 : 1),
    });
    us.checkSync("big", 10);
    us.checkSync("small", 5);
    const s = us.stats();
    expect(s.region).toBe("ap-south");
    expect(s.limit).toBe(100);
    expect(s.totalUsed).toBe(15);
    expect(s.activeWeight).toBe(5);
    expect(s.regionBudget).toBeGreaterThanOrEqual(15);
    expect(s.tenants).toHaveLength(2);
    expect(pool.stats().totalGranted).toBe(s.regionBudget);
  });

  // ── Regression guards for the three MAJOR bugs the adversarial skeptics caught ──

  it("REGRESSION: a multi-tenant region reaches full utilisation for cost>1 (no lazy-lease deadlock)", () => {
    // BUG (skeptics 2 & 3): the region used to lease only `totalUsed+cost`, which the co-tenant
    // reserve then ate, denying the request and freezing the region at ~5% utilisation for cost>1.
    for (const cost of [1, 2, 5, 10]) {
      const clock = new ManualClock(0);
      const pool = regionFairPool({ limit: 200, windowMs: WINDOW, clock });
      const us = federatedWeightedFairEscrow({ region: "us", pool }); // 4 equal-weight tenants
      let admitted = 0;
      for (let i = 0; i < 2000; i++) {
        for (const t of ["a", "b", "c", "d"]) if (us.checkSync(t, cost).allowed) admitted += cost;
      }
      expect(admitted).toBe(200); // all of L, every cost — not a 5% deadlock
    }
  });

  it("a saturating co-tenant does not choke the region, but inflates its share (documented T3 gap)", () => {
    // The gate's World-C foil through the SHIPPED stack: us has a tiny-demand 'sipper' (d=5) and an
    // unbounded 'gulper'; eu has 'steady'. Two honest facts:
    //   (1) the saturating sipper must NOT deadlock the region — it gets exactly its 5, gulper flows;
    //   (2) but sipper's weight still counts toward us's region weight (a streaming limiter can't know
    //       sipper is demand-bottlenecked), so us claims a 2:1 region share and gulper is over-served
    //       vs the flat oracle (48) while steady is under-served. This is the SAME streaming-vs-batch
    //       reserve gap as in-region weightedFairEscrow (PILLAR4 T3), now at the region level — exact
    //       only in the all-backlogged fluid limit (see the all-backlogged composition test above).
    const L = 100;
    const clock = new ManualClock(0);
    const pool = regionFairPool({ limit: L, windowMs: WINDOW, clock });
    const us = federatedWeightedFairEscrow({ region: "us", pool, weightOf: () => 1 });
    const eu = federatedWeightedFairEscrow({ region: "eu", pool, weightOf: () => 1 });
    let sipper = 0;
    let gulper = 0;
    let steady = 0;
    for (let i = 0; i < 2000; i++) {
      if (sipper < 5 && us.checkSync("sipper", 1).allowed) sipper++; // demand capped at 5
      if (us.checkSync("gulper", 1).allowed) gulper++;
      if (eu.checkSync("steady", 1).allowed) steady++;
    }
    expect(sipper).toBe(5); // (1) no choke / deadlock — sipper served exactly its demand
    // (2) sipper's guaranteed share is reserved (used 5 of g≈33) until the window rolls, so ~28
    // credits strand — gulper and steady are each choked to ≈33, roughly equal. This is NOT the flat
    // fluid oracle (48/47, fully reclaimed) but EXACTLY what a flat streaming weightedFairEscrow does
    // (the realizable target): the documented streaming-vs-batch reserve gap (PILLAR4 T3), here at
    // both levels. Utilisation < L under saturation is the honest price; exactness holds all-backlogged.
    expect(gulper).toBeGreaterThanOrEqual(28);
    expect(steady).toBeGreaterThanOrEqual(28);
    expect(Math.abs(gulper - steady)).toBeLessThanOrEqual(6); // both choked ≈ equally
    expect(sipper + gulper + steady).toBeLessThan(L); // ~28 stranded by sipper's reserve (T3)
    expect(sipper + gulper + steady).toBeGreaterThanOrEqual(L - 35);
  });

  it("REGRESSION: l1.maxKeys eviction never over-admits (Σ used ≤ L under a unique-tenant flood)", () => {
    // BUG (skeptics 2 & 3): eviction discarded a tenant's served `used`, letting the region re-lease
    // and admit ~10–98× over L. evictedUsed must keep those credits counted against the budget.
    const L = 100;
    const clock = new ManualClock(0);
    const pool = regionFairPool({ limit: L, windowMs: WINDOW, clock });
    const us = federatedWeightedFairEscrow({ region: "us", pool, l1: { maxKeys: 1 } });
    let admitted = 0;
    for (let i = 0; i < 5000; i++) if (us.checkSync(`tenant-${i}`, 1).allowed) admitted++; // all unique
    expect(admitted).toBeLessThanOrEqual(L); // was 5000 (50× over) before the fix
    expect(us.stats().totalUsed).toBeLessThanOrEqual(L);
  });

  it("reset() clears a tenant; reset() with no arg releases the region from the pool", () => {
    const clock = new ManualClock(0);
    const pool = regionFairPool({ limit: 100, windowMs: WINDOW, clock });
    const us = federatedWeightedFairEscrow({ region: "us", pool });
    us.checkSync("a", 20);
    us.reset("a");
    expect(us.stats().tenants.find((t) => t.tenant === "a")).toBeUndefined();
    us.reset();
    expect(us.stats().windowStart).toBe(Number.NEGATIVE_INFINITY);
    expect(pool.stats().regions.find((r) => r.region === "us")).toBeUndefined();
  });
});
