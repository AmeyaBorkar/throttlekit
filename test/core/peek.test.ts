import { describe, expect, it } from "vitest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { gcra } from "../../src/algorithms/gcra";
import { quota } from "../../src/algorithms/quota";
import { slidingWindow } from "../../src/algorithms/sliding-window";
import { slidingWindowLog } from "../../src/algorithms/sliding-window-log";
import { tokenBucket } from "../../src/algorithms/token-bucket";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";
import type {
  ApplyOutcome,
  Decision,
  Limiter,
  Store,
  Strategy,
  Transform,
} from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";

function mustPeekSync(l: Limiter, key: string): Decision {
  const fn = l.peekSync;
  if (fn === undefined) throw new Error("peekSync expected to be defined");
  return fn(key);
}

function make(strategy: Strategy, clock: ManualClock): Limiter {
  return rateLimit({ strategy, clock, store: new MemoryStore({ clock, sweepIntervalMs: 0 }) });
}

const strategies: { name: string; make: () => Strategy; limit: number }[] = [
  { name: "gcra", make: () => gcra({ limit: 5, periodMs: 1000 }), limit: 5 },
  { name: "tokenBucket", make: () => tokenBucket({ capacity: 5, refillPerSec: 1 }), limit: 5 },
  { name: "fixedWindow", make: () => fixedWindow({ limit: 5, windowMs: 1000 }), limit: 5 },
  { name: "slidingWindow", make: () => slidingWindow({ limit: 5, windowMs: 1000 }), limit: 5 },
  {
    name: "slidingWindowLog",
    make: () => slidingWindowLog({ limit: 5, windowMs: 1000 }),
    limit: 5,
  },
  { name: "quota", make: () => quota({ limit: 5, resetCadence: "calendar-month" }), limit: 5 },
];

describe("peek (non-consuming introspection)", () => {
  for (const s of strategies) {
    describe(s.name, () => {
      it("reports full capacity on a fresh key and never consumes", () => {
        const clock = new ManualClock(1_700_000_000_000);
        const limiter = make(s.make(), clock);
        const fresh = mustPeekSync(limiter, "k");
        expect(fresh.allowed).toBe(true);
        expect(fresh.remaining).toBe(s.limit);
        // Peeking is idempotent: a second peek (and a third) see the same untouched state.
        expect(mustPeekSync(limiter, "k")).toEqual(fresh);
        expect(mustPeekSync(limiter, "k")).toEqual(fresh);
        // ...and an actual check still sees full capacity, proving the peeks consumed nothing.
        expect(limiter.checkSync("k").remaining).toBe(s.limit - 1);
      });

      it("tracks remaining as capacity is spent, and a peek between checks doesn't shift it", () => {
        const clock = new ManualClock(1_700_000_000_000);
        const limiter = make(s.make(), clock);
        limiter.checkSync("k"); // consume 1
        limiter.checkSync("k"); // consume 1 (total 2)
        const p = mustPeekSync(limiter, "k");
        expect(p.allowed).toBe(true);
        expect(p.remaining).toBe(s.limit - 2);
        // The next allowed check sees remaining one lower than the peek — peek added nothing.
        const d = limiter.checkSync("k");
        expect(d.allowed).toBe(true);
        expect(d.remaining).toBe(p.remaining - 1);
      });

      it("reports allowed:false with a positive retry once exhausted", () => {
        const clock = new ManualClock(1_700_000_000_000);
        const limiter = make(s.make(), clock);
        for (let i = 0; i < s.limit; i++) expect(limiter.checkSync("k").allowed).toBe(true);
        const p = mustPeekSync(limiter, "k");
        expect(p.allowed).toBe(false);
        expect(p.remaining).toBe(0);
        expect(p.retryAfterMs).toBeGreaterThan(0);
        expect(p.resetAt).toBeGreaterThan(clock.now());
        // Still non-consuming when blocked: a denied check matches the peek's remaining.
        expect(limiter.checkSync("k").allowed).toBe(false);
        expect(mustPeekSync(limiter, "k").remaining).toBe(0);
      });

      it("async peek() resolves to the same decision as peekSync()", async () => {
        const clock = new ManualClock(1_700_000_000_000);
        const limiter = make(s.make(), clock);
        limiter.checkSync("k");
        const sync = mustPeekSync(limiter, "k");
        const fn = limiter.peek;
        if (fn === undefined) throw new Error("peek expected");
        expect(await fn("k")).toEqual(sync);
      });
    });
  }

  it("async peek() works over an async-only store (read-only apply, no persist)", async () => {
    // A minimal async-only store backed by an in-memory map, exercising the non-Lua read path.
    const clock = new ManualClock(1_700_000_000_000);
    const map = new Map<string, unknown>();
    const store: Store = {
      async apply<S, R>(key: string, t: Transform<S, R>): Promise<R> {
        const out: ApplyOutcome<S, R> = t(map.get(key) as S | undefined);
        if (out.persist) map.set(key, out.state);
        return out.result;
      },
      async reset(key: string): Promise<void> {
        map.delete(key);
      },
    };
    const limiter = rateLimit({
      strategy: fixedWindow({ limit: 3, windowMs: 1000 }),
      clock,
      store,
    });
    expect(() => mustPeekSync(limiter, "k")).toThrow(/synchronous store/);
    const fn = limiter.peek;
    if (fn === undefined) throw new Error("peek expected");
    await limiter.check("k"); // consume 1
    const p = await fn("k");
    expect(p.remaining).toBe(2);
    // Peek didn't write: the window count is still 1, so the next check yields remaining 1.
    expect((await limiter.check("k")).remaining).toBe(1);
  });

  it("rejects/throws when the strategy doesn't implement peek", async () => {
    const noPeek: Strategy<number> = {
      name: "noPeek",
      limit: 1,
      ttlMs: 1,
      check: (state, _now, _cost) => ({
        state,
        result: { allowed: true, limit: 1, remaining: 0, resetAt: 0, retryAfterMs: 0 },
        ttlMs: 1,
        persist: false,
      }),
    };
    const limiter = rateLimit({ strategy: noPeek, store: new MemoryStore({ sweepIntervalMs: 0 }) });
    expect(() => mustPeekSync(limiter, "k")).toThrow(/not supported/);
    const fn = limiter.peek;
    if (fn === undefined) throw new Error("peek expected");
    await expect(fn("k")).rejects.toThrow(/not supported/);
  });
});
