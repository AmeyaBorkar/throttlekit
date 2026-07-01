import { describe, expect, it } from "vitest";
import { slidingWindow } from "../../src/algorithms/sliding-window";
import type { Decision, Forecast } from "../../src/core/types";

type SW = ReturnType<typeof slidingWindow>;
type WState = Parameters<SW["check"]>[0];

function driver(strategy: SW) {
  // The window state is opaque to the test; thread whatever shape the strategy returns.
  let state: WState;
  return (now: number, cost = 1): Decision => {
    const r = strategy.check(state, now, cost);
    if (r.persist) state = r.state;
    return r.result;
  };
}

/**
 * Thread a sequence of `[now, cost]` admits through the pure `check()` exactly as a store would —
 * only allowed transitions persist — and hand back the resulting ring state. This lets a test build
 * a known window occupancy, then probe `peek`/`forecast`/`check` against an INDEPENDENT hand-computed
 * expectation rather than mirroring the implementation's own arithmetic.
 */
function build(strategy: SW, admits: ReadonlyArray<readonly [number, number]>): WState {
  let state: WState;
  for (const [now, cost] of admits) {
    const r = strategy.check(state, now, cost);
    if (r.persist) state = r.state;
  }
  return state;
}

function peekAt(strategy: SW, state: WState, now: number): Decision {
  const fn = strategy.peek;
  if (fn === undefined) throw new Error("peek expected to be defined");
  return fn(state, now);
}

function forecastAt(strategy: SW, state: WState, now: number, cost: number): Forecast {
  const fn = strategy.forecast;
  if (fn === undefined) throw new Error("forecast expected to be defined");
  return fn(state, now, cost);
}

function decodeRaw(strategy: SW, raw: unknown): WState {
  const rs = strategy.readState;
  if (rs === undefined) throw new Error("readState expected to be defined");
  return rs.decode(raw);
}

