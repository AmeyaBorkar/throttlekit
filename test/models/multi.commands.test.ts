import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { gcra } from "../../src/algorithms/gcra";
import { slidingWindow } from "../../src/algorithms/sliding-window";
import { slidingWindowLog } from "../../src/algorithms/sliding-window-log";
import { tokenBucket } from "../../src/algorithms/token-bucket";
import { ManualClock } from "../../src/core/clock";
import type { Decision, Strategy } from "../../src/core/types";
import { type Dimensions, all, any, multiRateLimit } from "../../src/multi";
import { MemoryStore } from "../../src/stores/memory";

/**
 * Model-based (fc.commands) tests for `multiRateLimit` over the synchronous MemoryStore path
 * (`runSync` — read-all → decide → commit-none/all), the seam where the composite sequencing bugs
 * live. Flavor: invariant-based stateful. The model tracks only what the documented guarantees need.
 *
 * Guarantees asserted at EVERY step over random dimensions / strategies / costs / contexts / time:
 *
 *  - **DENY ⇒ no advance (core-01):** on a composite DENY, NOT ONE sub-dimension's stored state may
 *    change. We snapshot a deep clone of every dimension's persisted state before and after each
 *    check (at the SAME `now`, so refill/roll can't confound) and require byte-equality on deny.
 *    This is the exact failure mode of the original bug: an in-place-mutating dimension
 *    (`slidingWindow` bumps its ring during the read phase) partial-consuming while the composite
 *    denied on another dimension — so `slidingWindow` is deliberately in the strategy pool.
 *
 *  - **ALLOW ⇒ no free capacity:** on an ALLOW, no dimension's state may move "backwards" (a
 *    committed check can only consume). Checked as: every dimension's non-consuming `remaining`
 *    at the post-`now` is ≤ its pre-`now` remaining.
 *
 *  - **reset clears ALL dimensions (multi-02):** after `limiter.reset(ctx)`, every dimension key for
 *    that context is gone from the store (`store.has(fk) === false`) — no dimension is left behind,
 *    including under a configured key prefix.
 *
 *  - **decision shape:** `retryAfterMs === 0` iff `allowed`; integer non-negative fields.
 */

const SEED = 0x5eed_3c01;

type StratName = "gcra" | "tokenBucket" | "fixedWindow" | "slidingWindow" | "slidingWindowLog";

/** Small-config strategy factory keyed by name. Limits kept small so denials are frequent. */
function makeStrategy(name: StratName): Strategy {
  switch (name) {
    case "gcra":
      return gcra({ limit: 3, periodMs: 1000, burst: 2 });
    case "tokenBucket":
      return tokenBucket({ capacity: 3, refillPerSec: 4 });
    case "fixedWindow":
      return fixedWindow({ limit: 3, windowMs: 1000 });
    case "slidingWindow":
      return slidingWindow({ limit: 4, windowMs: 1000, buckets: 4 });
    case "slidingWindowLog":
      return slidingWindowLog({ limit: 4, windowMs: 1000 });
  }
}

const STRAT_NAMES: StratName[] = [
  "gcra",
  "tokenBucket",
  "fixedWindow",
  "slidingWindow",
  "slidingWindowLog",
];

interface Ctx {
  parts: string[];
}

interface DimSpec {
  name: string;
  /** Index into ctx.parts this dimension keys on. */
  idx: number;
  strat: StratName;
  weight: number;
}

interface Real {
  clock: ManualClock;
  store: MemoryStore;
  dims: DimSpec[];
  prefix: string | undefined;
  // The strategy instances actually wired into the limiter (peek uses these exact instances).
  strategies: Map<string, Strategy>;
  limiter: ReturnType<typeof multiRateLimit<Ctx>>;
}

