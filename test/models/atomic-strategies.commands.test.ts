import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { gcra } from "../../src/algorithms/gcra";
import { tokenBucket } from "../../src/algorithms/token-bucket";
import { ManualClock } from "../../src/core/clock";
import { decisionTransform } from "../../src/core/transform";
import type { Decision, Strategy } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";

/**
 * Model-based (fc.commands) tests for the three atomic strategies whose state is threaded by a store
 * read-modify-write: gcra, tokenBucket, fixedWindow.
 *
 * Two independent flavors per strategy:
 *
 *  A. **model-vs-impl** — a generated `check/advanceClock/reset` sequence is driven against the real
 *     `strategy.check` threaded with persist-gating AND against a small reference state-machine; the
 *     full {@link Decision} must be byte-identical at every step. The fixedWindow reference is
 *     integer-exact (a genuinely independent re-derivation). The gcra reference is pinned to an
 *     integer emission interval (`periodMs = limit·perReq` ⇒ `T` integer) so every field is exact
 *     integer arithmetic — no float ULP divergence (the trap documented in
 *     `test/property/invariants.test.ts`). The tokenBucket reference mirrors the float token
 *     recurrence in the same evaluation order, so it is byte-identical by IEEE-754 determinism — a
 *     mutation/regression net for the decision-field derivations + state threading.
 *
 *  B. **store-equivalence** — the SAME generated sequence driven against (1) the real strategy
 *     threaded as a pure state machine and (2) the real strategy behind a real {@link MemoryStore}
 *     (persist + TTL expiry + reset). Both must agree byte-for-byte at every step. This needs no
 *     reference math (both sides are the production `check`), so it is a fully independent check of
 *     the persist / TTL-expiry / reset interaction, across arbitrary (non-integer-`T`) configs.
 */

const SEED = 0x7a11c0de;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Command harness. The model is a reference state machine; the real is the strategy threaded with
// persist-gating, plus a ManualClock. AdvanceClock moves only the clock (the model reads `now` from
// the clock via the check command), so model and impl always see the exact same instant.
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface Ref {
  check(now: number, cost: number): Decision;
  reset(): void;
}

interface Real {
  clock: ManualClock;
  strategy: Strategy<unknown>;
  state: unknown;
}

type Cmd = fc.Command<Ref, Real>;

class CheckCommand implements Cmd {
  constructor(readonly cost: number) {}
  check(): boolean {
    return true;
  }
  run(model: Ref, real: Real): void {
    const now = real.clock.now();
    const out = real.strategy.check(real.state, now, this.cost);
    if (out.persist) real.state = out.state;
    const expected = model.check(now, this.cost);
    expect(out.result).toEqual(expected);
  }
  toString(): string {
    return `check(cost=${this.cost})`;
  }
}

class AdvanceCommand implements Cmd {
  constructor(readonly ms: number) {}
  check(): boolean {
    return true;
  }
  run(_model: Ref, real: Real): void {
    real.clock.advance(this.ms);
  }
  toString(): string {
    return `advanceClock(${this.ms})`;
  }
}

class ResetCommand implements Cmd {
  check(): boolean {
    return true;
  }
  run(model: Ref, real: Real): void {
    real.state = undefined;
    model.reset();
  }
  toString(): string {
    return "reset()";
  }
}

