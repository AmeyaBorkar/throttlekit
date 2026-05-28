import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gcra } from "../../src/algorithms/gcra";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";
import { RedisStore } from "../../src/redis/store";

/**
 * checkMany over a live RedisStore equals sequential check() over the same keys. The async batch
 * fires one decisionTransform per key — the same transform check() uses — so for distinct keys it
 * is exactly N independent atomic EVALSHA round trips, just issued concurrently. Gated on a real
 * Redis (THROTTLEKIT_TEST_REDIS); dedicated DB so a parallel file's flush can't wipe it.
 */

const url = process.env.THROTTLEKIT_TEST_REDIS;
const d = url ? describe : describe.skip;

d("checkMany over RedisStore", () => {
  let client: Redis;

  beforeAll(async () => {
    // Dedicated DB 6 — federation/redis-coordinator.test.ts lives on DB 8
    // with flushDb on setup + afterEach, and under parallel test execution
    // that flushDb would wipe these keys mid-test. DB 6 is dedicated to
    // this file (TK-1009 release-cycle fix).
    client = new Redis(url as string, { db: 6 });
    await client.flushdb();
  });

  afterAll(async () => {
    await client?.quit();
  });

  it("equals sequential check() for distinct keys", async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const opts = { strategy: gcra({ limit: 100, periodMs: 60_000, burst: 20 }), clock } as const;
    const batch = rateLimit({ ...opts, store: new RedisStore({ client, useServerTime: false }) });
    const ref = rateLimit({ ...opts, store: new RedisStore({ client, useServerTime: false }) });

    const keys = ["a", "b", "c", "d", "e"].map((k) => `cm:${k}`);
    const refKeys = keys.map((k) => `${k}:ref`);

    const many = await batch.checkMany(keys, 4);
    const one = [];
    for (const k of refKeys) one.push(await ref.check(k, 4));

    // Same decisions (keys differ only by suffix, both fresh cells at the same clock).
    expect(many.map((m) => ({ ...m, resetAt: 0 }))).toEqual(one.map((o) => ({ ...o, resetAt: 0 })));
    expect(many.every((m) => m.allowed)).toBe(true);
    expect(many.length).toBe(keys.length);
  });
});
