import { describe, expect, it } from "vitest";
import { gcra } from "../../src/algorithms/gcra";
import type { Decision } from "../../src/core/types";

/** Drive a GCRA strategy as a pure state machine, mirroring what a store would do. */
function driver(strategy: ReturnType<typeof gcra>) {
  let state: number | undefined;
  return (now: number, cost = 1): Decision => {
    const r = strategy.check(state, now, cost);
    if (r.persist) state = r.state;
    return r.result;
  };
}

describe("gcra", () => {
  it("validates options", () => {
    expect(() => gcra({ limit: 0, periodMs: 1000 })).toThrow(RangeError);
    expect(() => gcra({ limit: 10, periodMs: -1 })).toThrow(RangeError);
    expect(() => gcra({ limit: 10, periodMs: 1000, burst: 0 })).toThrow(RangeError);
  });

  it("admits exactly `burst` requests from cold, then denies (burst-then-pace)", () => {
    // limit 2 / 1000ms => T=500, burst defaults to 2, tau=1000
    const step = driver(gcra({ limit: 2, periodMs: 1000 }));
    const a = step(0);
    expect(a.allowed).toBe(true);
    expect(a.limit).toBe(2);
    expect(a.remaining).toBe(1);
    expect(step(0).allowed).toBe(true); // 2nd allowed, remaining 0
    const denied = step(0);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBe(500); // one emission interval
  });

  it("paces at 1/T after the burst is spent", () => {
    const step = driver(gcra({ limit: 2, periodMs: 1000 })); // T=500
    step(0);
    step(0); // burst spent
    expect(step(0).allowed).toBe(false);
    expect(step(499).allowed).toBe(false); // still too early
    expect(step(500).allowed).toBe(true); // exactly one interval later
    expect(step(500).allowed).toBe(false); // and immediately paced again
  });

  it("supports a separate burst from the sustained rate", () => {
    // 100/min sustained, bursts of 5 => T=600, tau=3000
    const step = driver(gcra({ limit: 100, periodMs: 60_000, burst: 5 }));
    for (let i = 0; i < 5; i++) expect(step(0).allowed).toBe(true);
    expect(step(0).allowed).toBe(false); // 6th denied
    expect(step(600).allowed).toBe(true); // one interval refills one slot
  });

  it("consumes multiple units for higher cost", () => {
    const step = driver(gcra({ limit: 10, periodMs: 1000, burst: 10 })); // T=100, tau=1000
    const d = step(0, 4);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(6);
    expect(step(0, 6).allowed).toBe(true); // exactly fills
    expect(step(0, 1).allowed).toBe(false); // now empty
  });

  it("is clock-jump safe (backwards jumps never crash or over-admit; recovers)", () => {
    const step = driver(gcra({ limit: 5, periodMs: 1000, burst: 5 }));
    step(10_000);
    step(10_000);
    // Clock jumps backwards: the stored TAT is now in the "future", so requests are denied
    // (fail-safe) rather than crashing or admitting above the ceiling.
    const d = step(0);
    expect(d.allowed).toBe(false);
    expect(d.remaining).toBeGreaterThanOrEqual(0);
    expect(d.remaining).toBeLessThanOrEqual(5);
    // Once real time passes the stale TAT, traffic flows again.
    expect(step(20_000).allowed).toBe(true);
  });

  it("reports a stable, integer-valued decision shape", () => {
    const step = driver(gcra({ limit: 3, periodMs: 1500 }));
    const d = step(0);
    for (const v of [d.limit, d.remaining, d.resetAt, d.retryAfterMs]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("exposes an atomic Lua program", () => {
    const s = gcra({ limit: 10, periodMs: 1000 });
    expect(s.lua).toBeDefined();
    expect(s.lua?.buildKeys("k")).toEqual(["k"]);
    expect(s.lua?.buildArgv(123, 2)).toEqual([123, 1000, 10, 10, 2]);
    expect(s.lua?.script).toContain("redis.call");
  });
});
