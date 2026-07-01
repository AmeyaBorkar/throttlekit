import { describe, expect, it } from "vitest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { gcra } from "../../src/algorithms/gcra";
import { leakyBucket } from "../../src/algorithms/leaky-bucket";
import { quota } from "../../src/algorithms/quota";
import { slidingWindow } from "../../src/algorithms/sliding-window";
import { slidingWindowLog } from "../../src/algorithms/sliding-window-log";
import { tokenBucket } from "../../src/algorithms/token-bucket";
import type { Decision, Strategy } from "../../src/core/types";

/**
 * INVARIANT — a strategy never emits a non-finite `Decision` field under adversarial construction.
 *
 * FINDING F4 surfaced that a subnormal `limit` made `gcra` derive `T = periodMs / limit = Infinity`,
 * poisoning every `resetAt` / `retryAfterMs` with a non-finite value; that one strategy was guarded.
 * The SAME "a construction parameter overflows/underflows the derived time arithmetic" hole lives in
 * every sibling that divides by a construction-derived rate or period:
 *   - `tokenBucket`  — `refillPerMs = refillPerSec / 1000` underflows to 0  → `resetAt = Infinity`/`NaN`
 *   - `leakyBucket`  — `T = 1000 / ratePerSec` overflows                    → `delayMs = Infinity` (→ `schedule()` hangs)
 *   - `fixedWindow`  — `floor(now / windowMs) * windowMs` overflows          → `resetAt = Infinity`
 *   - `slidingWindow`/`quota` — same, via `w = windowMs / S` / `periodMs`
 *   - `gcra`         — residual: `tau = T * burst` overflow, and `T` *underflow* to 0 (→ `0/0 = NaN`)
 *
 * CONTRACT (pinned here): for ANY finite construction params, a strategy must EITHER reject at
 * construction with a `RangeError`, OR only ever emit finite `Decision` fields. It must never
 * construct successfully and then emit `Infinity`/`NaN` in `limit`/`remaining`/`resetAt`/`retryAfterMs`.
 * The adversarial values below (subnormal `5e-324`, `1e-300`, `1e300`) are unreachable from a config
 * file — they exercise the direct programmatic API — but the finiteness of a decision is a hard
 * contract (a non-finite `resetAt` becomes a malformed `RateLimit-Reset` header downstream).
 */

const TINY = Number.MIN_VALUE; // 5e-324, the smallest positive subnormal double
const SMALL = 1e-300;
const HUGE = 1e300;
// A realistic epoch-ms. `now = 0` hides the `floor(now / w)` overflow (0 / anything is 0), so a
// non-zero clock is what surfaces the window-math holes.
const NOW = 1_700_000_000_000;

function assertFiniteDecision(d: Decision, ctx: string): void {
  expect(Number.isFinite(d.limit), `${ctx}: limit=${d.limit}`).toBe(true);
  expect(Number.isFinite(d.remaining), `${ctx}: remaining=${d.remaining}`).toBe(true);
  expect(Number.isFinite(d.resetAt), `${ctx}: resetAt=${d.resetAt}`).toBe(true);
  expect(Number.isFinite(d.retryAfterMs), `${ctx}: retryAfterMs=${d.retryAfterMs}`).toBe(true);
  expect(d.remaining, `${ctx}: remaining>=0`).toBeGreaterThanOrEqual(0);
  expect(d.retryAfterMs, `${ctx}: retryAfterMs>=0`).toBeGreaterThanOrEqual(0);
}

/**
 * Build the strategy; if construction throws it MUST be a `RangeError` (a clean rejection). If it
 * constructs, drive it allow→deny across a few costs and assert every emitted decision is finite.
 */
function probeStrategy<S>(name: string, build: () => Strategy<S>): void {
  let strat: Strategy<S>;
  try {
    strat = build();
  } catch (err) {
    expect(err, `${name}: a rejected construction must throw RangeError`).toBeInstanceOf(
      RangeError,
    );
    return;
  }
  for (const cost of [1, 3]) {
    let state: S | undefined;
    for (let round = 0; round < 3; round++) {
      const out = strat.check(state, NOW, cost);
      assertFiniteDecision(out.result, `${name} cost=${cost} round=${round}`);
      state = out.state;
    }
    if (strat.peek) assertFiniteDecision(strat.peek(state, NOW), `${name} peek cost=${cost}`);
  }
}

