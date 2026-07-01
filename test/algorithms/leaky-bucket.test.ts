import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { QueueFullError, leakyBucket } from "../../src/algorithms/leaky-bucket";
import { ManualClock } from "../../src/core/clock";
import type { Store } from "../../src/core/types";
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

describe("leakyBucket (shaper) — async path + boundaries", () => {
  it("names the offending option in validation errors", () => {
    expect(() => leakyBucket({ ratePerSec: 0, maxQueueMs: 1000 })).toThrow(
      /leakyBucket\.ratePerSec/,
    );
    expect(() => leakyBucket({ ratePerSec: 10, maxQueueMs: -1 })).toThrow(
      /leakyBucket\.maxQueueMs/,
    );
  });

  it("works with the default in-process store when none is injected", () => {
    const clock = new ManualClock(0);
    const s = leakyBucket({ ratePerSec: 10, maxQueueMs: 10_000, clock }); // T = 100ms, default store
    expect(s.reserveSync("k")).toEqual({ accepted: true, delayMs: 0 });
    expect(s.reserveSync("k")).toEqual({ accepted: true, delayMs: 100 });
  });

  it("uses the injected store, not a fresh internal one", () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const a = leakyBucket({ ratePerSec: 10, maxQueueMs: 10_000, clock, store });
    const b = leakyBucket({ ratePerSec: 10, maxQueueMs: 10_000, clock, store });
    expect(a.reserveSync("k")).toEqual({ accepted: true, delayMs: 0 }); // nd 100 in the shared store
    // b shares the same store, so it must see a's reservation (delay 100), not start fresh.
    expect(b.reserveSync("k")).toEqual({ accepted: true, delayMs: 100 });
  });

  it("reserveSync rejects an async-only store (no applySync) with a clear error", () => {
    const asyncOnly: Store = {
      apply: () => Promise.reject(new Error("apply must not run in this test")),
      reset: () => Promise.resolve(),
    };
    const s = leakyBucket({ ratePerSec: 10, maxQueueMs: 1000, store: asyncOnly });
    expect(() => s.reserveSync("k")).toThrow(/requires a synchronous store/);
  });

  it("reset() forgets a key's queue position", async () => {
    const clock = new ManualClock(0);
    const s = leakyBucket({
      ratePerSec: 10,
      maxQueueMs: 10_000,
      clock,
      store: new MemoryStore({ clock }),
    });
    expect(s.reserveSync("k")).toEqual({ accepted: true, delayMs: 0 }); // nd 100
    expect(s.reserveSync("k")).toEqual({ accepted: true, delayMs: 100 }); // nd 200
    await s.reset("k");
    // The queue is empty again: the next reserve starts from scratch.
    expect(s.reserveSync("k")).toEqual({ accepted: true, delayMs: 0 });
  });

  // --- async reserve() drives makeTransform; the sync tests above only exercise syncTransform ---

  it("reserve() paces accepted requests and credits elapsed time", async () => {
    const clock = new ManualClock(0);
    const s = leakyBucket({
      ratePerSec: 10,
      maxQueueMs: 10_000,
      clock,
      store: new MemoryStore({ clock }),
    });
    expect(await s.reserve("k")).toEqual({ accepted: true, delayMs: 0 }); // nd 100
    expect(await s.reserve("k")).toEqual({ accepted: true, delayMs: 100 }); // nd 200
    clock.advance(50); // 50ms of the queued 200ms has now elapsed
    // departure 200, now 50 -> wait 150 (not 200); the "- now" term must subtract, not add.
    expect(await s.reserve("k")).toEqual({ accepted: true, delayMs: 150 });
  });

  it("reserve() rejects with the overflow hint once the wait exceeds maxQueueMs", async () => {
    const clock = new ManualClock(0);
    const s = leakyBucket({
      ratePerSec: 10,
      maxQueueMs: 150,
      clock,
      store: new MemoryStore({ clock }),
    });
    expect(await s.reserve("k")).toEqual({ accepted: true, delayMs: 0 }); // nd 100
    expect(await s.reserve("k")).toEqual({ accepted: true, delayMs: 100 }); // nd 200, 100 <= 150
    // departure 200 -> wait 200 > 150 -> reject; advisory = 200 - 150 = 50.
    expect(await s.reserve("k")).toEqual({ accepted: false, delayMs: 50 });
  });

  it("reserve() clamps a departure left in the past by a forward clock jump", async () => {
    // The store's own clock is frozen at 0 so the primed entry never lazily expires, while the
    // shaper's clock jumps forward past that stored departure. The guard must clamp to `now`
    // (delay 0), never emit a negative wait from `stored - now`.
    const storeClock = new ManualClock(0);
    const shaperClock = new ManualClock(0);
    const s = leakyBucket({
      ratePerSec: 10,
      maxQueueMs: 1000,
      clock: shaperClock,
      store: new MemoryStore({ clock: storeClock, sweepIntervalMs: 0 }),
    });
    expect(await s.reserve("k")).toEqual({ accepted: true, delayMs: 0 }); // departure primed at 100
    shaperClock.advance(300); // now 300, well past the stored departure 100
    expect(await s.reserve("k")).toEqual({ accepted: true, delayMs: 0 });
  });

  it("reserve() keeps a still-pending departure alive for its full delay (accept TTL floor)", async () => {
    // The accepted entry's TTL must cover the whole queued wait (max, not min): after 50ms of a
    // 100ms queue the departure is still 100, so the second reserve must see delay 50, not a
    // prematurely-expired fresh key (delay 0).
    const clock = new ManualClock(0);
    const s = leakyBucket({
      ratePerSec: 10,
      maxQueueMs: 1000,
      clock,
      store: new MemoryStore({ clock }),
    });
    expect(await s.reserve("k")).toEqual({ accepted: true, delayMs: 0 }); // nd 100, ttl 100
    clock.advance(50);
    expect(await s.reserve("k")).toEqual({ accepted: true, delayMs: 50 });
  });

  it("a rejected reserve does not re-persist state (leaves the earlier TTL intact)", async () => {
    // persist:false on the reject branch: the overflowing request must not rewrite the entry with
    // the (shorter) maxQueueMs TTL, which would expire the real departure early.
    const clock = new ManualClock(0);
    const s = leakyBucket({
      ratePerSec: 10,
      maxQueueMs: 150,
      clock,
      store: new MemoryStore({ clock }),
    });
    await s.reserve("k"); // nd 100, exp 100
    await s.reserve("k"); // nd 200, exp 200
    // reject; must NOT rewrite the entry with exp = now + 150 = 150.
    expect(await s.reserve("k")).toEqual({ accepted: false, delayMs: 50 });
    clock.advance(170); // now 170: with the intact exp 200 the entry is still live
    // departure 200, now 170 -> wait 30. A re-persisted (exp 150) entry would have expired -> delay 0.
    expect(await s.reserve("k")).toEqual({ accepted: true, delayMs: 30 });
  });

  it("schedule() carries the queue_full code, name, message and retry hint", async () => {
    const clock = new ManualClock(0);
    const s = leakyBucket({
      ratePerSec: 10,
      maxQueueMs: 150,
      clock,
      store: new MemoryStore({ clock }),
    });
    await s.reserve("k"); // nd 100
    await s.reserve("k"); // nd 200
    let caught: unknown;
    try {
      await s.schedule("k"); // wait 200 > 150 -> throws before sleeping
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QueueFullError);
    const err = caught as QueueFullError;
    expect(err.name).toBe("QueueFullError");
    expect(err.code).toBe("queue_full");
    expect(err.retryAfterMs).toBe(50);
    expect(err.message).toBe("leaky-bucket queue is full; retry after 50ms");
  });

  it("schedule() waits a sub-ceiling delay on a real timer", async () => {
    vi.useFakeTimers();
    try {
      const clock = new ManualClock(0);
      const store = new MemoryStore({ clock, sweepIntervalMs: 0 });
      const s = leakyBucket({ ratePerSec: 10, maxQueueMs: 10_000, clock, store }); // T = 100ms
      await s.reserve("k"); // first slot, delay 0
      let done = false;
      const p = s.schedule("k").then(() => {
        done = true;
      }); // second slot: paced delay 100ms -> the simple setTimeout branch
      await vi.advanceTimersByTimeAsync(99);
      expect(done).toBe(false); // the Promise executor really scheduled a timer; it has not fired yet
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedule() resolves a zero delay on the microtask queue (no timer)", async () => {
    vi.useFakeTimers();
    try {
      const clock = new ManualClock(0);
      const store = new MemoryStore({ clock, sweepIntervalMs: 0 });
      const s = leakyBucket({ ratePerSec: 10, maxQueueMs: 10_000, clock, store });
      let done = false;
      // First slot -> delay 0 -> sleep(0) returns an already-resolved promise (no timer).
      s.schedule("k").then(() => {
        done = true;
      });
      // Drain only the microtask queue; do NOT advance timers. The zero-delay fast path resolves
      // here, whereas a setTimeout(_, 0) fallback would still be pending.
      for (let i = 0; i < 12; i++) {
        await Promise.resolve();
      }
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