/** Command arbitrary biased ~62% check / 25% advance / 13% reset (so window rolls + idle gaps fire). */
function commandArb(maxCost: number, maxAdvance: number): fc.Arbitrary<Cmd>[] {
  const check = fc.integer({ min: 1, max: maxCost }).map((c) => new CheckCommand(c));
  const advance = fc.integer({ min: 0, max: maxAdvance }).map((ms) => new AdvanceCommand(ms));
  const reset = fc.constant(new ResetCommand());
  // Repeats bias the per-slot selection toward checks.
  return [check, check, check, check, check, advance, advance, reset];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reference state machines (independent re-derivations of each strategy's `check`).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Integer-exact fixedWindow reference. windowStart, resetAt, count are all integers ⇒ no float. */
function fixedWindowRef(limit: number, windowMs: number): Ref {
  let start: number | undefined;
  let count = 0;
  return {
    check(now: number, cost: number): Decision {
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const resetAt = windowStart + windowMs;
      const cur = start === windowStart ? count : 0;
      if (cur + cost <= limit) {
        const newCount = cur + cost;
        start = windowStart;
        count = newCount;
        return {
          allowed: true,
          limit,
          remaining: Math.max(0, limit - newCount),
          resetAt,
          retryAfterMs: 0,
        };
      }
      // Deny: impl persists nothing, so the stored (start,count) stays as-is.
      return {
        allowed: false,
        limit,
        remaining: Math.max(0, limit - cur),
        resetAt,
        retryAfterMs: resetAt - now,
      };
    },
    reset(): void {
      start = undefined;
      count = 0;
    },
  };
}

/**
 * Integer-exact gcra reference. Caller MUST pass `periodMs = limit·perReq` so `T = periodMs/limit`
 * is an integer; then tat / newTat / tau / allowAt are all integers and floor(.../T) is exact.
 */
function gcraRef(limit: number, periodMs: number, burst: number): Ref {
  const T = periodMs / limit; // integer by construction
  const tau = T * burst;
  let tat: number | undefined;
  return {
    check(now: number, cost: number): Decision {
      const inc = T * cost;
      const t = tat ?? now;
      const tatEff = t > now ? t : now;
      const newTat = tatEff + inc;
      const allowAt = newTat - tau;
      if (now < allowAt) {
        let remaining = Math.floor((tau - (tatEff - now)) / T);
        if (remaining < 0) remaining = 0;
        return {
          allowed: false,
          limit: burst,
          remaining,
          resetAt: Math.ceil(tatEff),
          retryAfterMs: Math.ceil(allowAt - now),
        };
      }
      let remaining = Math.floor((tau - (newTat - now)) / T);
      if (remaining < 0) remaining = 0;
      tat = newTat;
      return {
        allowed: true,
        limit: burst,
        remaining,
        resetAt: Math.ceil(newTat),
        retryAfterMs: 0,
      };
    },
    reset(): void {
      tat = undefined;
    },
  };
}

/** tokenBucket reference — mirrors the float recurrence in the impl's exact op order (byte-identical). */
function tokenBucketRef(capacity: number, refillPerSec: number): Ref {
  const refillPerMs = refillPerSec / 1000;
  let tokens: number | undefined;
  let last: number | undefined;
  return {
    check(now: number, cost: number): Decision {
      const prevTokens = tokens ?? capacity;
      const lastT = last ?? now;
      const elapsed = now > lastT ? now - lastT : 0;
      const cur = Math.min(capacity, prevTokens + elapsed * refillPerMs);
      if (cur >= cost) {
        const newTokens = cur - cost;
        let remaining = Math.floor(newTokens);
        if (remaining < 0) remaining = 0;
        tokens = newTokens;
        last = now;
        return {
          allowed: true,
          limit: capacity,
          remaining,
          resetAt: now + Math.ceil((capacity - newTokens) / refillPerMs),
          retryAfterMs: 0,
        };
      }
      let remaining = Math.floor(cur);
      if (remaining < 0) remaining = 0;
      return {
        allowed: false,
        limit: capacity,
        remaining,
        resetAt: now + Math.ceil((capacity - cur) / refillPerMs),
        retryAfterMs: Math.ceil((cost - cur) / refillPerMs),
      };
    },
    reset(): void {
      tokens = undefined;
      last = undefined;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A. model-vs-impl — byte-identical Decision.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("atomic strategies — model-vs-impl (byte-identical Decision over command sequences)", () => {
  it("fixedWindow (integer-exact reference)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }), // limit
        fc.integer({ min: 50, max: 2000 }), // windowMs
        fc.integer({ min: 0, max: 1_000_000 }), // start epoch-ms
        fc.commands(commandArb(/*maxCost*/ 6, /*maxAdvance*/ 4000), { maxCommands: 60 }),
        (limit, windowMs, startMs, cmds) => {
          fc.modelRun(
            () => ({
              model: fixedWindowRef(limit, windowMs),
              real: {
                clock: new ManualClock(startMs),
                strategy: fixedWindow({ limit, windowMs }) as Strategy<unknown>,
                state: undefined,
              },
            }),
            cmds,
          );
        },
      ),
      { numRuns: 400, seed: SEED },
    );
  });

  it("gcra (integer emission interval ⇒ exact reference)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }), // limit
        fc.integer({ min: 1, max: 500 }), // perReq ⇒ periodMs = limit·perReq, T = perReq
        fc.integer({ min: 1, max: 12 }), // burst
        fc.integer({ min: 0, max: 1_000_000 }), // start
        fc.commands(commandArb(/*maxCost*/ 14, /*maxAdvance*/ 6000), { maxCommands: 60 }),
        (limit, perReq, burst, startMs, cmds) => {
          const periodMs = limit * perReq;
          fc.modelRun(
            () => ({
              model: gcraRef(limit, periodMs, burst),
              real: {
                clock: new ManualClock(startMs),
                strategy: gcra({ limit, periodMs, burst }) as Strategy<unknown>,
                state: undefined,
              },
            }),
            cmds,
          );
        },
      ),
      { numRuns: 400, seed: SEED },
    );
  });

  it("tokenBucket (float-recurrence mirror — Stryker/regression net)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }), // capacity
        fc.integer({ min: 1, max: 5000 }), // refillPerSec
        fc.integer({ min: 0, max: 1_000_000 }), // start
        fc.commands(commandArb(/*maxCost*/ 14, /*maxAdvance*/ 6000), { maxCommands: 60 }),
        (capacity, refillPerSec, startMs, cmds) => {
          fc.modelRun(
            () => ({
              model: tokenBucketRef(capacity, refillPerSec),
              real: {
                clock: new ManualClock(startMs),
                strategy: tokenBucket({ capacity, refillPerSec }) as Strategy<unknown>,
                state: undefined,
              },
            }),
            cmds,
          );
        },
      ),
      { numRuns: 400, seed: SEED },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B. store-equivalence — pure-threaded `check` ≡ real MemoryStore (persist + TTL expiry + reset).
// No reference math: both sides run the production `check`, so this independently exercises the
// store's persist/expiry/reset path against the strategy's own jump-safe cold-start semantics,
// across arbitrary configs (including non-integer `T` / fractional refill).
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface RealPair {
  clock: ManualClock;
  strategy: Strategy<unknown>;
  pureState: unknown;
  store: MemoryStore;
  key: string;
}

class CheckPair implements fc.Command<object, RealPair> {
  constructor(readonly cost: number) {}
  check(): boolean {
    return true;
  }
  run(_m: object, r: RealPair): void {
    const now = r.clock.now();
    const pure = r.strategy.check(r.pureState, now, this.cost);
    if (pure.persist) r.pureState = pure.state;
    const viaStore = r.store.applySync(r.key, decisionTransform(r.strategy, now, this.cost), now);
    expect(viaStore).toEqual(pure.result);
  }
  toString(): string {
    return `check(cost=${this.cost})`;
  }
}

class AdvancePair implements fc.Command<object, RealPair> {
  constructor(readonly ms: number) {}
  check(): boolean {
    return true;
  }
  run(_m: object, r: RealPair): void {
    r.clock.advance(this.ms);
  }
  toString(): string {
    return `advanceClock(${this.ms})`;
  }
}

class ResetPair implements fc.Command<object, RealPair> {
  check(): boolean {
    return true;
  }
  run(_m: object, r: RealPair): void {
    r.pureState = undefined;
    r.store.resetSync(r.key);
  }
  toString(): string {
    return "reset()";
  }
}

function pairCommands(
  maxCost: number,
  maxAdvance: number,
): fc.Arbitrary<fc.Command<object, RealPair>>[] {
  const check = fc.integer({ min: 1, max: maxCost }).map((c) => new CheckPair(c));
  const advance = fc.integer({ min: 0, max: maxAdvance }).map((ms) => new AdvancePair(ms));
  const reset = fc.constant(new ResetPair());
  return [check, check, check, check, check, advance, advance, reset];
}

describe("atomic strategies — store-equivalence (pure-threaded ≡ MemoryStore, byte-identical)", () => {
  const make = (
    label: string,
    strategyArb: fc.Arbitrary<Strategy<unknown>>,
    maxCost: number,
    maxAdvance: number,
  ): void => {
    it(label, () => {
      fc.assert(
        fc.property(
          strategyArb,
          fc.integer({ min: 0, max: 1_000_000 }),
          fc.commands(pairCommands(maxCost, maxAdvance), { maxCommands: 60 }),
          (strategy, startMs, cmds) => {
            const clock = new ManualClock(startMs);
            fc.modelRun(
              () => ({
                model: {},
                real: {
                  clock,
                  strategy,
                  pureState: undefined,
                  // sweepIntervalMs:0 ⇒ no background timer; expiry is purely access-driven & clock-pinned.
                  store: new MemoryStore({ clock, sweepIntervalMs: 0 }),
                  key: "k",
                },
              }),
              cmds,
            );
          },
        ),
        { numRuns: 300, seed: SEED },
      );
    });
  };

  make(
    "gcra (arbitrary config, incl. non-integer T)",
    fc
      .record({
        limit: fc.integer({ min: 1, max: 20 }),
        periodMs: fc.integer({ min: 10, max: 5000 }),
        burst: fc.integer({ min: 1, max: 20 }),
      })
      .map((o) => gcra(o) as Strategy<unknown>),
    14,
    6000,
  );

  make(
    "tokenBucket (arbitrary config, incl. fractional refill)",
    fc
      .record({
        capacity: fc.integer({ min: 1, max: 20 }),
        refillPerSec: fc.integer({ min: 1, max: 9999 }),
      })
      .map((o) => tokenBucket(o) as Strategy<unknown>),
    14,
    6000,
  );

  make(
    "fixedWindow (arbitrary config)",
    fc
      .record({
        limit: fc.integer({ min: 1, max: 20 }),
        windowMs: fc.integer({ min: 20, max: 4000 }),
      })
      .map((o) => fixedWindow(o) as Strategy<unknown>),
    8,
    8000,
  );
});