describe("invariant: strategies never emit a non-finite Decision under adversarial construction", () => {
  it("gcra: subnormal/overflowing limit·period·burst → throw or finite", () => {
    for (const limit of [TINY, SMALL, 1, HUGE]) {
      for (const periodMs of [TINY, 1, 60_000, 1e8, HUGE]) {
        for (const burst of [undefined, 1, HUGE]) {
          // Omit `burst` (rather than pass `undefined`) so the default-burst path is exercised too.
          probeStrategy(`gcra(limit=${limit},period=${periodMs},burst=${burst})`, () =>
            gcra(burst === undefined ? { limit, periodMs } : { limit, periodMs, burst }),
          );
        }
      }
    }
  });

  it("tokenBucket: subnormal/overflowing capacity·refill → throw or finite", () => {
    for (const capacity of [TINY, 1, HUGE]) {
      for (const refillPerSec of [TINY, SMALL, 1, HUGE]) {
        probeStrategy(`tokenBucket(cap=${capacity},refill=${refillPerSec})`, () =>
          tokenBucket({ capacity, refillPerSec }),
        );
      }
    }
  });

  it("fixedWindow: subnormal/overflowing window → throw or finite", () => {
    for (const limit of [TINY, 1, HUGE]) {
      for (const windowMs of [TINY, SMALL, 1, 60_000, HUGE]) {
        probeStrategy(`fixedWindow(limit=${limit},window=${windowMs})`, () =>
          fixedWindow({ limit, windowMs }),
        );
      }
    }
  });

  it("slidingWindow: subnormal/overflowing window·buckets → throw or finite", () => {
    for (const windowMs of [TINY, SMALL, 1, 60_000, HUGE]) {
      for (const buckets of [1, 10]) {
        probeStrategy(`slidingWindow(window=${windowMs},buckets=${buckets})`, () =>
          slidingWindow({ limit: 100, windowMs, buckets }),
        );
      }
    }
  });

  it("slidingWindowLog: subnormal/overflowing window → throw or finite (expected always finite)", () => {
    for (const windowMs of [TINY, SMALL, 1, 60_000, HUGE]) {
      probeStrategy(`slidingWindowLog(window=${windowMs})`, () =>
        slidingWindowLog({ limit: 100, windowMs }),
      );
    }
  });

  it("quota: subnormal/overflowing period across cadences → throw or finite", () => {
    for (const periodMs of [TINY, SMALL, 1, 60_000, HUGE]) {
      probeStrategy(`quota(fixed,period=${periodMs})`, () =>
        quota({ limit: 100, resetCadence: "fixed", periodMs }),
      );
      probeStrategy(`quota(rolling,period=${periodMs})`, () =>
        quota({ limit: 100, resetCadence: "rolling", periodMs }),
      );
    }
    for (const resetCadence of ["calendar-month", "calendar-week", "calendar-day"] as const) {
      probeStrategy(`quota(${resetCadence})`, () => quota({ limit: 100, resetCadence }));
    }
  });

  it("leakyBucket: subnormal/overflowing rate → throw or finite delayMs (never a schedule() hang)", () => {
    for (const ratePerSec of [TINY, SMALL, 1, HUGE]) {
      let shaper: ReturnType<typeof leakyBucket>;
      try {
        shaper = leakyBucket({ ratePerSec, maxQueueMs: 1000 });
      } catch (err) {
        expect(err, `leaky(rate=${ratePerSec}): a rejection must be a RangeError`).toBeInstanceOf(
          RangeError,
        );
        continue;
      }
      // A non-finite delayMs is the DoS: schedule() would sleep(Infinity) and never fire.
      for (let i = 0; i < 3; i++) {
        const r = shaper.reserveSync("k", 1);
        expect(
          Number.isFinite(r.delayMs),
          `leaky(rate=${ratePerSec}) reserve#${i}: delayMs=${r.delayMs}`,
        ).toBe(true);
        expect(r.delayMs).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
