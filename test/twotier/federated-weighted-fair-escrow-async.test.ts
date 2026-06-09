import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/core/clock";
import {
  type AsyncRegionFairPool,
  federatedWeightedFairEscrow,
  isAsyncRegionFairPool,
  regionFairPool,
  testRegionFairPool,
} from "../../src/twotier/federated-weighted-fair-escrow";

/**
 * The **async** cross-region pool path (DR-FWFE-1): a store-backed {@link AsyncRegionFairPool} lets
 * `federatedWeightedFairEscrow` enforce ONE global budget across SEPARATE region processes, routed
 * through `check()` (async) instead of `checkSync`. `testRegionFairPool` wraps the in-process pool behind
 * a Promise surface, so it is the conformance bridge: the async path must admit EXACTLY what the sync path
 * does, hold `Σ granted ≤ L` across regions sharing one pool, and — because grants are awaited — stay safe
 * under concurrent checks (the per-region serialization keeps each ensure+decide atomic). A production
 * `AsyncRegionFairPool` (e.g. RedisRegionFairPool, P3b) must replicate the same grant arithmetic atomically.
 */

const WINDOW = 60_000;
const weightOf = (t: string): number => (t === "a" ? 2 : 1);

/** Exact integer flat weighted-max-min (the oracle), mirroring the sync suite. */
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

describe("AsyncRegionFairPool — discrimination + checkSync gate", () => {
  it("testRegionFairPool is recognized as async; regionFairPool is not", () => {
    expect(isAsyncRegionFairPool(testRegionFairPool({ limit: 100, windowMs: WINDOW }))).toBe(true);
    expect(isAsyncRegionFairPool(regionFairPool({ limit: 100, windowMs: WINDOW }))).toBe(false);
  });

  it("checkSync throws with an async pool; check() works", async () => {
    const pool = testRegionFairPool({ limit: 50, windowMs: WINDOW, clock: new ManualClock(0) });
    const us = federatedWeightedFairEscrow({ region: "us", pool });
    expect(() => us.checkSync("a", 1)).toThrow(/checkSync is unavailable/i);
    expect((await us.check("a", 1)).allowed).toBe(true);
  });
});

describe("AsyncRegionFairPool — equivalence to the in-process pool", () => {
  it("the async path admits byte-identically to the sync path on the same scripted load", async () => {
    // A fixed, us-heavy two-region interleaving that exercises reservation + borrow (eu arrives late).
    const script: Array<[string, string, number]> = [];
    for (let i = 0; i < 150; i++) {
      const region = i < 40 ? "us" : i % 3 === 0 ? "eu" : "us"; // us floods first, eu joins later
      const tenant = i % 2 === 0 ? "a" : "b";
      script.push([region, tenant, 1]);
    }
    const L = 300;

    const syncPool = regionFairPool({ limit: L, windowMs: WINDOW, clock: new ManualClock(0) });
    const sync: Record<string, ReturnType<typeof federatedWeightedFairEscrow>> = {
      us: federatedWeightedFairEscrow({ region: "us", pool: syncPool, weightOf }),
      eu: federatedWeightedFairEscrow({ region: "eu", pool: syncPool, weightOf }),
    };
    const syncOut = script.map(([r, t, c]) => {
      const d = (sync[r] as ReturnType<typeof federatedWeightedFairEscrow>).checkSync(t, c);
      return [d.allowed, d.limit, d.remaining];
    });

    const asyncPool = testRegionFairPool({ limit: L, windowMs: WINDOW, clock: new ManualClock(0) });
    const asyncR: Record<string, ReturnType<typeof federatedWeightedFairEscrow>> = {
      us: federatedWeightedFairEscrow({ region: "us", pool: asyncPool, weightOf }),
      eu: federatedWeightedFairEscrow({ region: "eu", pool: asyncPool, weightOf }),
    };
    const asyncOut: Array<[boolean, number, number]> = [];
    for (const [r, t, c] of script) {
      const d = await (asyncR[r] as ReturnType<typeof federatedWeightedFairEscrow>).check(t, c);
      asyncOut.push([d.allowed, d.limit, d.remaining]);
    }

    expect(asyncOut).toEqual(syncOut); // identical arithmetic, only the transport differs
  });
});

