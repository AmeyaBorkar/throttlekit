import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { gcra } from "../../src/algorithms/gcra";
import { slidingWindowLog } from "../../src/algorithms/sliding-window-log";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";
import type { Limiter, Strategy } from "../../src/core/types";
import { RedisStore } from "../../src/redis/store";
import { MemoryStore } from "../../src/stores/memory";

/**
 * The headline guarantee, exercised end-to-end through `rateLimit`: when N requests race a limiter
 * whose effective ceiling is K, EXACTLY K are allowed — never K+1 (a lost-update / TOCTOU bug) and
 * never K-1 (over-eager denial). For MemoryStore this proves the single-threaded RMW; for
 * RedisStore it proves the Lua script runs atomically server-side.
 */

const K = 50;
const N = 200;
// One hour: far larger than any test runs, so no window rolls over or token refills mid-burst.
const PERIOD_MS = 3_600_000;

/** Fire N concurrent `check()`s on one key and return how many were allowed. */
async function countAllowed(limiter: Limiter, key: string): Promise<number> {
  const decisions = await Promise.all(Array.from({ length: N }, () => limiter.check(key)));
  return decisions.filter((d) => d.allowed).length;
}

/** The three pass/deny strategies whose ceiling at cost 1 is exactly K over a long window. */
const strategies: Array<{ name: string; make: () => Strategy }> = [
  { name: "gcra", make: () => gcra({ limit: K, periodMs: PERIOD_MS }) },
  { name: "fixedWindow", make: () => fixedWindow({ limit: K, windowMs: PERIOD_MS }) },
  { name: "slidingWindowLog", make: () => slidingWindowLog({ limit: K, windowMs: PERIOD_MS }) },
];

describe("atomicity: N concurrent at limit K => exactly K allowed", () => {
  describe("MemoryStore", () => {
    for (const s of strategies) {
      it(`${s.name}: ${N} concurrent, K=${K} => exactly ${K} allowed`, async () => {
        const clock = new ManualClock(0);
        const store = new MemoryStore({ clock, sweepIntervalMs: 0 });
        const limiter = rateLimit({ strategy: s.make(), clock, store });
        try {
          expect(await countAllowed(limiter, `mem:${s.name}`)).toBe(K);
        } finally {
          await store.close();
        }
      });
    }
  });

  const url = process.env.THROTTLEKIT_TEST_REDIS;
  const dRedis = url !== undefined ? describe : describe.skip;

  dRedis("RedisStore (proves Lua atomicity)", () => {
    let client: Redis;

    beforeAll(async () => {
      // Dedicated DB 4 so this file's FLUSHDB cannot disturb the other Redis-using suites.
      client = new Redis(url as string, { db: 4 });
      await client.flushdb();
    });

    afterAll(async () => {
      await client?.quit();
    });

    for (const s of strategies) {
      it(`${s.name}: ${N} concurrent, K=${K} => exactly ${K} allowed`, async () => {
        // useServerTime: false pins `now` so the long window/period can't refill mid-burst; the
        // atomic Lua path serializes the N checks server-side.
        const store = new RedisStore({ client, useServerTime: false });
        const clock = new ManualClock(0);
        const limiter = rateLimit({ strategy: s.make(), clock, store });
        expect(await countAllowed(limiter, `redis:${s.name}`)).toBe(K);
      });
    }
  });
});
