import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { tokenBudget } from "../../src/admission";
import { ManualClock } from "../../src/core/clock";
import type { Decision } from "../../src/core/types";
import { simulate } from "../cost/token-budget";

/**
 * The shipped streaming token-budget meter (TALE Layer 1; design + proofs in
 * research/cost-uncertainty/PROPOSAL.md). The headline property — worst-case overshoot bounded by
 * the debit granularity (exactly 0 per token), INDEPENDENT of the per-request cap and of how many
 * streams meter concurrently — is pinned directly and then cross-checked against the research
 * `simulate(..., "streaming")` kernel for byte-identical overshoot.
 */

const NUM_RUNS = 200;
const HUGE_WINDOW = 1_000_000_000_000; // one logical window; tests never advance the clock into a roll

/** Assert a Decision is structurally well-formed per the core `Decision` contract. */
function expectValidDecision(d: Decision): void {
  expect(typeof d.allowed).toBe("boolean");
  for (const v of [d.limit, d.remaining, d.resetAt, d.retryAfterMs]) {
    expect(Number.isInteger(v)).toBe(true);
  }
  expect(d.remaining).toBeGreaterThanOrEqual(0);
  expect(d.remaining).toBeLessThanOrEqual(d.limit);
  expect(d.retryAfterMs === 0).toBe(d.allowed); // retryAfterMs == 0 iff allowed
  expect(d.retryAfterMs).toBeGreaterThanOrEqual(0);
}

/**
 * Drive `meter` with the SAME admission/production loop as the research `simulate(..., "streaming")`
 * kernel: `C` slots pull stream lengths off `queue`, each producing `g` tokens per round and
 * metering them; a stream is admitted only while budget remains, and stops the instant a debit is
 * refused. Returns the externally-measured overshoot (total admitted tokens − L), which must equal
 * the kernel's `overshoot` for identical inputs.
 */
function driveLikeSimulate(
  meter: ReturnType<typeof tokenBudget>,
  queue: readonly number[],
  L: number,
  C: number,
  g: number,
  rounds: number,
): number {
  const slot = new Array<{ produced: number; total: number } | null>(C).fill(null);
  let qi = 0;
  let served = 0; // external mirror of the meter's internal counter (sum of admitted pieces)
  const admit = (): void => {
    for (let s = 0; s < C; s++) {
      if (slot[s] !== null) continue;
      if (qi >= queue.length || meter.remaining() <= 0) return; // canAdmit: served < L
      slot[s] = { produced: 0, total: queue[qi] as number };
      qi++;
    }
  };
  admit();
  for (let r = 0; r < rounds; r++) {
    for (let s = 0; s < C; s++) {
      const sl = slot[s];
      if (!sl) continue;
      const piece = Math.min(g, sl.total - sl.produced);
      const d = meter.debitSync(piece);
      if (!d.allowed) {
        slot[s] = null; // budget already spent — stop this stream (mirrors simulate's served>=L drop)
        continue;
      }
      served += piece;
      sl.produced += piece;
      if (sl.produced >= sl.total) slot[s] = null;
    }
    admit();
  }
  return Math.max(0, served - L);
}