describe("slidingWindow (sub-bucketed)", () => {
  it("validates options", () => {
    expect(() => slidingWindow({ limit: 0, windowMs: 1000 })).toThrow(RangeError);
    expect(() => slidingWindow({ limit: 10, windowMs: 1000, buckets: 0 })).toThrow(RangeError);
    expect(() => slidingWindow({ limit: 10, windowMs: 1000, buckets: 2.5 })).toThrow(RangeError);
    // Upper-bounded: an O(buckets) ring per key means an unbounded buckets is a memory DoS.
    expect(() => slidingWindow({ limit: 10, windowMs: 1000, buckets: 100_001 })).toThrow(
      RangeError,
    );
    expect(() => slidingWindow({ limit: 10, windowMs: 1000, buckets: 100_000 })).not.toThrow();
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

// Config used across the boundary suites: windowMs 1000 / 10 buckets => w = 100ms, ring of 11 slots.
// Every expected value below is hand-computed from the documented estimator, never re-derived from the
// implementation's own expressions.
const mk = () => slidingWindow({ limit: 10, windowMs: 1000, buckets: 10 });

describe("slidingWindow — config & validation boundaries", () => {
  it("names the offending option in each validation error", () => {
    expect(() => slidingWindow({ limit: 0, windowMs: 1000 })).toThrow(/slidingWindow\.limit/);
    expect(() => slidingWindow({ limit: 10, windowMs: 0 })).toThrow(/slidingWindow\.windowMs/);
    expect(() => slidingWindow({ limit: 10, windowMs: 1000, buckets: 2.5 })).toThrow(
      /slidingWindow\.buckets/,
    );
    expect(() => slidingWindow({ limit: 10, windowMs: 1000, buckets: 0 })).toThrow(
      /slidingWindow\.buckets/,
    );
  });

  it("defaults to 10 buckets and reports w in ttl/argv", () => {
    const s = slidingWindow({ limit: 10, windowMs: 1000 });
    // Default buckets => S=10 surfaces as the last ARGV element.
    expect(s.lua?.buildArgv(0, 1)).toEqual([0, 1000, 10, 1, 10]);
    // ttlMs = ceil(windowMs + w) = ceil(1000 + 100) = 1100.
    expect(s.ttlMs).toBe(1100);
  });

  it("builds the check KEYS array from the limiter key", () => {
    const s = mk();
    expect(s.lua?.buildKeys("k")).toEqual(["k"]);
  });

  it("exposes a read-only introspection Lua program", () => {
    const rs = mk().readState;
    if (rs === undefined) throw new Error("readState expected to be defined");
    expect(rs.lua.script).toContain("HGETALL");
    expect(rs.lua.buildKeys("k")).toEqual(["k"]);
    expect(rs.lua.buildArgv(0, 1)).toEqual([]);
  });
});

describe("slidingWindow — check() boundaries", () => {
  it("reports ttl = ceil(windowMs + w) on the strategy, on allow, and on deny", () => {
    const s = mk();
    expect(s.ttlMs).toBe(1100); // top-level field
    expect(s.check(undefined, 0, 1).ttlMs).toBe(1100); // allow branch
    // Fill the window, then a denied check still advertises the same ttl.
    const full = build(
      s,
      Array.from({ length: 10 }, () => [0, 1] as const),
    );
    const denied = s.check(full, 0, 1);
    expect(denied.result.allowed).toBe(false);
    expect(denied.ttlMs).toBe(1100);
  });

  it("keeps positive remaining on a denied over-cost request (does not zero it)", () => {
    const s = mk();
    // 7 units already in the current bucket; a cost-5 request is denied but 3 remain.
    const state = build(s, [[0, 7]]);
    const d = s.check(state, 0, 5);
    expect(d.result.allowed).toBe(false);
    expect(d.result.remaining).toBe(3); // floor(10 - estimate(7)) = 3, not clamped to 0
  });

  it("does not resurrect a stale ring slot when bumping the current bucket", () => {
    // buckets:1 => 2 slots, so bucket 0 and bucket 2 share slot 0. A fresh admit into bucket 2 must
    // start from 0, not inherit bucket 0's stale count.
    const s = slidingWindow({ limit: 10, windowMs: 100, buckets: 1 });
    const seeded = build(
      s,
      Array.from({ length: 5 }, () => [0, 1] as const),
    ); // bucket0 = 5
    const r = s.check(seeded, 200, 1); // bucket2 (slot 0) — stale bucket0 must read as 0
    expect(r.result.allowed).toBe(true);
    // The stored count for bucket 2 is 1 (fresh), so peek at t=200 leaves 9 — a resurrected 5 would
    // have made it 5+1=6 and left 4.
    expect(peekAt(s, r.state, 200).remaining).toBe(9);
  });
});

describe("slidingWindow — peek() boundaries", () => {
  it("reports full capacity on an empty key", () => {
    const s = mk();
    const p = peekAt(s, undefined, 0);
    expect(p).toEqual({
      allowed: true,
      limit: 10,
      remaining: 10,
      resetAt: 1100, // ceil((0+1)*100 + 1000)
      retryAfterMs: 0,
    });
  });

  it("admits at the estimate+1 == limit boundary and reads the current bucket", () => {
    const s = mk();
    const state = build(s, [[0, 9]]); // estimate 9 at t=0
    const p = peekAt(s, state, 0);
    expect(p.allowed).toBe(true); // 9 + 1 <= 10
    expect(p.remaining).toBe(1); // floor(10 - 9); a dropped current-bucket read would give 10
    expect(p.resetAt).toBe(1100);
  });

  it("denies via the oldest-bucket decay path once full (retry = ceil(D*w/oldest))", () => {
    const s = mk();
    const state = build(
      s,
      Array.from({ length: 10 }, () => [0, 1] as const),
    ); // bucket0 = 10
    const p = peekAt(s, state, 1000); // c=10, weight=1, oldest=10
    // estimate = 10, D = 11 - 10 = 1, D <= oldest*weight(10) => retry = ceil(1*100/10) = 10.
    expect(p).toEqual({
      allowed: false,
      limit: 10,
      remaining: 0,
      resetAt: 2100, // ceil(11*100 + 1000)
      retryAfterMs: 10,
    });
  });

  it("weights the oldest bucket by the fraction still inside the window", () => {
    const s = mk();
    const state = build(
      s,
      Array.from({ length: 10 }, () => [0, 1] as const),
    ); // bucket0 = 10
    const p = peekAt(s, state, 1050); // c=10, elapsed=50, weight=0.5
    // estimate = 10 * 0.5 = 5, so 5 remain and the next unit is admissible.
    expect(p.allowed).toBe(true);
    expect(p.remaining).toBe(5);
    expect(p.resetAt).toBe(2100);
    expect(p.retryAfterMs).toBe(0);
  });

  it("denies via the next-boundary path when there is no older bucket to decay", () => {
    const s = mk();
    const state = build(
      s,
      Array.from({ length: 10 }, () => [500, 1] as const),
    ); // bucket5 = 10
    const p = peekAt(s, state, 500); // c=5, oldest bucket (-5) empty
    // No oldest to shed => wait for the current bucket boundary: ceil((5+1)*100 - 500) = 100.
    expect(p).toEqual({
      allowed: false,
      limit: 10,
      remaining: 0,
      resetAt: 1600, // ceil(6*100 + 1000)
      retryAfterMs: 100,
    });
  });

  it("sums exactly the buckets inside the trailing window (independent per-bucket occupancy)", () => {
    const s = mk();
    // bucket0 = 3 (becomes the weighted oldest at c=10); bucket1 = 1 (first fully-counted bucket).
    const state = build(s, [
      [0, 3],
      [100, 1],
    ]);
    const p = peekAt(s, state, 1050); // c=10, weight=0.5
    // estimate = full(bucket1=1) + oldest(bucket0=3)*0.5 = 1 + 1.5 = 2.5 => remaining floor(7.5) = 7.
    expect(p.allowed).toBe(true);
    expect(p.remaining).toBe(7);
  });

  it("treats a stale ring slot as empty (does not read another tick's count)", () => {
    const s = slidingWindow({ limit: 10, windowMs: 100, buckets: 1 });
    const seeded = build(
      s,
      Array.from({ length: 5 }, () => [0, 1] as const),
    ); // bucket0 = 5, slot 0
    const p = peekAt(s, seeded, 200); // bucket2 shares slot 0 but is a different tick => count 0
    expect(p.allowed).toBe(true);
    expect(p.remaining).toBe(10); // a stale read of bucket0's 5 would have left 5
  });
});

describe("slidingWindow — forecast() boundaries", () => {
  it("reports full spendable capacity and the two horizons on an empty key", () => {
    const s = mk();
    const f = forecastAt(s, undefined, 0, 1);
    expect(f).toEqual({
      spendableNow: 10, // floor(available 10 / cost 1)
      nextReplenishAt: 100, // ceil((0+1)*100) — next sub-bucket boundary (no +windowMs)
      fullAt: 1100, // ceil((0+1)*100 + 1000) — a full window later
    });
  });

  it("discounts the oldest bucket by weight and divides available by cost", () => {
    const s = mk();
    const state = build(
      s,
      Array.from({ length: 10 }, () => [0, 1] as const),
    ); // bucket0 = 10
    // c=10, weight=0.5 => estimate 5, available 5.
    expect(forecastAt(s, state, 1050, 1)).toEqual({
      spendableNow: 5,
      nextReplenishAt: 1100, // ceil(11*100)
      fullAt: 2100, // ceil(11*100 + 1000)
    });
    // cost 3 => floor(5 / 3) = 1 spendable now.
    expect(forecastAt(s, state, 1050, 3).spendableNow).toBe(1);
  });

  it("sums only the in-window buckets", () => {
    const s = mk();
    const state = build(s, [
      [0, 3],
      [100, 1],
    ]);
    // estimate 2.5 => available floor(10 - 2.5) = 7.
    expect(forecastAt(s, state, 1050, 1).spendableNow).toBe(7);
  });

  it("treats a stale ring slot as empty", () => {
    const s = slidingWindow({ limit: 10, windowMs: 100, buckets: 1 });
    const seeded = build(
      s,
      Array.from({ length: 5 }, () => [0, 1] as const),
    ); // bucket0 = 5, slot 0
    expect(forecastAt(s, seeded, 200, 1).spendableNow).toBe(10); // stale bucket0 must not count
  });
});

describe("slidingWindow — readState.decode()", () => {
  it("returns undefined for an absent or empty reply", () => {
    const s = mk();
    expect(decodeRaw(s, null)).toBeUndefined();
    expect(decodeRaw(s, [])).toBeUndefined();
  });

  it('parses the HGETALL flat [field, "<tick>:<count>"] pairs into the S+1 slot ring', () => {
    const s = mk(); // buckets:10 => 11 slots
    const st = decodeRaw(s, ["0", "0:5", "3", "3:7"]);
    if (st === undefined) throw new Error("decode expected a state");
    expect(st.i).toHaveLength(11);
    expect(st.n).toHaveLength(11);
    // Written slots carry their tick and count...
    expect(st.i[0]).toBe(0);
    expect(st.n[0]).toBe(5);
    expect(st.i[3]).toBe(3);
    expect(st.n[3]).toBe(7);
    // ...unwritten slots stay at the sentinels (-1 owner, 0 count).
    expect(st.i[1]).toBe(-1);
    expect(st.n[1]).toBe(0);
  });

  it("round-trips into an estimator read (decoded occupancy denies at the limit)", () => {
    const s = mk();
    const st = decodeRaw(s, ["0", "0:10"]); // bucket0 = 10
    const p = peekAt(s, st, 1000); // c=10, oldest bucket0 at weight 1 => estimate 10
    expect(p.allowed).toBe(false);
    expect(p.remaining).toBe(0);
  });
});