/** Reproduce multiRateLimit's keyOf: `${prefix}:${name}:${raw}` (or `${name}:${raw}` with no prefix). */
function keyOf(prefix: string | undefined, name: string, raw: string): string {
  return prefix !== undefined && prefix.length > 0 ? `${prefix}:${name}:${raw}` : `${name}:${raw}`;
}

/** Deep clone of the dimension's persisted state at `now` (drops expired exactly as a check would). */
function snapshotState(r: Real, fk: string, now: number): unknown {
  let snap: unknown;
  r.store.applySync(
    fk,
    (state) => {
      snap = state === null || typeof state !== "object" ? state : structuredClone(state);
      return { state, result: undefined, ttlMs: 0, persist: false };
    },
    now,
  );
  return snap;
}

/** Non-consuming `remaining` for the dimension's persisted state at `now`. */
function remainingOf(r: Real, fk: string, strategy: Strategy, now: number): number {
  let rem = strategy.peek ? strategy.peek(undefined, now).remaining : 0;
  r.store.applySync(
    fk,
    (state) => {
      rem = strategy.peek ? strategy.peek(state as never, now).remaining : 0;
      return { state, result: undefined, ttlMs: 0, persist: false };
    },
    now,
  );
  return rem;
}

function assertShape(d: Decision): void {
  expect(Number.isInteger(d.remaining)).toBe(true);
  expect(d.remaining).toBeGreaterThanOrEqual(0);
  expect(Number.isInteger(d.retryAfterMs)).toBe(true);
  expect(d.retryAfterMs).toBeGreaterThanOrEqual(0);
  // retryAfterMs is 0 exactly when allowed — a denied composite must hand back a real wait.
  expect(d.retryAfterMs === 0).toBe(d.allowed);
}

type Cmd = fc.Command<object, Real>;

class CheckCommand implements Cmd {
  constructor(
    readonly ctx: Ctx,
    readonly cost: number,
  ) {}
  check(): boolean {
    return true;
  }
  run(_m: object, r: Real): void {
    const now = r.clock.now();
    // Snapshot every dimension's state + remaining BEFORE the check, all at this same `now`.
    const fks = r.dims.map((d) => keyOf(r.prefix, d.name, this.ctx.parts[d.idx] as string));
    const preState = fks.map((fk) => snapshotState(r, fk, now));
    const preRem = r.dims.map((d, i) =>
      remainingOf(r, fks[i] as string, r.strategies.get(d.name) as Strategy, now),
    );

    const decision = r.limiter.checkSync(this.ctx, this.cost);
    assertShape(decision);

    const postState = fks.map((fk) => snapshotState(r, fk, now));
    const postRem = r.dims.map((d, i) =>
      remainingOf(r, fks[i] as string, r.strategies.get(d.name) as Strategy, now),
    );

    if (!decision.allowed) {
      // core-01: a denied composite consumes from NO dimension. Byte-equal persisted state.
      for (let i = 0; i < fks.length; i++) {
        expect(postState[i], `deny advanced dim ${r.dims[i]?.name} (${fks[i]})`).toEqual(
          preState[i],
        );
      }
    } else {
      // An allow may consume; it must never hand a dimension free capacity at the same instant.
      for (let i = 0; i < fks.length; i++) {
        expect(
          postRem[i],
          `allow increased remaining on dim ${r.dims[i]?.name} (${fks[i]})`,
        ).toBeLessThanOrEqual(preRem[i] as number);
      }
    }
  }
  toString(): string {
    return `check(parts=[${this.ctx.parts.join(",")}], cost=${this.cost})`;
  }
}

class AdvanceCommand implements Cmd {
  constructor(readonly ms: number) {}
  check(): boolean {
    return true;
  }
  run(_m: object, r: Real): void {
    r.clock.advance(this.ms);
  }
  toString(): string {
    return `advanceClock(${this.ms})`;
  }
}

