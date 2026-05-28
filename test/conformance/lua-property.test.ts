import fc from "fast-check";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { gcra } from "../../src/algorithms/gcra";
import { quota } from "../../src/algorithms/quota";
import { slidingWindow } from "../../src/algorithms/sliding-window";
import { slidingWindowLog } from "../../src/algorithms/sliding-window-log";
import { tokenBucket } from "../../src/algorithms/token-bucket";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";
import type { Strategy } from "../../src/core/types";
import { RedisStore } from "../../src/redis/store";
import { MemoryStore } from "../../src/stores/memory";

/**
 * Property-based dual-path proof: fast-check generates (deltaMs, cost) timelines, drives them
 * through both the JS executor (MemoryStore) and the atomic Redis Lua executor (RedisStore), and
 * asserts bit-identical Decision streams. fast-check shrinks any failure to a minimal `(start,
 * steps)` pair and prints it alongside the Redis key, so divergences come with a 1-line repro.
 *
 * Complements (not replaces) the fixed seeded grid in {@link ./conformance.test.ts}: the grid pins
 * 18 specific cases × 40×25 deterministic timelines plus the post-timeline non-consuming peek;
 * this file explores a much larger input space with shrinkable arbitraries, focused on the
 * consuming `check` path. Peek/readState bit-identity is exhaustively covered by the grid — we
 * deliberately don't repeat it here, because the strategies' Lua sets `PEXPIRE = resetAt - now`
 * (a tight memory optimization), and an awaited peek after the timeline can lose to wall-clock
 * elapse while the ManualClock stays put. That race is purely a ManualClock-vs-real-Redis test
 * artifact: in production wall clock IS the limiter clock, so an expired key after `resetAt` is
 * indistinguishable from a fresh window, which is the correct outcome.
 *
 * Gated on THROTTLEKIT_TEST_REDIS, exactly like the grid.
 */

const url = process.env.THROTTLEKIT_TEST_REDIS;
const d = url ? describe : describe.skip;

interface Case {
  name: string;
  make: () => Strategy;
}

/** One representative configuration per Lua-backed strategy; small limits drive admit + deny mixes. */
const cases: Case[] = [
  { name: "gcra", make: () => gcra({ limit: 10, periodMs: 1000, burst: 5 }) },
  { name: "tokenBucket", make: () => tokenBucket({ capacity: 8, refillPerSec: 4 }) },
  { name: "fixedWindow", make: () => fixedWindow({ limit: 6, windowMs: 500 }) },
  {
    name: "slidingWindow",
    make: () => slidingWindow({ limit: 12, windowMs: 1000, buckets: 4 }),
  },
  { name: "slidingWindowLog", make: () => slidingWindowLog({ limit: 6, windowMs: 1000 }) },
  {
    name: "quota-fixed",
    make: () => quota({ limit: 8, resetCadence: "fixed", periodMs: 1000, anchor: 250 }),
  },
];

/** A generated timeline step: how far to advance the clock, then a request of this cost. */
interface Step {
  deltaMs: number;
  cost: number;
}

/**
 * The timeline arbitrary. Deltas span 0..3000 ms — wide enough that quota/fixedWindow boundaries
 * are crossed often and gcra/tokenBucket buckets both refill and drain across a run. Costs stay
 * small (1..4) so admit/deny mix is dense rather than dominated by a few giant requests.
 */
const timeline: fc.Arbitrary<Step[]> = fc.array(
  fc.record({
    deltaMs: fc.integer({ min: 0, max: 3000 }),
    cost: fc.integer({ min: 1, max: 4 }),
  }),
  { minLength: 1, maxLength: 30 },
);

/**
 * 50 random timelines × 6 strategies = 300 attempts per CI run. Each attempt is up to 30 Redis
 * round trips; with our local Redis the whole file completes in ~3s, well inside the test budget,
 * and over many CI runs fast-check sweeps a much wider input space than the seeded grid pins.
 */
const NUM_RUNS = 50;

d("dual-path conformance (property-based, JS vs Redis Lua)", () => {
  let client: Redis;
  // Unique key suffix per property attempt — avoids cross-attempt state pollution without a FLUSHDB
  // per run (which would dominate the test budget). Counter is module-local; reset between cases.
  let attempt = 0;

  beforeAll(async () => {
    // Dedicated DB 2 — the seeded grid (test/conformance/conformance.test.ts)
    // also lives on DB 0 with flushdb on setup, and under parallel test
    // execution that flushdb would wipe our keys mid-property-attempt.
    // DB 2 is dedicated to this file (TK-1009 release-cycle fix).
    client = new Redis(url as string, { maxRetriesPerRequest: 2, lazyConnect: false, db: 2 });
    await client.flushdb();
  });

  afterAll(async () => {
    await client?.quit();
  });

  // Generous per-test timeout: a single property attempt is fast (~30 ms), but fast-check's shrink
  // loop on a near-failure can multiply that — and quota's Lua (embedded civil-calendar math) is the
  // slowest per round trip. 30 s gives margin for noisy CI without ever masking a real divergence.
  const PER_TEST_TIMEOUT_MS = 30_000;
  for (const c of cases) {
    it(
      `${c.name}: JS and Lua agree on shrinkable timelines`,
      async () => {
        attempt = 0;
        await fc.assert(
          fc.asyncProperty(
            fc.integer({ min: 1_700_000_000_000, max: 1_700_000_010_000 }),
            timeline,
            async (start, steps) => {
              attempt += 1;
              const clock = new ManualClock(start);
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
              const key = `prop:${c.name}:${attempt}`;

              for (let s = 0; s < steps.length; s++) {
                const step = steps[s] as Step;
                clock.advance(step.deltaMs);
                const dJs = await js.check(key, step.cost);
                const dRedis = await redis.check(key, step.cost);
                expect(
                  dRedis,
                  `${c.name} attempt=${attempt} step=${s} now=${clock.now()} cost=${step.cost} key=${key}`,
                ).toEqual(dJs);
              }
            },
          ),
          // On failure fast-check shrinks to a minimal `(start, steps)` pair and prints both — the
          // attempt counter + key in each `expect` message let you reproduce the exact Redis state.
          { numRuns: NUM_RUNS, verbose: 2 },
        );
      },
      PER_TEST_TIMEOUT_MS,
    );
  }
});