describe("AsyncRegionFairPool — safety (Σ admitted ≤ L) across regions on one shared pool", () => {
  it("never over-admits across regions, even when one floods first", async () => {
    const L = 400;
    const pool = testRegionFairPool({ limit: L, windowMs: WINDOW, clock: new ManualClock(0) });
    const us = federatedWeightedFairEscrow({ region: "us", pool, weightOf: () => 3 });
    const eu = federatedWeightedFairEscrow({ region: "eu", pool, weightOf: () => 1 });

    let total = 0;
    for (let i = 0; i < 1000; i++) if ((await eu.check("b", 1)).allowed) total++;
    for (let i = 0; i < 1000; i++) if ((await us.check("a", 1)).allowed) total++;
    expect(total).toBeLessThanOrEqual(L);
    expect((await pool.stats()).totalGranted).toBeLessThanOrEqual(L);
  });

  it("splits the global budget across regions in proportion to weight (reservation holds)", async () => {
    const L = 400;
    const pool = testRegionFairPool({ limit: L, windowMs: WINDOW, clock: new ManualClock(0) });
    const us = federatedWeightedFairEscrow({ region: "us", pool, weightOf: () => 3 });
    const eu = federatedWeightedFairEscrow({ region: "eu", pool, weightOf: () => 1 });

    let usAdmit = 0;
    let euAdmit = 0;
    // Interleave so both regions are backlogged simultaneously — the pool reserves us its 3:1 share.
    for (let i = 0; i < 1000; i++) {
      if ((await us.check("a", 1)).allowed) usAdmit++;
      if ((await eu.check("b", 1)).allowed) euAdmit++;
    }
    expect(usAdmit + euAdmit).toBe(L);
    const star = waterfillInt([1e9, 1e9], [3, 1], L); // 300, 100
    expect(Math.abs(usAdmit - (star[0] as number))).toBeLessThanOrEqual(2);
    expect(Math.abs(euAdmit - (star[1] as number))).toBeLessThanOrEqual(2);
  });
});

describe("AsyncRegionFairPool — concurrency safety (per-region serialization)", () => {
  it("concurrent checks on one region never over-admit (serialized ensure+decide)", async () => {
    const L = 50;
    const pool = testRegionFairPool({ limit: L, windowMs: WINDOW, clock: new ManualClock(0) });
    const us = federatedWeightedFairEscrow({ region: "us", pool });

    // Fire 200 checks WITHOUT awaiting between them — the per-limiter chain serializes them, so the
    // awaited region-budget refills can't interleave and double-count. Exactly L must be admitted.
    const results = await Promise.all(Array.from({ length: 200 }, () => us.check("a", 1)));
    expect(results.filter((d) => d.allowed).length).toBe(L);
    expect((await pool.stats()).totalGranted).toBeLessThanOrEqual(L);
  });

  it("concurrent checks across regions on one pool hold Σ ≤ L", async () => {
    const L = 120;
    const pool = testRegionFairPool({ limit: L, windowMs: WINDOW, clock: new ManualClock(0) });
    const regions = ["us", "eu", "ap"].map((r) =>
      federatedWeightedFairEscrow({ region: r, pool, weightOf: () => 1 }),
    );
    // 100 concurrent checks per region, all racing the same shared async pool.
    const all = await Promise.all(
      regions.flatMap((reg) => Array.from({ length: 100 }, () => reg.check("a", 1))),
    );
    expect(all.filter((d) => d.allowed).length).toBeLessThanOrEqual(L);
    expect((await pool.stats()).totalGranted).toBeLessThanOrEqual(L);
  });
});

describe("AsyncRegionFairPool — reset releases the region", () => {
  it("reset() drops this region from the shared pool", async () => {
    const pool = testRegionFairPool({ limit: 100, windowMs: WINDOW, clock: new ManualClock(0) });
    const us = federatedWeightedFairEscrow({ region: "us", pool });
    await us.check("a", 10);
    expect((await pool.stats()).regions.some((r) => r.region === "us")).toBe(true);
    us.reset();
    expect((await pool.stats()).regions.some((r) => r.region === "us")).toBe(false);
  });
});
