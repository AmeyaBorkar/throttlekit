import { describe, expect, it } from "vitest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import type { Decision } from "../../src/core/types";

/** Drive a fixed-window strategy as a pure state machine, mirroring what a store would do. */
function driver(strategy: ReturnType<typeof fixedWindow>) {
  let state: Parameters<typeof strategy.check>[0];
  return (now: number, cost = 1): Decision => {
    const r = strategy.check(state, now, cost);
    if (r.persist) state = r.state;
    return r.decision;
  };
}

describe("fixedWindow", () => {
  it("validates options", () => {
    expect(() => fixedWindow({ limit: 0, windowMs: 1000 })).toThrow(RangeError);
    expect(() => fixedWindow({ limit: 3, windowMs: 0 })).toThrow(RangeError);
    expect(() => fixedWindow({ limit: 3, windowMs: -1 })).toThrow(RangeError);
  });

  it("admits exactly `limit` requests per window, then denies", () => {
    const step = driver(fixedWindow({ limit: 3, windowMs: 1000 }));
    const a = step(0);
    expect(a.allowed).toBe(true);
    expect(a.limit).toBe(3);
    expect(a.remaining).toBe(2);
    expect(step(0).remaining).toBe(1);
    expect(step(0).remaining).toBe(0);
    const denied = step(0);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.resetAt).toBe(1000);
    expect(denied.retryAfterMs).toBe(1000); // full window remaining from now=0
  });

  it("resets on the window boundary", () => {
    const step = driver(fixedWindow({ limit: 2, windowMs: 1000 }));
    step(0);
    step(0); // window [0,1000) exhausted
    expect(step(999).allowed).toBe(false); // still in the same window
    const fresh = step(1000); // new window [1000,2000)
    expect(fresh.allowed).toBe(true);
    expect(fresh.remaining).toBe(1);
    expect(fresh.resetAt).toBe(2000);
  });

  it("aligns windows to the epoch (resetAt is the next boundary)", () => {
    const step = driver(fixedWindow({ limit: 5, windowMs: 1000 }));
    const d = step(2_500); // window [2000,3000)
    expect(d.allowed).toBe(true);
    expect(d.resetAt).toBe(3000);
    expect(d.remaining).toBe(4);
  });

  it("retryAfterMs counts down to the boundary on deny", () => {
    const step = driver(fixedWindow({ limit: 1, windowMs: 1000 }));
    step(0); // window [0,1000) exhausted (limit 1)
    const d = step(750);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBe(250); // ceil(1000 - 750)
    expect(d.resetAt).toBe(1000);
  });

  it("deny does not consume — remaining stays meaningful across repeated denials", () => {
    const step = driver(fixedWindow({ limit: 2, windowMs: 1000 }));
    step(0);
    step(0); // exhausted, count=2
    const d1 = step(0);
    expect(d1.allowed).toBe(false);
    expect(d1.remaining).toBe(0);
    const d2 = step(0); // a denial must not push count past limit
    expect(d2.allowed).toBe(false);
    expect(d2.remaining).toBe(0);
  });

  it("admits up to 2x limit across a single boundary (documented property)", () => {
    const step = driver(fixedWindow({ limit: 3, windowMs: 1000 }));
    // Spend the full limit at the end of window [0,1000).
    expect(step(900).allowed).toBe(true);
    expect(step(900).allowed).toBe(true);
    expect(step(900).allowed).toBe(true);
    expect(step(900).allowed).toBe(false); // window 1 exhausted
    // Spend the full limit again at the start of window [1000,2000).
    expect(step(1000).allowed).toBe(true);
    expect(step(1000).allowed).toBe(true);
    expect(step(1000).allowed).toBe(true);
    expect(step(1000).allowed).toBe(false);
    // => 6 (= 2 x limit) admitted across the 900..1000 boundary, within 1000ms.
  });

  it("consumes multiple units for higher cost", () => {
    const step = driver(fixedWindow({ limit: 5, windowMs: 1000 }));
    const d = step(0, 3);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(2);
    expect(step(0, 2).allowed).toBe(true); // exactly fills the window
    const denied = step(0, 1);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it("denies a single cost that exceeds the whole limit", () => {
    const step = driver(fixedWindow({ limit: 3, windowMs: 1000 }));
    const d = step(0, 4); // cost 4 > limit 3
    expect(d.allowed).toBe(false);
    expect(d.remaining).toBe(3); // nothing consumed; full limit still available
  });

  it("reports a stable, integer-valued decision shape on allow and deny", () => {
    const step = driver(fixedWindow({ limit: 2, windowMs: 1000 }));
    const allow = step(333); // non-aligned now to exercise rounding
    step(333);
    const deny = step(333);
    expect(deny.allowed).toBe(false);
    for (const d of [allow, deny]) {
      for (const v of [d.limit, d.remaining, d.resetAt, d.retryAfterMs]) {
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });

  it("exposes an atomic Lua program with integer-only ARGV", () => {
    const s = fixedWindow({ limit: 5, windowMs: 1000 });
    expect(s.lua).toBeDefined();
    expect(s.lua?.buildKeys("k")).toEqual(["k"]);
    // ARGV: [now, limit, windowMs, cost]
    expect(s.lua?.buildArgv(123, 2)).toEqual([123, 5, 1000, 2]);
    expect(s.lua?.script).toContain("redis.call");
    expect(s.name).toBe("fixedWindow");
    expect(s.limit).toBe(5);
  });
});
