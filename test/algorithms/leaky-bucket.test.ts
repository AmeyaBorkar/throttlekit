import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QueueFullError, leakyBucket } from "../../src/algorithms/leaky-bucket";
import { ManualClock } from "../../src/core/clock";
import { RedisStore } from "../../src/redis/store";
import { MemoryStore } from "../../src/stores/memory";

function shaper(ratePerSec: number, maxQueueMs: number) {
  const clock = new ManualClock(0);
  const s = leakyBucket({ ratePerSec, maxQueueMs, clock, store: new MemoryStore({ clock }) });
  return { s, clock };
}

describe("leakyBucket (shaper)", () => {
  it("validates options", () => {
    expect(() => leakyBucket({ ratePerSec: 0, maxQueueMs: 1000 })).toThrow(RangeError);
    expect(() => leakyBucket({ ratePerSec: 10, maxQueueMs: -1 })).toThrow(RangeError);
  });

  it("paces accepted requests at the drain rate", () => {
    const { s } = shaper(10, 10_000); // T = 100ms
    expect(s.reserveSync("k")).toEqual({ accepted: true, delayMs: 0 });
    expect(s.reserveSync("k")).toEqual({ accepted: true, delayMs: 100 });
    expect(s.reserveSync("k")).toEqual({ accepted: true, delayMs: 200 });
  });

  it("rejects when the wait would exceed maxQueueMs", () => {
    const { s } = shaper(10, 150); // T = 100ms
    expect(s.reserveSync("k").accepted).toBe(true); // delay 0 -> nd 100
    expect(s.reserveSync("k").accepted).toBe(true); // delay 100 <= 150 -> nd 200
    const r = s.reserveSync("k"); // delay 200 > 150
    expect(r.accepted).toBe(false);
    expect(r.delayMs).toBe(50); // 200 - 150
  });

  it("drains as time advances", () => {
    const { s, clock } = shaper(10, 1000);
    s.reserveSync("k"); // nd 100
    s.reserveSync("k"); // nd 200
    clock.advance(200); // queue fully drained
    expect(s.reserveSync("k")).toEqual({ accepted: true, delayMs: 0 });
  });

  it("reserves multiple slots for cost > 1", () => {
    const { s } = shaper(10, 10_000);
    expect(s.reserveSync("k", 3).delayMs).toBe(0); // consumes 3 slots -> nd 300
    expect(s.reserveSync("k", 1).delayMs).toBe(300);
  });

  it("schedule resolves immediately at delay 0 and rejects when full", async () => {
    const { s } = shaper(1, 0); // T = 1000ms, no queue allowed
    await expect(s.schedule("k")).resolves.toBeUndefined(); // delay 0
    await expect(s.schedule("k")).rejects.toBeInstanceOf(QueueFullError); // delay 1000 > 0
  });
});

// Dual-path conformance for the shaper, gated on a real Redis.
const url = process.env.THROTTLEKIT_TEST_REDIS;
const dRedis = url ? describe : describe.skip;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

dRedis("leakyBucket dual-path conformance (JS vs Redis Lua)", () => {
  let client: Redis;
  beforeAll(async () => {
    // Use a dedicated Redis DB so this file's FLUSHDB can't clobber the conformance suite,
    // which Vitest may run in parallel against the same server.
    client = new Redis(url as string, { maxRetriesPerRequest: 2, db: 1 });
    await client.flushdb();
  });
  afterAll(async () => {
    await client?.quit();
  });

  it("JS and Lua agree on accept/delay across timelines", async () => {
    for (let t = 0; t < 30; t++) {
      const rng = mulberry32(7000 + t);
      const clock = new ManualClock(1_700_000_000_000 + t * 13);
      const js = leakyBucket({
        ratePerSec: 7,
        maxQueueMs: 1500,
        clock,
        store: new MemoryStore({ clock, sweepIntervalMs: 0 }),
      });
      const redis = leakyBucket({
        ratePerSec: 7,
        maxQueueMs: 1500,
        clock,
        store: new RedisStore({ client, useServerTime: false }),
      });
      const key = `leaky:${t}`;
      for (let step = 0; step < 25; step++) {
        clock.advance(Math.floor(rng() * 400));
        const cost = 1 + Math.floor(rng() * 3);
        const a = await js.reserve(key, cost);
        const b = await redis.reserve(key, cost);
        expect(b, `timeline ${t} step ${step}`).toEqual(a);
      }
    }
  });
});
