import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { gcra } from "../../src/algorithms/gcra";
import { slidingWindow } from "../../src/algorithms/sliding-window";
import { slidingWindowLog } from "../../src/algorithms/sliding-window-log";
import { tokenBucket } from "../../src/algorithms/token-bucket";
import type { Decision, Strategy } from "../../src/core/types";

/**
 * Property-based proofs over each strategy's PURE `check()`. We drive a strategy as a state machine
 * across generated `(delta, cost)` timelines — exactly the read-modify-write a store performs,
 * minus I/O — and assert the invariants the rest of the system relies on (integer, non-negative
 * decision fields; the documented per-strategy admission bounds). `numRuns` is kept high enough to
 * exercise corners (boundary windows, jumps, fractional intervals) while staying fast.
 */

const NUM_RUNS = 150;

interface Step {
  /** Milliseconds to advance the clock before this request (>= 0; monotonic). */
  delta: number;
  /** Request cost. */
  cost: number;
}

/** Each request applied to the state machine: the decision plus the `now`/`cost` that produced it. */
interface Event {
  now: number;
  cost: number;
  decision: Decision;
}

/** A generated timeline of steps. Deltas span boundaries and idle gaps; costs stay small. */
const timeline = (maxCost: number): fc.Arbitrary<Step[]> =>
  fc.array(
    fc.record({
      delta: fc.integer({ min: 0, max: 2000 }),
      cost: fc.integer({ min: 1, max: maxCost }),
    }),
    { minLength: 1, maxLength: 40 },
  );

/**
 * Run `strategy.check` as a store would: thread the persisted state forward (only on `persist`),
 * advancing the clock by each step's `delta`. Returns the full event log for invariant checks.
 */
function run<S>(strategy: Strategy<S>, start: number, steps: Step[]): Event[] {
  let state: S | undefined;
  let now = start;
  const events: Event[] = [];
  for (const step of steps) {
    now += step.delta;
    const r = strategy.check(state, now, step.cost);
    if (r.persist) state = r.state;
    events.push({ now, cost: step.cost, decision: r.result });
  }
  return events;
}

/** The shape invariants every pass/deny strategy must satisfy on every decision. */
function assertDecisionShape(d: Decision): void {
  expect(Number.isInteger(d.remaining)).toBe(true);
  expect(d.remaining).toBeGreaterThanOrEqual(0);
  expect(Number.isInteger(d.resetAt)).toBe(true);
  expect(Number.isInteger(d.retryAfterMs)).toBe(true);
  expect(d.retryAfterMs).toBeGreaterThanOrEqual(0);
  // retryAfterMs is 0 exactly when the request was allowed.
  expect(d.retryAfterMs === 0).toBe(d.allowed);
}

interface StrategyCase {
  name: string;
  make: () => Strategy;
}

// A spread of small configurations exercised for the shared shape invariant.
const shapeCases: StrategyCase[] = [
  { name: "gcra", make: () => gcra({ limit: 5, periodMs: 1000, burst: 5 }) },
  { name: "tokenBucket", make: () => tokenBucket({ capacity: 8, refillPerSec: 4 }) },
  { name: "fixedWindow", make: () => fixedWindow({ limit: 5, windowMs: 1000 }) },
  { name: "slidingWindow", make: () => slidingWindow({ limit: 6, windowMs: 1000, buckets: 4 }) },
  { name: "slidingWindowLog", make: () => slidingWindowLog({ limit: 5, windowMs: 1000 }) },
];

describe("strategy invariants (property-based)", () => {
  describe("decision shape: integer, non-negative, retryAfter===0 iff allowed", () => {
    for (const c of shapeCases) {
      it(c.name, () => {
        fc.assert(
          fc.property(fc.integer({ min: 0, max: 1_000_000 }), timeline(3), (start, steps) => {
            for (const e of run(c.make(), start, steps)) {
              assertDecisionShape(e.decision);
            }
          }),
          { numRuns: NUM_RUNS },
        );
      });
    }
  });

  it("fixedWindow: allowed cost-1 requests within one aligned window never exceed limit", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }), // limit
        fc.integer({ min: 50, max: 2000 }), // windowMs
        fc.integer({ min: 0, max: 1_000_000 }), // start
        fc.array(fc.integer({ min: 0, max: 2000 }), { minLength: 1, maxLength: 50 }), // deltas
        (limit, windowMs, start, deltas) => {
          const strategy = fixedWindow({ limit, windowMs });
          const steps: Step[] = deltas.map((delta) => ({ delta, cost: 1 }));
          // Tally allowed cost-1 requests per epoch-aligned window; none may exceed `limit`.
          const allowedByWindow = new Map<number, number>();
          for (const e of run(strategy, start, steps)) {
            if (!e.decision.allowed) continue;
            const windowStart = Math.floor(e.now / windowMs) * windowMs;
            const n = (allowedByWindow.get(windowStart) ?? 0) + 1;
            allowedByWindow.set(windowStart, n);
            expect(n).toBeLessThanOrEqual(limit);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("slidingWindowLog: allowed in any trailing window never exceeds limit (exact)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }), // limit
        fc.integer({ min: 50, max: 2000 }), // windowMs
        fc.integer({ min: 0, max: 1_000_000 }), // start
        timeline(3), // (delta, cost) timeline
        (limit, windowMs, start, steps) => {
          const strategy = slidingWindowLog({ limit, windowMs });
          // The exact log of accepted unit-timestamps. For each accepted request, the count of
          // accepted units in its own trailing (now-windowMs, now] window must be <= limit.
          const accepted: number[] = [];
          for (const e of run(strategy, start, steps)) {
            if (!e.decision.allowed) continue;
            for (let i = 0; i < e.cost; i++) accepted.push(e.now);
            const windowStart = e.now - windowMs;
            const inWindow = accepted.filter((ts) => ts > windowStart).length;
            expect(inWindow).toBeLessThanOrEqual(limit);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("gcra: from cold at a fixed now, exactly `burst` unit requests are allowed before denial", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }), // limit
        // Emission interval per request, in ms. periodMs = limit * perReq makes T = periodMs/limit
        // an exact integer, so the cold-burst count is exact regardless of `now`. (With a
        // fractional T, repeated `+T` accumulation vs. the single `T*burst` can disagree by 1 ULP
        // at large `now` and shift the burst-th request across the boundary — an inherent
        // floating-point edge, not a logic bug.)
        fc.integer({ min: 1, max: 1200 }), // perReq
        fc.integer({ min: 1, max: 50 }), // burst
        fc.integer({ min: 0, max: 1_000_000 }), // now (fixed across this run)
        (limit, perReq, burst, now) => {
          const strategy = gcra({ limit, periodMs: limit * perReq, burst });
          // No time passes between requests, so a cold bucket admits exactly `burst` units, then
          // denies. Drive the pure check with state threaded forward but the clock held fixed.
          let state: number | undefined;
          let allowed = 0;
          for (let i = 0; i < burst + 5; i++) {
            const r = strategy.check(state, now, 1);
            if (r.result.allowed) {
              allowed++;
              if (r.persist) state = r.state;
            }
          }
          expect(allowed).toBe(burst);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
