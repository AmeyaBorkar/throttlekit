import { describe, expect, it, vi } from "vitest";
import { gcra } from "../../src/algorithms/gcra";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";
import type { Store } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";

describe("rateLimit", () => {
  it("reproduces the determinism example from the design doc", async () => {
    const clock = new ManualClock(0);
    const limiter = rateLimit({
      strategy: gcra({ limit: 2, periodMs: 1000 }),
      clock,
      store: new MemoryStore({ clock }),
    });

    expect((await limiter.check("k")).allowed).toBe(true);
    expect((await limiter.check("k")).allowed).toBe(true);
    expect((await limiter.check("k")).allowed).toBe(false); // burst exhausted
    clock.advance(500);
    expect((await limiter.check("k")).allowed).toBe(true); // one emission interval later
  });

  it("defaults to an in-process MemoryStore and cost 1", async () => {
    const limiter = rateLimit({ strategy: gcra({ limit: 1, periodMs: 1000 }) });
    expect((await limiter.check("a")).allowed).toBe(true);
    expect((await limiter.check("a")).allowed).toBe(false);
    expect((await limiter.check("b")).allowed).toBe(true); // independent key
  });

  it("checkSync and check agree decision-for-decision", async () => {
    const build = () => {
      const clock = new ManualClock(0);
      return {
        clock,
        limiter: rateLimit({
          strategy: gcra({ limit: 5, periodMs: 1000 }),
          clock,
          store: new MemoryStore({ clock }),
        }),
      };
    };
    const sync = build();
    const async = build();
    for (let i = 0; i < 10; i++) {
      const s = sync.limiter.checkSync("k");
      const a = await async.limiter.check("k");
      expect(s).toEqual(a);
      sync.clock.advance(120);
      async.clock.advance(120);
    }
  });

  it("isolates keys by prefix", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock });
    const api = rateLimit({
      strategy: gcra({ limit: 1, periodMs: 1000 }),
      clock,
      store,
      prefix: "api",
    });
    const web = rateLimit({
      strategy: gcra({ limit: 1, periodMs: 1000 }),
      clock,
      store,
      prefix: "web",
    });
    expect((await api.check("u1")).allowed).toBe(true);
    expect((await web.check("u1")).allowed).toBe(true); // different namespace, not blocked
    expect((await api.check("u1")).allowed).toBe(false);
  });

  it("reset clears a key's state", async () => {
    const clock = new ManualClock(0);
    const limiter = rateLimit({
      strategy: gcra({ limit: 1, periodMs: 1000 }),
      clock,
      store: new MemoryStore({ clock }),
    });
    expect((await limiter.check("k")).allowed).toBe(true);
    expect((await limiter.check("k")).allowed).toBe(false);
    await limiter.reset("k");
    expect((await limiter.check("k")).allowed).toBe(true);
  });

  it("rejects invalid cost", async () => {
    const limiter = rateLimit({ strategy: gcra({ limit: 10, periodMs: 1000 }) });
    await expect(limiter.check("k", 0)).rejects.toThrow(RangeError);
    await expect(limiter.check("k", -1)).rejects.toThrow(RangeError);
    expect(() => limiter.checkSync("k", Number.NaN)).toThrow(RangeError);
  });

  it("checkSync throws on an async-only store", () => {
    const asyncOnly: Store = {
      apply: vi.fn(async () => ({}) as never),
      reset: vi.fn(async () => {}),
    };
    const limiter = rateLimit({ strategy: gcra({ limit: 10, periodMs: 1000 }), store: asyncOnly });
    expect(() => limiter.checkSync("k")).toThrow(/checkSync requires a synchronous store/);
  });

  it("exposes the active strategy", () => {
    const limiter = rateLimit({ strategy: gcra({ limit: 10, periodMs: 1000 }) });
    expect(limiter.strategy.name).toBe("gcra");
    expect(limiter.strategy.limit).toBe(10);
  });
});
