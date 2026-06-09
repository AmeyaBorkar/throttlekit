/**
 * `RedisRegionFairPool` (DR-FWFE-1) against a real Redis. Gated on `THROTTLEKIT_TEST_REDIS` (set to e.g.
 * `redis://localhost:6380`; see `memory/local-test-redis.md`) — the rest of the suite runs without Redis.
 *
 * The load-bearing assertion is **grant-for-grant conformance**: the Lua grant must return byte-identically
 * to the in-process `regionFairPool` on the same scripted sequence (so the safety-critical `Σ_r granted ≤ L`
 * weighted-max-min arithmetic is provably the same in Lua as in the verified in-process oracle). Plus the
 * end-to-end `federatedWeightedFairEscrow`-over-Redis Σ ≤ L + weight-fair split, window roll, release, stats.
 */

import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ManualClock } from "../../src/core/clock";
import { fromNodeRedis } from "../../src/redis/clients";
import {
  federatedWeightedFairEscrow,
  regionFairPool,
} from "../../src/twotier/federated-weighted-fair-escrow";
import { RedisRegionFairPool } from "../../src/twotier/redis-region-fair-pool";

const url = process.env.THROTTLEKIT_TEST_REDIS;
const d = url ? describe : describe.skip;
const WINDOW = 60_000;
// A fixed, window-aligned epoch for deterministic runs. NOTE: `now = 0` is the shared LUA_NOW "use server
// TIME" sentinel, so deterministic tests must pass a NON-ZERO `now` (the same convention RedisRegionalEscrow
// uses with `Math.floor(Date.now()/windowMs)*windowMs`). `1_699_999_980_000 % 60_000 === 0`.
const T0 = 1_699_999_980_000;

/** Exact integer flat weighted-max-min (the oracle). */
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

d("RedisRegionFairPool (DR-FWFE-1)", () => {
  let client: ReturnType<typeof createClient>;
  // Flush-free co-tenant on DB 7 (the sanctioned overflow group; see test/redis/db-allocation): NO FLUSHDB,
  // and every key is namespaced under a per-run-unique prefix so re-runs + the other DB-7 files never collide.
  const RUN = Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    client = createClient({ url: url as string, database: 7 });
    await client.connect();
  });
  afterAll(async () => {
    if (client?.isOpen) await client.quit();
  });

  const redisPool = (key: string, limit: number, clock = new ManualClock(T0)) =>
    new RedisRegionFairPool({
      client: fromNodeRedis(client),
      limit,
      windowMs: WINDOW,
      key,
      prefix: `tk:rfp:${RUN}`,
      clock,
      useServerTime: false, // deterministic: the script's `now` drives the window math, matching the oracle
    });

  it("grant() is byte-identical to the in-process regionFairPool (the safety arithmetic)", async () => {
    const L = 100;
    const now = T0;
    // A varied sequence: regions appearing, reservation, borrow, a monotonic re-ask, over-ask.
    const script: Array<[string, number, number]> = [
      ["us", 3, 10],
      ["eu", 1, 40],
      ["us", 3, 80],
      ["ap", 2, 30],
      ["eu", 1, 5], // monotonic — already holds ≥ 5
      ["us", 3, 200], // over-ask — capped at the fair ceiling
      ["ap", 2, 60],
      ["eu", 1, 100],
      ["us", 3, 100],
      ["ap", 2, 100],
    ];

    const inproc = regionFairPool({ limit: L, windowMs: WINDOW, clock: new ManualClock(T0) });
    const redis = redisPool("conformance", L);

    for (const [region, weight, want] of script) {
      const a = inproc.grant(region, weight, want, now);
      const b = await redis.grant(region, weight, want, now);
      expect(b, `grant(${region}, w=${weight}, want=${want})`).toBe(a);
    }

    const sInproc = inproc.stats();
    const sRedis = await redis.stats();
    expect(sRedis.totalGranted).toBe(sInproc.totalGranted);
    expect(sRedis.totalGranted).toBeLessThanOrEqual(L);
    // Same per-region grants (order-independent).
    const norm = (s: { regions: ReadonlyArray<{ region: string; granted: number }> }) =>
      Object.fromEntries(s.regions.map((r) => [r.region, r.granted]));
    expect(norm(sRedis)).toEqual(norm(sInproc));
  });

  it("rolls the window: a grant in the next window starts fresh", async () => {
    const redis = redisPool("roll", 50);
    expect(await redis.grant("us", 1, 50, T0)).toBe(50);
    expect((await redis.stats()).windowStart).toBe(T0);
    // Next window — the prior state is cleared, so us re-grants its full share.
    expect(await redis.grant("us", 1, 50, T0 + WINDOW)).toBe(50);
    expect((await redis.stats()).windowStart).toBe(T0 + WINDOW);
    expect((await redis.stats()).totalGranted).toBe(50);
  });

  it("release() returns a region's budget to the pool", async () => {
    const redis = redisPool("release", 100);
    await redis.grant("us", 1, 40, T0);
    await redis.grant("eu", 1, 40, T0);
    expect((await redis.stats()).regions.length).toBe(2);
    await redis.release("us", T0);
    const s = await redis.stats();
    expect(s.regions.some((r) => r.region === "us")).toBe(false);
    expect(s.regions.some((r) => r.region === "eu")).toBe(true);
  });

  it("federatedWeightedFairEscrow over Redis holds Σ ≤ L + weight-fair across regions", async () => {
    const L = 400;
    const pool = redisPool("wfe", L);
    const us = federatedWeightedFairEscrow({ region: "us", pool, weightOf: () => 3 });
    const eu = federatedWeightedFairEscrow({ region: "eu", pool, weightOf: () => 1 });

    let usAdmit = 0;
    let euAdmit = 0;
    for (let i = 0; i < 800; i++) {
      if ((await us.check("a", 1)).allowed) usAdmit++;
      if ((await eu.check("b", 1)).allowed) euAdmit++;
    }
    expect(usAdmit + euAdmit).toBeLessThanOrEqual(L);
    expect((await pool.stats()).totalGranted).toBeLessThanOrEqual(L);
    // 3:1 weighted-fair split, within a small integer residual (matching the in-process suite's tolerance).
    const star = waterfillInt([1e9, 1e9], [3, 1], L); // 300, 100
    expect(Math.abs(usAdmit - (star[0] as number))).toBeLessThanOrEqual(3);
    expect(Math.abs(euAdmit - (star[1] as number))).toBeLessThanOrEqual(3);
  });

  it("validates inputs", () => {
    expect(() => redisPool("bad", 0)).toThrow(/limit/);
    const p = redisPool("ok", 100);
    expect(p.grant("", 1, 1, 0)).rejects.toThrow(/region/);
    expect(p.grant("us", 0, 1, 0)).rejects.toThrow(/weight/);
  });
});
