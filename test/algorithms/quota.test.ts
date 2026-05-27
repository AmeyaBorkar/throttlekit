import { describe, expect, it } from "vitest";
import { MS_PER_DAY } from "../../src/algorithms/calendar";
import { quota } from "../../src/algorithms/quota";
import type { Decision, Strategy } from "../../src/core/types";

/** Drive a strategy as a pure state machine, mirroring what a store would do. */
function driver(strategy: Strategy) {
  let state: Parameters<typeof strategy.check>[0];
  return (now: number, cost = 1): Decision => {
    const r = strategy.check(state, now, cost);
    if (r.persist) state = r.state;
    return r.result;
  };
}

describe("quota", () => {
  it("validates options", () => {
    expect(() => quota({ limit: 0, resetCadence: "calendar-month" })).toThrow(RangeError);
    expect(() => quota({ limit: 5, resetCadence: "fixed" })).toThrow(RangeError); // periodMs required
    expect(() => quota({ limit: 5, resetCadence: "rolling" })).toThrow(RangeError); // periodMs required
    expect(() => quota({ limit: 5, resetCadence: "calendar-month", offsetMinutes: 900 })).toThrow(
      RangeError,
    );
    expect(() => quota({ limit: 5, resetCadence: "calendar-week", weekStartsOn: 7 })).toThrow(
      RangeError,
    );
    expect(() => quota({ limit: 5, resetCadence: "calendar-month", offsetMinutes: 1.5 })).toThrow(
      RangeError,
    );
  });

  describe("calendar-month", () => {
    it("admits exactly `limit` per month, then denies, with resetAt on the next 1st", () => {
      const step = driver(quota({ limit: 3, resetCadence: "calendar-month" }));
      const now = Date.UTC(2026, 4, 28, 12, 0); // 2026-05-28
      const a = step(now);
      expect(a.allowed).toBe(true);
      expect(a.limit).toBe(3);
      expect(a.remaining).toBe(2);
      expect(a.resetAt).toBe(Date.UTC(2026, 5, 1)); // next 1st (June 1)
      expect(step(now).remaining).toBe(1);
      expect(step(now).remaining).toBe(0);
      const denied = step(now);
      expect(denied.allowed).toBe(false);
      expect(denied.remaining).toBe(0);
      expect(denied.retryAfterMs).toBe(Date.UTC(2026, 5, 1) - now);
    });

    it("rolls over at the month boundary", () => {
      const step = driver(quota({ limit: 2, resetCadence: "calendar-month" }));
      const may = Date.UTC(2026, 4, 31, 23, 0);
      step(may);
      step(may); // May exhausted
      expect(step(may).allowed).toBe(false);
      const jun = Date.UTC(2026, 5, 1, 0, 0); // crosses into June → fresh budget
      const fresh = step(jun);
      expect(fresh.allowed).toBe(true);
      expect(fresh.remaining).toBe(1);
      expect(fresh.resetAt).toBe(Date.UTC(2026, 6, 1));
    });

    it("denies a cost larger than the whole quota without consuming", () => {
      const step = driver(quota({ limit: 3, resetCadence: "calendar-month" }));
      const d = step(Date.UTC(2026, 4, 28), 4);
      expect(d.allowed).toBe(false);
      expect(d.remaining).toBe(3); // nothing consumed
    });
  });

  describe("fixed", () => {
    it("behaves like an epoch-aligned fixed window", () => {
      const step = driver(quota({ limit: 5, resetCadence: "fixed", periodMs: 1000 }));
      const d = step(2_500); // window [2000,3000)
      expect(d.allowed).toBe(true);
      expect(d.resetAt).toBe(3000);
      expect(d.remaining).toBe(4);
    });

    it("aligns windows to a non-zero anchor", () => {
      const step = driver(quota({ limit: 2, resetCadence: "fixed", periodMs: 1000, anchor: 500 }));
      const d = step(600); // window [500,1500)
      expect(d.resetAt).toBe(1500);
      step(600);
      expect(step(600).allowed).toBe(false); // exhausted within [500,1500)
      expect(step(1500).allowed).toBe(true); // new window [1500,2500)
    });
  });

  describe("rolling", () => {
    it("delegates to a trailing window but reports the quota policy name", () => {
      const s = quota({ limit: 5, resetCadence: "rolling", periodMs: 1000 });
      expect(s.name).toBe("quota");
      expect(s.lua).toBeDefined();
      const step = driver(s);
      for (let i = 0; i < 5; i++) expect(step(0).allowed).toBe(true);
      expect(step(0).allowed).toBe(false); // trailing window full at this instant
    });
  });

  it("deny does not consume — remaining stays meaningful across repeated denials", () => {
    const step = driver(quota({ limit: 2, resetCadence: "calendar-day" }));
    const now = Date.UTC(2026, 4, 28, 8, 0);
    step(now);
    step(now);
    expect(step(now).remaining).toBe(0);
    expect(step(now).remaining).toBe(0); // a denial must not push count past limit
    // calendar-day resets the next local midnight.
    expect(step(now).resetAt).toBe(Date.UTC(2026, 4, 29));
  });

  it("reports a stable, integer-valued decision shape", () => {
    const step = driver(quota({ limit: 2, resetCadence: "calendar-month", offsetMinutes: 330 }));
    const now = Date.UTC(2026, 4, 28, 7, 13); // non-aligned instant
    const allow = step(now);
    step(now);
    const deny = step(now);
    expect(deny.allowed).toBe(false);
    for (const d of [allow, deny]) {
      for (const v of [d.limit, d.remaining, d.resetAt, d.retryAfterMs]) {
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });

  it("exposes an atomic Lua program with integer-only ARGV", () => {
    const s = quota({ limit: 1000, resetCadence: "calendar-month", offsetMinutes: 330 });
    expect(s.lua).toBeDefined();
    expect(s.lua?.buildKeys("k")).toEqual(["k"]);
    // ARGV: [now, limit, cost, mode(1=month), periodMs, anchor, offsetMs, weekStartsOn]
    expect(s.lua?.buildArgv(123, 2)).toEqual([123, 1000, 2, 1, 0, 0, 330 * 60_000, 1]);
    expect(s.lua?.script).toContain("redis.call");
    expect(s.name).toBe("quota");
    // calendar cadences report no fixed window; fixed does.
    expect(s.windowMs).toBeUndefined();
    expect(quota({ limit: 5, resetCadence: "fixed", periodMs: MS_PER_DAY }).windowMs).toBe(
      MS_PER_DAY,
    );
  });
});
