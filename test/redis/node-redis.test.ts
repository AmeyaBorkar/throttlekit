import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { gcra } from "../../src/algorithms/gcra";
import { slidingWindow } from "../../src/algorithms/sliding-window";
import { tokenBucket } from "../../src/algorithms/token-bucket";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";
import type { Strategy } from "../../src/core/types";
import { fromNodeRedis } from "../../src/redis/clients";
import { RedisStore } from "../../src/redis/store";
import { MemoryStore } from "../../src/stores/memory";

/**
 * End-to-end proof for the node-redis (`redis`) adapter: the atomic Lua, carried by the official
 * node-redis client through {@link fromNodeRedis}, produces bit-identical decisions to the JS
 * executor — the same dual-path guarantee the ioredis conformance test makes, but exercising the
 * adapter's call translation against a live server. Gated on a real Redis (THROTTLEKIT_TEST_REDIS).
 *
 * Isolation: this file SHARES Redis DB 7 with test/twotier/weighted-fair-escrow-properties.test.ts.
 * There are 17 Redis-backed test files but only 16 logical DBs (stock Redis; CI's service container
 * can't be given more), so exactly one pair must co-tenant a DB. Co-tenancy is collision-safe here
 * because NEITHER file issues a DB-global FLUSHDB: every key below is namespaced under a unique
 * per-process RUN token (so even a fast re-run can't hit its own stale, not-yet-TTL'd keys), and
 * WFE's keys are unique per fast-check attempt. Do NOT add a flushDb() here, and do NOT move either
 * file onto a DB that another file flushes — that is exactly the cross-file flake this avoids.
 */

const url = process.env.THROTTLEKIT_TEST_REDIS;
const d = url ? describe : describe.skip;

// Unique per-process namespace so re-runs never collide with their own stale (not-yet-TTL'd) keys.
// This file shares Redis DB 7 with weighted-fair-escrow-properties.test.ts (see header) and so must
// NOT FLUSHDB; RUN-scoped keys make a flush unnecessary. Date.now()/Math.random() are fine here.
const RUN = `${Date.now().toString(36)}.${Math.floor(Math.random() * 0x7fffffff).toString(36)}`;

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
  { name: "tokenBucket-50cap-10rps", make: () => tokenBucket({ capacity: 50, refillPerSec: 10 }) },
  { name: "fixedWindow-50-1s", make: () => fixedWindow({ limit: 50, windowMs: 1000 }) },
  {
    name: "slidingWindow-50-1s-10buckets",
    make: () => slidingWindow({ limit: 50, windowMs: 1000, buckets: 10 }),
  },
];

const TIMELINES = 15;
const STEPS = 15;

d("node-redis adapter: dual-path conformance vs JS", () => {
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    client = createClient({ url: url as string, database: 7 });
    await client.connect();
    // No flushDb: DB 7 is shared (see file header). RUN-namespaced keys keep runs independent.
  });

  afterAll(async () => {
    await client?.quit();
  });

  for (const [ci, c] of cases.entries()) {
    it(`${c.name}: node-redis Lua matches JS across ${TIMELINES}×${STEPS} timelines`, async () => {
      const store = new RedisStore({ client: fromNodeRedis(client), useServerTime: false });
      for (let t = 0; t < TIMELINES; t++) {
        const rng = mulberry32(2000 + ci * 101 + t);
        const clock = new ManualClock(1_700_000_000_000 + t * 37);
        const js = rateLimit({
          strategy: c.make(),
          clock,
          store: new MemoryStore({ clock, sweepIntervalMs: 0 }),
        });
        const redis = rateLimit({ strategy: c.make(), clock, store });
        const key = `nr:${RUN}:${c.name}:${t}`;

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