describe("tokenBudget — config validation", () => {
  it("rejects non-positive budget and windowMs", () => {
    expect(() => tokenBudget({ budget: 0, windowMs: 1000 })).toThrow(RangeError);
    expect(() => tokenBudget({ budget: -1, windowMs: 1000 })).toThrow(RangeError);
    expect(() => tokenBudget({ budget: 100, windowMs: 0 })).toThrow(RangeError);
    expect(() => tokenBudget({ budget: 100, windowMs: -5 })).toThrow(RangeError);
    expect(() => tokenBudget({ budget: Number.POSITIVE_INFINITY, windowMs: 1000 })).toThrow(
      RangeError,
    );
  });

  it("rejects non-positive and non-integer token debits", () => {
    const m = tokenBudget({ budget: 100, windowMs: 1000, clock: new ManualClock(0) });
    expect(() => m.debitSync(0)).toThrow(RangeError);
    expect(() => m.debitSync(-1)).toThrow(RangeError);
    expect(() => m.debitSync(1.5)).toThrow(RangeError); // tokens are whole units
    expect(() => m.debitSync(Number.NaN)).toThrow(RangeError);
  });

  it("async debit() delivers an invalid-token error as a rejected promise, not a sync throw", () => {
    // Regression: debit() was `return Promise.resolve(debitSync(tokens))`, so the eager debitSync throw
    // escaped at the call site BEFORE a promise existed — a `meter.debit(bad).catch(h)` threw instead of
    // rejecting. It must mirror distributedTokenBudget.debit and always return a (rejected) promise.
    const m = tokenBudget({ budget: 100, windowMs: 1000, clock: new ManualClock(0) });
    return Promise.all([
      expect(m.debit(0)).rejects.toThrow(RangeError),
      expect(m.debit(-1)).rejects.toThrow(RangeError),
      expect(m.debit(1.5)).rejects.toThrow(RangeError),
      expect(m.debit(Number.NaN)).rejects.toThrow(RangeError),
    ]);
  });

  it("rejects a fractional budget in (0,1) that would floor to L=0 (deny-all)", () => {
    // Regression: requirePositive admits 0.5, but Math.floor(0.5) = 0, and the `served >= L` rule then
    // denied every debit (limit:0 forever) instead of failing fast. The budget must floor to L >= 1.
    expect(() => tokenBudget({ budget: 0.5, windowMs: 60_000 })).toThrow(/>= 1/);
    expect(() => tokenBudget({ budget: 0.999, windowMs: 60_000 })).toThrow(RangeError);
  });

  it("a valid fractional budget still floors and admits the floored count", () => {
    // budget 1.9 floors to L=1 and must admit exactly one debit (the floor-of-a-valid-fraction control).
    const m = tokenBudget({ budget: 1.9, windowMs: 60_000, clock: new ManualClock(0) });
    expect(m.debitSync(1)).toMatchObject({ allowed: true, limit: 1 });
    expect(m.debitSync(1).allowed).toBe(false);
  });
});

describe("tokenBudget — per-token metering (the headline: Δ = 0)", () => {
  it("admits exactly the budget then refuses, with a well-formed Decision throughout", () => {
    const clock = new ManualClock(0);
    const meter = tokenBudget({ budget: 5, windowMs: 1000, clock });
    const remainders: number[] = [];
    let allowedCount = 0;
    for (let i = 0; i < 8; i++) {
      const d = meter.debitSync(1);
      expectValidDecision(d);
      expect(d.limit).toBe(5);
      if (d.allowed) {
        allowedCount++;
        remainders.push(d.remaining);
      }
    }
    expect(allowedCount).toBe(5); // exactly the budget, never one more
    expect(remainders).toEqual([4, 3, 2, 1, 0]); // monotone drain to zero
  });

  it("a refused debit reports retryAfterMs to the window boundary", () => {
    const clock = new ManualClock(0);
    const meter = tokenBudget({ budget: 2, windowMs: 1000, clock });
    expect(meter.debitSync(1).allowed).toBe(true);
    expect(meter.debitSync(1).allowed).toBe(true);
    clock.set(400); // 400ms into the [0,1000) window
    const refused = meter.debitSync(1);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.resetAt).toBe(1000);
    expect(refused.retryAfterMs).toBe(600); // 1000 − 400
  });
});

describe("tokenBudget — overshoot bounded by debit granularity Δ ≤ g−1", () => {
  it("the tight worst case: a size-g debit crossing at served = L−1 overshoots by exactly g−1", () => {
    const g = 4;
    const L = 10;
    const meter = tokenBudget({ budget: L, windowMs: HUGE_WINDOW, clock: new ManualClock(0) });
    for (let i = 0; i < L - 1; i++) meter.debitSync(1); // served = 9 = L−1
    const crossing = meter.debitSync(g); // 9 → 13
    expect(crossing.allowed).toBe(true); // budget remained before it, so it is counted in full
    expect(crossing.remaining).toBe(0);
    expect(meter.debitSync(1).allowed).toBe(false); // now served ≥ L: refused
    // External overshoot = served − L = 13 − 10 = 3 = g − 1 (the tight bound).
  });

  it("only ONE debit can ever cross the boundary, regardless of concurrency width", () => {
    // Many slots in the same round: once one debit reaches L, every later debit is refused.
    for (const C of [1, 4, 37, 256]) {
      const L = 50;
      const g = 8;
      const meter = tokenBudget({ budget: L, windowMs: HUGE_WINDOW, clock: new ManualClock(0) });
      const queue = new Array(C * 4).fill(g); // each "stream" is exactly one g-sized debit
      const overshoot = driveLikeSimulate(meter, queue, L, C, g, L + 100);
      expect(overshoot).toBeLessThanOrEqual(g - 1); // C-independent bound
    }
  });
});