class ResetCommand implements Cmd {
  constructor(readonly ctx: Ctx) {}
  check(): boolean {
    return true;
  }
  run(_m: object, r: Real): void {
    // reset() is async (returns a Promise) but on a MemoryStore it resolves synchronously; the
    // resetSync side effects (key deletions) have all happened by the time check() returns control.
    void r.limiter.reset(this.ctx);
    // multi-02: every dimension key for this ctx must be gone from the store.
    for (const d of r.dims) {
      const fk = keyOf(r.prefix, d.name, this.ctx.parts[d.idx] as string);
      expect(r.store.has(fk), `reset left dim ${d.name} (${fk}) behind`).toBe(false);
    }
  }
  toString(): string {
    return `reset(parts=[${this.ctx.parts.join(",")}])`;
  }
}

const PART_ALPHABET = ["x", "y"]; // small ⇒ contexts collide and state builds up to denials

function commandArbs(nDims: number): fc.Arbitrary<Cmd>[] {
  const ctxArb = fc
    .array(fc.constantFrom(...PART_ALPHABET), { minLength: nDims, maxLength: nDims })
    .map((parts) => ({ parts }) as Ctx);
  const check = fc
    .tuple(ctxArb, fc.integer({ min: 1, max: 3 }))
    .map(([ctx, cost]) => new CheckCommand(ctx, cost));
  const advance = fc.integer({ min: 0, max: 2500 }).map((ms) => new AdvanceCommand(ms));
  const reset = ctxArb.map((ctx) => new ResetCommand(ctx));
  // ~62% check / 25% advance / 13% reset.
  return [check, check, check, check, check, advance, advance, reset];
}

function buildDims(specs: DimSpec[]): {
  dimensions: Dimensions<Ctx>;
  strategies: Map<string, Strategy>;
} {
  const dimensions: Dimensions<Ctx> = {};
  const strategies = new Map<string, Strategy>();
  for (const s of specs) {
    const strat = makeStrategy(s.strat);
    strategies.set(s.name, strat);
    dimensions[s.name] = {
      key: (ctx: Ctx) => ctx.parts[s.idx] as string,
      strategy: strat,
      cost: () => s.weight,
    };
  }
  return { dimensions, strategies };
}

describe("multiRateLimit — composite sequencing invariants (fc.commands)", () => {
  for (const mode of ["all", "any"] as const) {
    it(`${mode}: DENY-no-advance + ALLOW-no-gain + reset-clears-all + shape`, () => {
      fc.assert(
        fc.property(
          // 1–3 dimensions; each dimension's strategy + weight + ctx part it keys on, plus a command
          // sequence whose context arity matches the dimension count.
          fc
            .integer({ min: 1, max: 3 })
            .chain((n) =>
              fc.record({
                n: fc.constant(n),
                strats: fc.array(fc.constantFrom(...STRAT_NAMES), { minLength: n, maxLength: n }),
                weights: fc.array(fc.constantFrom(1, 2), { minLength: n, maxLength: n }),
                prefix: fc.option(fc.constantFrom("app", "myns"), { nil: undefined }),
                cmds: fc.commands(commandArbs(n), { maxCommands: 80 }),
              }),
            ),
          ({ strats, weights, prefix, cmds }) => {
            const specs: DimSpec[] = strats.map((strat, i) => ({
              name: `d${i}`,
              idx: i,
              strat,
              weight: weights[i] as number,
            }));
            const { dimensions, strategies } = buildDims(specs);
            const clock = new ManualClock(1_700_000_000_000);
            const store = new MemoryStore({ clock, sweepIntervalMs: 0 });
            const multi = mode === "all" ? all(dimensions) : any(dimensions);
            const limiter = multiRateLimit<Ctx>({
              strategy: multi,
              store,
              clock,
              ...(prefix !== undefined ? { prefix } : {}),
            });
            fc.modelRun(
              () => ({
                model: {},
                real: { clock, store, dims: specs, prefix, strategies, limiter },
              }),
              cmds,
            );
          },
        ),
        { numRuns: 250, seed: SEED },
      );
    });
  }
});
