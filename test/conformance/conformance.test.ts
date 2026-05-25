import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { gcra } from "../../src/algorithms/gcra";
import { tokenBucket } from "../../src/algorithms/token-bucket";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";
import type { Strategy } from "../../src/core/types";
import { RedisStore } from "../../src/redis/store";
import { MemoryStore } from "../../src/stores/memory";

/**
 * The isomorphic dual-path proof: the same strategy run through the JS executor (MemoryStore) and
 * the atomic Redis Lua executor (RedisStore) must produce bit-identical decision streams across
 * thousands of generated timelines. Gated on a real Redis (THROTTLEKIT_TEST_REDIS).
 */

const url = process.env.THROTTLEKIT_TEST_REDIS;
const d = url ? describe : describe.skip;

/** Deterministic PRNG so failures reproduce exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Case {
  name: string;
  make: () => Strategy;
}

const cases: Case[] = [
  { name: "gcra-100-60s-burst20", make: () => gcra({ limit: 100, periodMs: 60_000, burst: 20 }) },
  { name: "gcra-2-1s", make: () => gcra({ limit: 2, periodMs: 1000 }) },
  {
    name: "gcra-1000-60s-burst100",
    make: () => gcra({ limit: 1000, periodMs: 60_000, burst: 100 }),
  },
  { name: "tokenBucket-50cap-10rps", make: () => tokenBucket({ capacity: 50, refillPerSec: 10 }) },
  {
    name: "tokenBucket-20cap-3.5rps",
    make: () => tokenBucket({ capacity: 20, refillPerSec: 3.5 }),
  },
  { name: "fixedWindow-50-1s", make: () => fixedWindow({ limit: 50, windowMs: 1000 }) },
  { name: "fixedWindow-10-250ms", make: () => fixedWindow({ limit: 10, windowMs: 250 }) },
];

const TIMELINES = 40;
const STEPS = 25;

d("dual-path conformance (JS vs Redis Lua)", () => {
  let client: Redis;

  beforeAll(async () => {
    client = new Redis(url as string, { maxRetriesPerRequest: 2, lazyConnect: false });
    await client.flushdb();
  });

  afterAll(async () => {
    await client?.quit();
  });

  for (const [ci, c] of cases.entries()) {
    it(`${c.name}: JS and Lua agree across ${TIMELINES}×${STEPS} timelines`, async () => {
      for (let t = 0; t < TIMELINES; t++) {
        const rng = mulberry32(1000 + ci * 101 + t);
        const clock = new ManualClock(1_700_000_000_000 + t * 37);
        const js = rateLimit({
          strategy: c.make(),
          clock,
          store: new MemoryStore({ clock, sweepIntervalMs: 0 }),
        });
        const redis = rateLimit({
          strategy: c.make(),
          clock,
          store: new RedisStore({ client, useServerTime: false }),
        });
        const key = `conf:${c.name}:${t}`;

        for (let s = 0; s < STEPS; s++) {
          const delta = Math.floor(rng() * 900);
          const cost = 1 + Math.floor(rng() * 4);
          clock.advance(delta);
          const dJs = await js.check(key, cost);
          const dRedis = await redis.check(key, cost);
          expect(
            dRedis,
            `${c.name} timeline=${t} step=${s} now=${clock.now()} cost=${cost}`,
          ).toEqual(dJs);
        }
      }
    });
  }
});