describe("tokenBudget — independence from the per-request cap (max_tokens)", () => {
  it("per-token metering hits exactly the budget for any stream-length distribution", () => {
    // Same budget, wildly different "max_tokens" (max stream length): overshoot stays 0, util full.
    for (const maxLen of [4, 64, 1024, 100_000]) {
      const L = 200;
      const meter = tokenBudget({ budget: L, windowMs: HUGE_WINDOW, clock: new ManualClock(0) });
      const queue = new Array(50).fill(maxLen); // every request runs to the (huge) cap
      const overshoot = driveLikeSimulate(meter, queue, L, 4, 1, L + maxLen + 10);
      expect(overshoot).toBe(0); // independent of maxLen — the meter never reserves the cap
      expect(meter.remaining()).toBe(0); // budget fully spent (utilization 1)
    }
  });
});

describe("tokenBudget — window roll and reset", () => {
  it("refreshes the budget when the epoch-aligned window rolls", () => {
    const clock = new ManualClock(0);
    const meter = tokenBudget({ budget: 3, windowMs: 1000, clock });
    expect(meter.debitSync(3).allowed).toBe(true); // spend the whole budget
    expect(meter.debitSync(1).allowed).toBe(false); // exhausted
    expect(meter.remaining()).toBe(0);
    clock.set(1000); // next window [1000, 2000)
    expect(meter.remaining()).toBe(3); // refreshed
    const d = meter.debitSync(1);
    expect(d.allowed).toBe(true);
    expect(d.resetAt).toBe(2000);
  });

  it("reset() forgets usage and starts a fresh window immediately", () => {
    const clock = new ManualClock(500);
    const meter = tokenBudget({ budget: 3, windowMs: 1000, clock });
    expect(meter.debitSync(3).allowed).toBe(true);
    expect(meter.debitSync(1).allowed).toBe(false);
    meter.reset();
    expect(meter.remaining()).toBe(3);
    expect(meter.debitSync(1).allowed).toBe(true);
  });

  it("remaining() is non-mutating", () => {
    const meter = tokenBudget({ budget: 10, windowMs: HUGE_WINDOW, clock: new ManualClock(0) });
    meter.debitSync(4);
    expect(meter.remaining()).toBe(6);
    expect(meter.remaining()).toBe(6); // reading it again does not debit
    meter.debitSync(6);
    expect(meter.remaining()).toBe(0);
  });

  it("debit() resolves to the same Decision as debitSync()", async () => {
    const meter = tokenBudget({ budget: 5, windowMs: HUGE_WINDOW, clock: new ManualClock(0) });
    const a = await meter.debit(2);
    expect(a.allowed).toBe(true);
    expect(a.remaining).toBe(3);
  });
});

describe("tokenBudget — byte-identical to the research streaming kernel", () => {
  it("matches simulate(..., 'streaming') overshoot, with Δ ≤ g−1 and Δ = 0 at g = 1", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 200 }), // budget L
        fc.integer({ min: 1, max: 8 }), // concurrency C
        fc.integer({ min: 1, max: 16 }), // chunk g
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 200 }), // lengths
        (L, C, g, queue) => {
          const maxLen = Math.max(...queue);
          const rounds = L + maxLen + 10;
          // Research kernel with an effectively-infinite cap so it streams the raw lengths.
          const kernel = simulate(queue, {
            budget: L,
            slots: C,
            maxTokens: maxLen,
            chunk: g,
            rounds,
            scheme: "streaming",
          });
          const meter = tokenBudget({
            budget: L,
            windowMs: HUGE_WINDOW,
            clock: new ManualClock(0),
          });
          const overshoot = driveLikeSimulate(meter, queue, L, C, g, rounds);
          expect(overshoot).toBe(kernel.overshoot); // the shipped meter reproduces the kernel exactly
          expect(overshoot).toBeLessThanOrEqual(g - 1); // the proven bound
          if (g === 1) expect(overshoot).toBe(0); // per-token metering never overshoots
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
