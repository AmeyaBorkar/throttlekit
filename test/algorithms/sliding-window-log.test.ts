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

// slidingWindowLog always defines peek/forecast (optional on the Strategy type); guard once so the
// tests can call them without unchecked optional access.
function peekOf(
  s: ReturnType<typeof slidingWindowLog>,
  state: number[] | undefined,
  now: number,
): Decision {
  if (!s.peek) throw new Error("peek expected to be defined");
  return s.peek(state, now);
}
function forecastOf(
  s: ReturnType<typeof slidingWindowLog>,
  state: number[] | undefined,
  now: number,
  cost: number,
) {
  if (!s.forecast) throw new Error("forecast expected to be defined");
  return s.forecast(state, now, cost);
}

describe("slidingWindowLog", () => {
  it("validates options", () => {
    expect(() => slidingWindowLog({ limit: 0, windowMs: 1000 })).toThrow(RangeError);
    expect(() => slidingWindowLog({ limit: 5, windowMs: -1 })).toThrow(RangeError);
    // The RangeError names the offending option so misconfig is diagnosable — pin the labels.
    expect(() => slidingWindowLog({ limit: 0, windowMs: 1000 })).toThrow(/slidingWindowLog\.limit/);
    expect(() => slidingWindowLog({ limit: 5, windowMs: -1 })).toThrow(
      /slidingWindowLog\.windowMs/,
    );
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
    // buildKeys threads the limiter key through untouched (Cluster hash-tag identity).
    expect(s.lua?.buildKeys("acct:42")).toEqual(["acct:42"]);
  });

  // ---------------------------------------------------------------------------
  // check(): denial arithmetic under cost > 1. `retryAfterMs` is when the k-th
  // oldest live stamp (k = count + units - limit) ages out. An INDEPENDENT oracle:
  // to admit `units`, exactly `k` of the currently-live stamps must expire; the
  // last of those to leave is the k-th oldest, at `stamp + windowMs`.
  // ---------------------------------------------------------------------------
  it("denied cost>1: retry points at the k-th oldest live stamp exiting the window", () => {
    const s = slidingWindowLog({ limit: 5, windowMs: 1000 });
    const stamps = [0, 100, 200, 300, 400];
    let state: number[] | undefined;
    for (const t of stamps) {
      const r = s.check(state, t, 1);
      state = r.state; // all allowed (count grows 0..4, each +1 <= 5)
    }
    // 5 live stamps, cost 3 => need k = 5 + 3 - 5 = 3 of them to age out. The 3rd
    // oldest is at t=200, leaving the window at 1200 => 750ms after now=450.
    const d = s.check(state, 450, 3);
    expect(d.result.allowed).toBe(false);
    expect(d.persist).toBe(false); // a denial never advances state
    expect(d.state).toBe(state); // and returns the same log unchanged
    expect(d.result.retryAfterMs).toBe(750);
    expect(d.result.remaining).toBe(0); // limit - count = 5 - 5
    expect(d.result.resetAt).toBe(1000); // oldest stamp (t=0) + windowMs
  });

  it("denied cost>limit with live stamps: retry clamps to the full window clearing", () => {
    // cost exceeds `limit`, so no amount of aging admits it this window; the retry
    // hint clamps to when ALL currently-live stamps have left (the newest exits last).
    const s = slidingWindowLog({ limit: 3, windowMs: 1000 });
    let state: number[] | undefined;
    for (const t of [0, 100]) {
      state = s.check(state, t, 1).state; // 2 live stamps
    }
    const d = s.check(state, 200, 5);
    expect(d.result.allowed).toBe(false);
    // k = 2 + 5 - 3 = 4, clamped to count (2): ref = newest live stamp (t=100),
    // exits at 1100 => 900ms from now=200.
    expect(d.result.retryAfterMs).toBe(900);
    // remaining reports whole live slots free (limit - count), NOT limit - (count+units).
    expect(d.result.remaining).toBe(1);
    expect(d.result.resetAt).toBe(1000); // oldest (t=0) + windowMs
  });

  it("denied from cold when cost exceeds limit: retry is one whole window", () => {
    // count === 0 with an empty log: unsatisfiable in one window => retry = windowMs,
    // and `oldest` falls back to `now` (resetAt = now + windowMs).
    const s = slidingWindowLog({ limit: 3, windowMs: 1000 });
    const d = s.check(undefined, 0, 5);
    expect(d.result.allowed).toBe(false);
    expect(d.result.retryAfterMs).toBe(1000);
    expect(d.result.remaining).toBe(3); // limit - 0
    expect(d.result.resetAt).toBe(1000); // now(0) + windowMs
  });

  it("denied from cold via eviction (count 0 but a stale stamp lingers)", () => {
    // The log still holds an expired stamp, but count === 0. This must take the
    // count===0 retry branch (windowMs), NOT index the stale stamp for a retry.
    const s = slidingWindowLog({ limit: 2, windowMs: 1000 });
    const seeded = s.check(undefined, 0, 1).state; // log = [0]
    const d = s.check(seeded, 2000, 5); // t=0 is stale (windowStart=1000), count 0
    expect(d.result.allowed).toBe(false);
    expect(d.result.retryAfterMs).toBe(1000); // full window, not the stale-stamp math
    expect(d.result.remaining).toBe(2);
    expect(d.result.resetAt).toBe(3000); // oldest falls back to now(2000) + windowMs
    expect(Number.isInteger(d.result.resetAt)).toBe(true);
  });

  it("allowed with surviving older stamps: resetAt tracks the oldest, not now", () => {
    // The oldest survivor (not `now`) sets resetAt on an ALLOWED request.
    const s = slidingWindowLog({ limit: 3, windowMs: 1000 });
    const first = s.check(undefined, 0, 1).state; // [0]
    const d = s.check(first, 100, 1); // allowed, log = [0, 100]
    expect(d.result.allowed).toBe(true);
    expect(d.result.resetAt).toBe(1000); // oldest is t=0, not now=100 (=> not 1100)
    expect(d.result.remaining).toBe(1); // limit - (count+units) = 3 - 2
    expect(d.state).toEqual([0, 100]);
  });

  // ---------------------------------------------------------------------------
  // peek(): non-consuming introspection. Independent oracle: count = number of
  // stamps with ts > now - windowMs; remaining = limit - count.
  // ---------------------------------------------------------------------------
  it("peek: fresh key reports full capacity without consuming", () => {
    const s = slidingWindowLog({ limit: 3, windowMs: 1000 });
    const d = peekOf(s, undefined, 5000);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(3);
    expect(d.retryAfterMs).toBe(0);
    expect(d.resetAt).toBe(6000); // now + windowMs; integer, not NaN
    expect(Number.isInteger(d.resetAt)).toBe(true);
  });

  it("peek: prunes stale stamps and reports the live oldest for resetAt", () => {
    // Log [0, 500] at now=1000: t=0 sits exactly on windowStart (evicted, <=),
    // t=500 survives. count=1, one slot free.
    const s = slidingWindowLog({ limit: 2, windowMs: 1000 });
    const d = peekOf(s, [0, 500], 1000);
    expect(d.allowed).toBe(true); // count+1 = 2 <= 2
    expect(d.remaining).toBe(1); // limit - count = 2 - 1
    expect(d.resetAt).toBe(1500); // live oldest (t=500) + windowMs, not now+window
    expect(d.retryAfterMs).toBe(0);
  });

  it("peek: at capacity, retry points at the oldest live stamp leaving the window", () => {
    // 3 live stamps (all nonzero) at capacity; peek denies and its retry is when the
    // oldest (t=100) exits: 100 + 1000 - 400 = 700.
    const s = slidingWindowLog({ limit: 3, windowMs: 1000 });
    const d = peekOf(s, [100, 200, 300], 400);
    expect(d.allowed).toBe(false);
    expect(d.remaining).toBe(0);
    expect(d.retryAfterMs).toBe(700);
    expect(d.resetAt).toBe(1100); // oldest live (t=100) + windowMs
  });

  // ---------------------------------------------------------------------------
  // forecast(): capacity projection. Independent oracle: available = limit - count,
  // spendableNow = floor(available / cost), replenish/full = live stamp + windowMs.
  // ---------------------------------------------------------------------------
  it("forecast: fresh key is fully spendable now with immediate replenish", () => {
    const s = slidingWindowLog({ limit: 5, windowMs: 1000 });
    const f = forecastOf(s, undefined, 9000, 1);
    expect(f.spendableNow).toBe(5);
    expect(f.nextReplenishAt).toBe(9000); // no live stamps => now
    expect(f.fullAt).toBe(9000);
  });

  it("forecast: prunes stale stamps; replenish=oldest-live, full=newest-live", () => {
    // Log [0, 500, 700] at now=1000: t=0 is stale, 500 & 700 are live => count 2.
    const s = slidingWindowLog({ limit: 5, windowMs: 1000 });
    const f = forecastOf(s, [0, 500, 700], 1000, 1);
    expect(f.spendableNow).toBe(3); // floor((5 - 2) / 1)
    expect(f.nextReplenishAt).toBe(1500); // oldest live (t=500) + windowMs
    expect(f.fullAt).toBe(1700); // newest live (t=700) + windowMs
    // spendableNow scales down by cost (floor).
    expect(forecastOf(s, [0, 500, 700], 1000, 2).spendableNow).toBe(1); // floor(3 / 2)
  });

  // ---------------------------------------------------------------------------
  // readState: the non-consuming Lua peek + its decoder.
  // ---------------------------------------------------------------------------
  it("readState.decode maps ZRANGE WITHSCORES to the ascending score log", () => {
    const rs = slidingWindowLog({ limit: 5, windowMs: 1000 }).readState;
    if (rs === undefined) throw new Error("readState expected to be defined");
    // [member, score, member, score, ...] -> [score, score, ...] as numbers.
    expect(rs.decode(["100-1", "100", "200-2", "250"])).toEqual([100, 250]);
    expect(rs.decode(["9-1", "9"])).toEqual([9]);
    // Absent / empty key decodes to undefined (no stored log).
    expect(rs.decode(null)).toBeUndefined();
    expect(rs.decode([])).toBeUndefined();
  });

  it("readState exposes a read-only Lua program (no key/argv surprises)", () => {
    const rs = slidingWindowLog({ limit: 5, windowMs: 1000 }).readState;
    if (rs === undefined) throw new Error("readState expected to be defined");
    expect(rs.lua.buildKeys("acct:7")).toEqual(["acct:7"]);
    expect(rs.lua.buildArgv(0, 1)).toEqual([]); // readState argv ignores now/cost
    expect(rs.lua.script).toContain("ZRANGE");
  });
});
