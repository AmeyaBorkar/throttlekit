import { describe, expect, it } from "vitest";
import { slidingWindowLog } from "../../src/algorithms/sliding-window-log";
import type { Decision } from "../../src/core/types";

function driver(strategy: ReturnType<typeof slidingWindowLog>) {
  let state: number[] | undefined;
  return (now: number, cost = 1): Decision => {
    const r = strategy.check(state, now, cost);
    if (r.persist) state = r.state;
    return r.result;
  };
}

describe("slidingWindowLog", () => {
  it("validates options", () => {
    expect(() => slidingWindowLog({ limit: 0, windowMs: 1000 })).toThrow(RangeError);
    expect(() => slidingWindowLog({ limit: 5, windowMs: -1 })).toThrow(RangeError);
  });

  it("allows exactly `limit` within the window, then denies with exact retryAfter", () => {
    const step = driver(slidingWindowLog({ limit: 3, windowMs: 1000 }));
    expect(step(0)).toMatchObject({ allowed: true, remaining: 2 });
    expect(step(100)).toMatchObject({ allowed: true, remaining: 1 });
    expect(step(200)).toMatchObject({ allowed: true, remaining: 0 });
    const d = step(300);
    expect(d.allowed).toBe(false);
    expect(d.remaining).toBe(0);
    // oldest hit at t=0 leaves the window at t=1000 => retry = 1000 - 300
    expect(d.retryAfterMs).toBe(700);
    expect(d.resetAt).toBe(1000);
  });

  it("frees a slot exactly when the oldest hit exits the trailing window", () => {
    const step = driver(slidingWindowLog({ limit: 2, windowMs: 1000 }));
    step(0);
    step(500);
    expect(step(999).allowed).toBe(false); // both still in (ts > -1)
    expect(step(999).retryAfterMs).toBe(1); // hit@0 exits at 1000
    expect(step(1000).allowed).toBe(true); // hit@0 now excluded (ts > 0), room for one
  });

  it("is exact under bursty arrivals (no boundary doubling)", () => {
    const step = driver(slidingWindowLog({ limit: 5, windowMs: 1000 }));
    for (let i = 0; i < 5; i++) expect(step(950 + i).allowed).toBe(true); // 5 near the end
    expect(step(1000).allowed).toBe(false); // 1001? still 5 in (950..954 > 0) -> denied
    // unlike fixed window, you cannot get 2x across the boundary
  });

  it("handles cost > 1 and reports remaining", () => {
    const step = driver(slidingWindowLog({ limit: 10, windowMs: 1000 }));
    expect(step(0, 4)).toMatchObject({ allowed: true, remaining: 6 });
    expect(step(0, 6)).toMatchObject({ allowed: true, remaining: 0 });
    expect(step(0, 1).allowed).toBe(false);
  });

  it("produces integer-valued decision fields", () => {
    const step = driver(slidingWindowLog({ limit: 3, windowMs: 777 }));
    step(0);
    const d = step(13);
    for (const v of [d.limit, d.remaining, d.resetAt, d.retryAfterMs]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("charges a fractional cost as whole units (ceil) — integer remaining + integer state", () => {
    // Regression: the check() append loop persisted ceil(cost) stamps but reported a non-integer
    // remaining (limit - (count + cost)), which leaked into the RFC RateLimit-* headers; and the raw
    // cost made the JS loop and the Lua `for i=1,cost` loop persist a DIFFERENT number of stamps,
    // splitting MemoryStore vs Redis state. Now both charge ceil(cost).
    const s = slidingWindowLog({ limit: 5, windowMs: 1000 });
    const r = s.check(undefined, 1000, 1.5);
    expect(r.result.allowed).toBe(true);
    expect(Number.isInteger(r.result.remaining)).toBe(true);
    expect(r.result.remaining).toBe(3); // 5 - ceil(1.5) = 5 - 2
    expect(r.state).toEqual([1000, 1000]); // ceil(1.5) = 2 stamps, matching the Lua ZADD count

    // cost < 1 must still consume a whole unit (the Lua `for i=1,cost` would ZADD nothing → unbounded).
    const half = s.check(undefined, 1000, 0.5);
    expect(half.state).toHaveLength(1); // ceil(0.5) = 1
  });

  it("exposes an atomic Lua program", () => {
    const s = slidingWindowLog({ limit: 5, windowMs: 1000 });
    expect(s.lua?.buildArgv(50, 2)).toEqual([50, 1000, 5, 2]);
    expect(s.lua?.script).toContain("ZREMRANGEBYSCORE");
  });
});
