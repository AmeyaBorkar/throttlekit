import Redis from "ioredis";
import { afterAll, beforeAll } from "vitest";
import { ManualClock } from "../../src/core/clock";
import { RedisStore } from "../../src/redis/store";
import { MemoryStore } from "../../src/stores/memory";
import { runStoreConformance } from "../../src/testkit";

/**
 * Run the reusable store-conformance suite against the in-process store, then (gated on a real
 * Redis via THROTTLEKIT_TEST_REDIS) against the Redis store — proving both backends honor the same
 * atomic-RMW contract the limiter depends on.
 */

// MemoryStore: a controllable clock makes time-travel (and thus the TTL test) deterministic.
runStoreConformance("MemoryStore", () => {
  const clock = new ManualClock(0);
  const store = new MemoryStore({ clock, sweepIntervalMs: 0 });
  return {
    store,
    advance: (ms) => clock.advance(ms),
    teardown: () => store.close(),
  };
});

const url = process.env.THROTTLEKIT_TEST_REDIS;

if (url !== undefined) {
  // A single shared client over a dedicated DB (3) so this file's FLUSHDB can't disturb the
  // other Redis-using suites, which pin their own DBs.
  const client = new Redis(url, { db: 3 });

  beforeAll(async () => {
    await client.flushdb();
  });

  afterAll(async () => {
    await client.quit();
  });

  runStoreConformance("RedisStore", async () => {
    // Fresh context = clean key space: the in-memory store gets a brand-new map each test, so the
    // Redis analogue is to FLUSHDB the dedicated DB before each test. (DB 3 is ours alone.)
    await client.flushdb();
    // useServerTime: false makes resetAt deterministic, but the server clock still cannot be
    // advanced from the test — so time-travel is unsupported and the TTL test is skipped. The
    // testkit's counter ships an atomic Lua form, so apply() takes the single-round-trip EVALSHA
    // path (INCR), which is what proves Redis-side atomicity under the 200-way concurrent test.
    const store = new RedisStore({ client, useServerTime: false });
    return {
      store,
      advance: () => {},
      supportsTimeTravel: false,
    };
  });
}
