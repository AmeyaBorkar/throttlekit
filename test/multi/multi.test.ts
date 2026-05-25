import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { gcra } from "../../src/algorithms/gcra";
import { tokenBucket } from "../../src/algorithms/token-bucket";
import { ManualClock } from "../../src/core/clock";
import type { MultiStrategy } from "../../src/multi";
import { all, any, multiRateLimit } from "../../src/multi";
import { RedisStore } from "../../src/redis/store";
import { MemoryStore } from "../../src/stores/memory";

interface Ctx {
  ip: string;
  user: string;
}

describe("multiRateLimit", () => {
  it("all(): denies if any dimension denies, with no partial consume", async () => {
    const clock = new ManualClock(0);
    const limiter = multiRateLimit<Ctx>({
      clock,
      store: new MemoryStore({ clock }),
      strategy: all({
        ip: { key: (c) => c.ip, strategy: gcra({ limit: 5, periodMs: 1000 }) },
        user: { key: (c) => c.user, strategy: gcra({ limit: 1, periodMs: 1000 }) },
      }),
    });
    // 1st: both allow (ip burst 5, user burst 1). Consumes ip=1, user=1.
    expect((await limiter.check({ ip: "A", user: "u1" })).allowed).toBe(true);
    // 2nd same ctx: user is exhausted ⇒ deny. The ip dimension MUST NOT be consumed.
    expect((await limiter.check({ ip: "A", user: "u1" })).allowed).toBe(false);
    // Prove ip kept its budget: 4 more fresh-user requests succeed (ip 1+4=5), the 5th fails.
    for (let i = 0; i < 4; i++) {
      expect((await limiter.check({ ip: "A", user: `f${i}` })).allowed).toBe(true);
    }
    expect((await limiter.check({ ip: "A", user: "f9" })).allowed).toBe(false); // ip now exhausted
  });

  it("any(): allows if any dimension allows", async () => {
    const clock = new ManualClock(0);
    const limiter = multiRateLimit<Ctx>({
      clock,
      store: new MemoryStore({ clock }),
      strategy: any({
        ip: { key: (c) => c.ip, strategy: gcra({ limit: 1, periodMs: 1000 }) },
        user: { key: (c) => c.user, strategy: gcra({ limit: 3, periodMs: 1000 }) },
      }),
    });
    const ctx = { ip: "A", user: "u1" };
    expect((await limiter.check(ctx)).allowed).toBe(true); // both ok
    // ip is now exhausted, but user still has budget ⇒ any() still allows.
    expect((await limiter.check(ctx)).allowed).toBe(true);
    expect((await limiter.check(ctx)).allowed).toBe(true);
  });

  it("returns the binding decision (tightest remaining) when all allow", async () => {
    const clock = new ManualClock(0);
    const limiter = multiRateLimit<Ctx>({
      clock,
      store: new MemoryStore({ clock }),
      strategy: all({
        ip: { key: (c) => c.ip, strategy: gcra({ limit: 100, periodMs: 60_000 }) },
        user: { key: (c) => c.user, strategy: fixedWindow({ limit: 3, windowMs: 1000 }) },
      }),
    });
    const d = await limiter.check({ ip: "A", user: "u1" });
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(2); // bound by the user dimension (3 - 1), not ip (99)
  });

  it("supports weighted per-dimension cost", async () => {
    const clock = new ManualClock(0);
    const limiter = multiRateLimit<Ctx>({
      clock,
      store: new MemoryStore({ clock }),
      strategy: all({
        ip: {
          key: (c) => c.ip,
          strategy: fixedWindow({ limit: 10, windowMs: 1000 }),
          cost: () => 5,
        },
        user: { key: (c) => c.user, strategy: fixedWindow({ limit: 10, windowMs: 1000 }) },
      }),
    });
    expect((await limiter.check({ ip: "A", user: "u1" })).allowed).toBe(true); // ip 5, user 1
    expect((await limiter.check({ ip: "A", user: "u1" })).allowed).toBe(true); // ip 10, user 2
    expect((await limiter.check({ ip: "A", user: "u1" })).allowed).toBe(false); // ip would be 15 > 10
  });

  it("checkSync works on a synchronous store", () => {
    const clock = new ManualClock(0);
    const limiter = multiRateLimit<Ctx>({
      clock,
      store: new MemoryStore({ clock }),
      strategy: all({
        ip: { key: (c) => c.ip, strategy: gcra({ limit: 1, periodMs: 1000 }) },
      }),
    });
    expect(limiter.checkSync({ ip: "A", user: "u" }).allowed).toBe(true);
    expect(limiter.checkSync({ ip: "A", user: "u" }).allowed).toBe(false);
  });
});

// Dual-path conformance: memory composite vs Redis fused Lua.
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

dRedis("multiRateLimit dual-path conformance (memory vs Redis fused Lua)", () => {
  let client: Redis;
  beforeAll(async () => {
    client = new Redis(url as string, { maxRetriesPerRequest: 2, db: 5 });
    await client.flushdb();
  });
  afterAll(async () => {
    await client?.quit();
  });

  const build = (): MultiStrategy<Ctx> =>
    all({
      ip: { key: (c) => c.ip, strategy: gcra({ limit: 20, periodMs: 10_000, burst: 8 }) },
      user: { key: (c) => c.user, strategy: tokenBucket({ capacity: 15, refillPerSec: 5 }) },
      route: { key: () => "r", strategy: fixedWindow({ limit: 30, windowMs: 1000 }) },
    });

  for (const mode of ["all", "any"] as const) {
    it(`${mode}: memory and Redis agree across timelines`, async () => {
      for (let t = 0; t < 25; t++) {
        const rng = mulberry32(9000 + t + (mode === "any" ? 500 : 0));
        const clock = new ManualClock(1_700_000_000_000 + t * 17);
        const strat =
          mode === "all" ? build() : { mode: "any" as const, dimensions: build().dimensions };
        const mem = multiRateLimit<Ctx>({
          strategy: strat,
          clock,
          store: new MemoryStore({ clock, sweepIntervalMs: 0 }),
        });
        const red = multiRateLimit<Ctx>({
          strategy: strat,
          clock,
          store: new RedisStore({ client, useServerTime: false }),
        });
        const ctx: Ctx = { ip: `ip${t}`, user: `u${t}` };
        for (let s = 0; s < 25; s++) {
          clock.advance(Math.floor(rng() * 300));
          const cost = 1 + Math.floor(rng() * 3);
          const a = await mem.check(ctx, cost);
          const b = await red.check(ctx, cost);
          expect(b, `${mode} timeline ${t} step ${s}`).toEqual(a);
        }
      }
    });
  }
});
