import { describe, expect, it } from "vitest";
import { tokenBucket } from "../../src/algorithms/token-bucket";
import type { Decision } from "../../src/core/types";

/** Drive a token-bucket strategy as a pure state machine, mirroring what a store would do. */
function driver(strategy: ReturnType<typeof tokenBucket>) {
  let state: Parameters<typeof strategy.check>[0];
  return (now: number, cost = 1): Decision => {
    const r = strategy.check(state, now, cost);
    if (r.persist) state = r.state;
    return r.result;
  };
}

describe("tokenBucket", () => {
  it("validates options", () => {
    expect(() => tokenBucket({ capacity: 0, refillPerSec: 10 })).toThrow(RangeError);
    expect(() => tokenBucket({ capacity: 5, refillPerSec: 0 })).toThrow(RangeError);
    expect(() => tokenBucket({ capacity: 5, refillPerSec: -1 })).toThrow(RangeError);
    expect(() => tokenBucket({ capacity: Number.NaN, refillPerSec: 1 })).toThrow(RangeError);
  });

  it("admits a full burst from cold, then denies (starts full)", () => {
    // capacity 5, 10 tok/s => refillPerMs 0.01
    const step = driver(tokenBucket({ capacity: 5, refillPerSec: 10 }));
    const a = step(0);
    expect(a.allowed).toBe(true);
    expect(a.limit).toBe(5);
    expect(a.remaining).toBe(4); // one consumed of five
    for (let i = 0; i < 4; i++) expect(step(0).allowed).toBe(true); // drain the rest
    const denied = step(0);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it("reports retryAfter and an unchanged remaining on deny (deny does not consume)", () => {
    const step = driver(tokenBucket({ capacity: 2, refillPerSec: 1 })); // refillPerMs 0.001
    step(0);
    step(0); // bucket now empty
    const d1 = step(0);
    expect(d1.allowed).toBe(false);
    expect(d1.remaining).toBe(0);
    // need 1 token, refill 0.001/ms => ceil(1/0.001) = 1000ms
    expect(d1.retryAfterMs).toBe(1000);
    // A second denial reports the same remaining: denials don't consume.
    const d2 = step(0);
    expect(d2.allowed).toBe(false);
    expect(d2.remaining).toBe(0);
    expect(d2.retryAfterMs).toBe(1000);
  });

  it("refills lazily and paces by the refill rate", () => {
    const step = driver(tokenBucket({ capacity: 5, refillPerSec: 10 })); // 0.01 tok/ms
    for (let i = 0; i < 5; i++) step(0); // drain to empty
    expect(step(0).allowed).toBe(false);
    expect(step(99).allowed).toBe(false); // 0.99 tokens < 1
    expect(step(100).allowed).toBe(true); // exactly 1.0 token accrued
    expect(step(100).allowed).toBe(false); // and immediately empty again
  });

  it("caps accrued tokens at capacity (no over-refill while idle)", () => {
    const step = driver(tokenBucket({ capacity: 5, refillPerSec: 10 }));
    step(0); // consume 1 => 4 left, last=0
    // Idle for a long time: would accrue far more than capacity, but it clamps.
    const d = step(1_000_000);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(4); // refilled to 5 (capped), minus this 1
  });

  it("remaining and resetAt track the consumed amount on allow", () => {
    const step = driver(tokenBucket({ capacity: 5, refillPerSec: 10 })); // 0.01 tok/ms
    const d = step(0);
    expect(d.remaining).toBe(4);
    // resetAt = now + ceil((capacity - newTokens)/refillPerMs) = 0 + ceil(1/0.01) = 100
    expect(d.resetAt).toBe(100);
    expect(d.retryAfterMs).toBe(0);
  });

  it("consumes multiple units for higher cost", () => {
    const step = driver(tokenBucket({ capacity: 10, refillPerSec: 100 })); // 0.1 tok/ms
    const d = step(0, 4);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(6);
    expect(step(0, 6).allowed).toBe(true); // exactly empties the bucket
    const denied = step(0, 1);
    expect(denied.allowed).toBe(false); // now empty
    expect(denied.remaining).toBe(0);
  });

  it("denies a cost larger than capacity and reports the wait to accrue it", () => {
    const step = driver(tokenBucket({ capacity: 3, refillPerSec: 1 })); // 0.001 tok/ms, full=3
    const d = step(0, 5); // cost 5 > capacity 3: can never fit
    expect(d.allowed).toBe(false);
    expect(d.remaining).toBe(3); // full but still short
    expect(d.retryAfterMs).toBe(Math.ceil((5 - 3) / 0.001)); // 2000
  });

  it("is clock-jump safe (a backwards jump never over-refills)", () => {
    const step = driver(tokenBucket({ capacity: 5, refillPerSec: 10 }));
    step(10_000); // last=10_000, 4 tokens left
    // Clock jumps backwards: elapsed clamps to 0, so no spurious refill.
    const d = step(0);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(3); // still 4 tokens (no refill), minus this 1
  });

  it("reports a stable, integer-valued decision shape on allow and deny", () => {
    const step = driver(tokenBucket({ capacity: 3, refillPerSec: 7 })); // fractional refillPerMs
    const allow = step(0);
    step(0);
    step(0);
    const deny = step(0);
    expect(deny.allowed).toBe(false);
    for (const d of [allow, deny]) {
      for (const v of [d.limit, d.remaining, d.resetAt, d.retryAfterMs]) {
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });

  it("exposes an atomic Lua program with integer-only ARGV", () => {
    const s = tokenBucket({ capacity: 5, refillPerSec: 10 });
    expect(s.lua).toBeDefined();
    expect(s.lua?.buildKeys("k")).toEqual(["k"]);
    // ARGV: [now, capacity, refillPerSec, cost]
    expect(s.lua?.buildArgv(123, 2)).toEqual([123, 5, 10, 2]);
    expect(s.lua?.script).toContain("redis.call");
    expect(s.name).toBe("tokenBucket");
    expect(s.limit).toBe(5);
  });
});
