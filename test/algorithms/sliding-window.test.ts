import { describe, expect, it } from "vitest";
import { slidingWindow } from "../../src/algorithms/sliding-window";
import type { Decision } from "../../src/core/types";

function driver(strategy: ReturnType<typeof slidingWindow>) {
  let state: Record<number, number> | undefined;
  return (now: number, cost = 1): Decision => {
    const r = strategy.check(state, now, cost);
    if (r.persist) state = r.state;
    return r.result;
  };
}

describe("slidingWindow (sub-bucketed)", () => {
  it("validates options", () => {
    expect(() => slidingWindow({ limit: 0, windowMs: 1000 })).toThrow(RangeError);
    expect(() => slidingWindow({ limit: 10, windowMs: 1000, buckets: 0 })).toThrow(RangeError);
    expect(() => slidingWindow({ limit: 10, windowMs: 1000, buckets: 2.5 })).toThrow(RangeError);
  });

  it("admits `limit` in a burst, denies the next", () => {
    const step = driver(slidingWindow({ limit: 10, windowMs: 1000, buckets: 10 }));
    for (let i = 0; i < 10; i++) expect(step(0).allowed).toBe(true);
    expect(step(0).allowed).toBe(false);
  });

  it("does NOT double across a window boundary (unlike fixed window)", () => {
    const step = driver(slidingWindow({ limit: 10, windowMs: 1000, buckets: 10 }));
    for (let i = 0; i < 10; i++) step(900 + i); // 10 requests in bucket 9
    expect(step(1000).allowed).toBe(false); // those 10 are still within the trailing window
    expect(step(2000).allowed).toBe(true); // now fully aged out
  });

  it("decays weight smoothly within the single-previous-window model (buckets:1)", () => {
    const step = driver(slidingWindow({ limit: 10, windowMs: 1000, buckets: 1 }));
    for (let i = 0; i < 10; i++) step(0); // fill previous window
    expect(step(1000).allowed).toBe(false); // weight 1.0 => estimate 10
    // at t=1500 the previous window weighs 0.5 => estimate 5 => room for ~5 more
    expect(step(1500).allowed).toBe(true);
    expect(step(1500).remaining).toBeGreaterThanOrEqual(0);
  });

  it("handles cost > 1", () => {
    const step = driver(slidingWindow({ limit: 10, windowMs: 1000, buckets: 10 }));
    expect(step(0, 7).allowed).toBe(true);
    expect(step(0, 4).allowed).toBe(false); // 7 + 4 > 10
    expect(step(0, 3).allowed).toBe(true); // exactly fills
  });

  it("produces integer-valued decision fields (allow and deny)", () => {
    const step = driver(slidingWindow({ limit: 20, windowMs: 1000, buckets: 3 })); // fractional w
    step(0, 20);
    const allow = step(50, 1);
    const deny = step(50, 5);
    for (const d of [allow, deny]) {
      for (const v of [d.limit, d.remaining, d.resetAt, d.retryAfterMs]) {
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });

  it("exposes an atomic Lua program", () => {
    const s = slidingWindow({ limit: 50, windowMs: 1000, buckets: 10 });
    expect(s.lua?.buildArgv(50, 2)).toEqual([50, 1000, 50, 2, 10]);
    expect(s.lua?.script).toContain("HGET");
  });
});
