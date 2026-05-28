/**
 * TK-1002 — combineDecisions + ALLOW_FULL algebraic-laws property test.
 *
 * Proves the four algebraic laws spelled out in
 * `research/bigger-bets/unified/DESIGN.md` §4.1.1 (D-U2) at numRuns ≥ 500
 * via fast-check, plus a small set of explicit unit cases that pin
 * field-by-field semantics (so a regression in `combineDecisions` shows
 * up as a readable assertion, not just a shrunken random counterexample).
 *
 * The laws together guarantee:
 * - `combineDecisions` extends to N inputs via `reduce` (associativity +
 *   commutativity ⇒ order-independent reduction);
 * - the Lua-fused fast path (TK-1005) is free to re-order its checks
 *   without changing the result;
 * - duplicate-check retries are safe (idempotency);
 * - missing axes contribute nothing (identity with ALLOW_FULL).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ALLOW_FULL, combineDecisions } from "../../src/core/combine";
import type { Decision } from "../../src/core/types";

/** Number of random samples per property — DESIGN.md §4.1.1 sets the floor. */
const NUM_RUNS = 500;

/**
 * Generate an arbitrary {@link Decision} with integer fields in `[0, MAX_SAFE_INTEGER]`.
 * The integer ranges match the project's bit-identity guarantee
 * (`src/core/types.ts` §16-17): every numeric field is an integer so JS and
 * Redis-Lua paths agree byte-for-byte.
 */
const decisionArb: fc.Arbitrary<Decision> = fc.record({
  allowed: fc.boolean(),
  limit: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
  remaining: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
  resetAt: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
  retryAfterMs: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
});

/** Structural equality on Decisions — field-by-field, no reference identity. */
function decisionsEqual(a: Decision, b: Decision): boolean {
  return (
    a.allowed === b.allowed &&
    a.limit === b.limit &&
    a.remaining === b.remaining &&
    a.resetAt === b.resetAt &&
    a.retryAfterMs === b.retryAfterMs
  );
}

describe("ALLOW_FULL", () => {
  it("is the maximally permissive decision (allowed, MAX_SAFE_INTEGER ceilings, zero waits)", () => {
    expect(ALLOW_FULL).toEqual({
      allowed: true,
      limit: Number.MAX_SAFE_INTEGER,
      remaining: Number.MAX_SAFE_INTEGER,
      resetAt: 0,
      retryAfterMs: 0,
    });
  });

  it("uses MAX_SAFE_INTEGER (not Infinity) for limit/remaining — preserves integer bit-identity", () => {
    // Not Infinity: the algebra must produce integers, and Infinity would
    // poison the bit-identity guarantee shared with the Lua execution path.
    expect(Number.isSafeInteger(ALLOW_FULL.limit)).toBe(true);
    expect(Number.isSafeInteger(ALLOW_FULL.remaining)).toBe(true);
  });
});

describe("combineDecisions — field-by-field semantics (explicit cases)", () => {
  /** A representative non-neutral decision used across the explicit cases below. */
  const d: Decision = {
    allowed: true,
    limit: 100,
    remaining: 42,
    resetAt: 1_000,
    retryAfterMs: 0,
  };
  const denied: Decision = {
    allowed: false,
    limit: 50,
    remaining: 0,
    resetAt: 5_000,
    retryAfterMs: 250,
  };

  it("ANDs allowed: allow + allow = allow", () => {
    expect(combineDecisions(d, d).allowed).toBe(true);
  });

  it("ANDs allowed: allow + deny = deny", () => {
    expect(combineDecisions(d, denied).allowed).toBe(false);
    expect(combineDecisions(denied, d).allowed).toBe(false);
  });

  it("ANDs allowed: deny + deny = deny", () => {
    expect(combineDecisions(denied, denied).allowed).toBe(false);
  });

  it("takes MIN of limit (binding ceiling)", () => {
    expect(combineDecisions(d, denied).limit).toBe(50);
  });

  it("takes MIN of remaining (binding remainder)", () => {
    expect(combineDecisions(d, denied).remaining).toBe(0);
  });

  it("takes MAX of resetAt (latest-resolution wait)", () => {
    expect(combineDecisions(d, denied).resetAt).toBe(5_000);
  });

  it("takes MAX of retryAfterMs (dominant wait — never under-state)", () => {
    expect(combineDecisions(d, denied).retryAfterMs).toBe(250);
  });
});

describe("combineDecisions — algebraic laws (property-based, numRuns ≥ 500)", () => {
  // Law 1 — Identity: combine(d, ALLOW_FULL) = d.
  it("identity (right): combine(d, ALLOW_FULL) = d", () => {
    fc.assert(
      fc.property(decisionArb, (d) => decisionsEqual(combineDecisions(d, ALLOW_FULL), d)),
      { numRuns: NUM_RUNS },
    );
  });

  // Identity from the left too — strictly implied by commutativity + right-identity,
  // but proving both directions catches an asymmetric implementation bug eagerly.
  it("identity (left): combine(ALLOW_FULL, d) = d", () => {
    fc.assert(
      fc.property(decisionArb, (d) => decisionsEqual(combineDecisions(ALLOW_FULL, d), d)),
      { numRuns: NUM_RUNS },
    );
  });

  // Law 2 — Commutativity: combine(a, b) = combine(b, a).
  // Operationally: axis evaluation order doesn't change the result.
  it("commutativity: combine(a, b) = combine(b, a)", () => {
    fc.assert(
      fc.property(decisionArb, decisionArb, (a, b) =>
        decisionsEqual(combineDecisions(a, b), combineDecisions(b, a)),
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Law 3 — Associativity: combine(combine(a, b), c) = combine(a, combine(b, c)).
  // Operationally: N inputs reduce flat regardless of parenthesization;
  // sequential vs Lua-fused (which re-orders) produce the same result.
  it("associativity: combine(combine(a, b), c) = combine(a, combine(b, c))", () => {
    fc.assert(
      fc.property(decisionArb, decisionArb, decisionArb, (a, b, c) =>
        decisionsEqual(
          combineDecisions(combineDecisions(a, b), c),
          combineDecisions(a, combineDecisions(b, c)),
        ),
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Law 4 — Idempotency: combine(d, d) = d. A retried sub-check is safe.
  it("idempotency: combine(d, d) = d", () => {
    fc.assert(
      fc.property(decisionArb, (d) => decisionsEqual(combineDecisions(d, d), d)),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("combineDecisions — N-ary reduction (consequence of the 4 laws)", () => {
  it("reduces over an arbitrary array seeded with ALLOW_FULL", () => {
    fc.assert(
      fc.property(fc.array(decisionArb, { minLength: 0, maxLength: 8 }), (ds) => {
        const folded = ds.reduce(combineDecisions, ALLOW_FULL);
        // Equivalent expression: fold from the right; associativity says they agree.
        const foldedRight = ds.reduceRight((acc, d) => combineDecisions(d, acc), ALLOW_FULL);
        return decisionsEqual(folded, foldedRight);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("an empty reduction returns ALLOW_FULL (no axes configured ⇒ admit by default)", () => {
    const ds: Decision[] = [];
    expect(ds.reduce(combineDecisions, ALLOW_FULL)).toEqual(ALLOW_FULL);
  });
});
