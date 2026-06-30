import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/core/clock";
import { weightedFairEscrow } from "../../src/twotier/weighted-fair-escrow";
import type { WeightedFairEscrowLimiter } from "../../src/twotier/weighted-fair-escrow";
import { waterfillInt } from "../gale/fair-escrow";

/**
 * Model-based (fc.commands) tests for `weightedFairEscrow` (GALE Pillar 4) over the L1-only
 * synchronous path. Flavor: invariant-based stateful — a byte-identical streaming reference is too
 * hard (the allocation depends on check arrival order), so the model tracks only what the documented
 * guarantees need and asserts STRONG, DOCUMENTED invariants at every step over random
 * check / advanceClock / reset / setWeight / remove sequences.
 *
 * Invariants asserted after EVERY command:
 *
 *  - **T1 safety — Σ used ≤ L always** (`pool ≥ 0`, `totalUsed ≤ L`), the load-bearing property.
 *  - **conservation** — within a window (no roll), a check moves `totalUsed` by exactly `cost` on
 *    allow and `0` on deny (the WFE analog of DENY-no-advance: a denied check consumes nothing).
 *  - **no cross-window credit smuggling (twotier-gale-01)** — when a check rolls the window, the new
 *    `totalUsed` equals ONLY this check's consumption (`allowed ? cost : 0`); no stale budget carries
 *    across the boundary.
 *  - **waterfill-oracle safety bound** — `Σ used ≤ Σ waterfillInt(perWindowDemand, weights, L)`,
 *    tying the streaming sum to the proven batch weighted-max-min allocation total
 *    (`= min(Σ demand, L)`), cross-checked against the oracle proven at 20 000 trials in
 *    `test/gale/fair-escrow.test.ts`.
 *  - **structural** — `effectiveLimit === L` (L1 mode), integer non-negative per-tenant `used`,
 *    `totalUsed === Σ tenant.used`, epoch-aligned `windowStart`.
 */

const SEED = 0xfa12_4e50;
const TENANTS = ["A", "B", "C", "D"] as const;
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

interface Real {
  clock: ManualClock;
  escrow: WeightedFairEscrowLimiter;
  weightMap: Map<string, number>;
  /** Cumulative cost requested per tenant in the CURRENT window (cleared on roll / reset). */
  demand: Map<string, number>;
  L: number;
  windowMs: number;
}

/** All per-step structural + safety + oracle invariants (run after every command). */
function assertInvariants(r: Real): void {
  const s = r.escrow.stats();
  expect(s.effectiveLimit).toBe(r.L); // L1 mode: L_effective is constant L
  expect(s.pool).toBeGreaterThanOrEqual(0); // ⟺ Σ used ≤ effectiveLimit
  expect(s.totalUsed).toBeLessThanOrEqual(r.L); // T1 safety
  expect(s.totalUsed).toBe(sum(s.tenants.map((t) => t.used))); // aggregate matches the rescan
  for (const t of s.tenants) {
    expect(Number.isInteger(t.used)).toBe(true);
    expect(t.used).toBeGreaterThanOrEqual(0);
    expect(t.used).toBeLessThanOrEqual(r.L);
  }
  if (Number.isFinite(s.windowStart)) {
    expect(s.windowStart % r.windowMs).toBe(0); // epoch-aligned window
  }

  // Waterfill-oracle safety bound over the active set: Σ used ≤ Σ waterfillInt(demand, weight, L).
  // weights are the WFE's own per-entry stored weights (authoritative); demand is per-window cumulative.
  if (s.tenants.length > 0) {
    const demands = s.tenants.map((t) => r.demand.get(t.tenant) ?? t.used);
    const weights = s.tenants.map((t) => t.weight);
    const oracleTotal = sum(waterfillInt(demands, weights, r.L));
    expect(sum(s.tenants.map((t) => t.used))).toBeLessThanOrEqual(oracleTotal);
  }
}

type Cmd = fc.Command<object, Real>;

class CheckCommand implements Cmd {
  constructor(
    readonly tenant: string,
    readonly cost: number,
  ) {}
  check(): boolean {
    return true;
  }
  run(_m: object, r: Real): void {
    const preWindowStart = r.escrow.stats().windowStart;
    const preTotal = r.escrow.stats().totalUsed;

    const decision = r.escrow.checkSync(this.tenant, this.cost);

    const post = r.escrow.stats();
    const rolled = post.windowStart !== preWindowStart;
    if (rolled) r.demand.clear(); // window boundary: discard stale per-window demand
    r.demand.set(this.tenant, (r.demand.get(this.tenant) ?? 0) + this.cost);

    const consumed = decision.allowed ? this.cost : 0;
    if (rolled) {
      // no cross-window smuggling: a rolled window counts ONLY this check's consumption.
      expect(post.totalUsed, "cross-window smuggling: stale used carried across roll").toBe(
        consumed,
      );
    } else {
      // conservation: deny consumes nothing; allow consumes exactly cost.
      expect(post.totalUsed, "conservation: totalUsed moved by != consumed").toBe(
        preTotal + consumed,
      );
    }
    // A denied check must report a real wait and no consumption is implied by `allowed`.
    expect(decision.retryAfterMs === 0).toBe(decision.allowed);

    assertInvariants(r);
  }
  toString(): string {
    return `check(${this.tenant}, cost=${this.cost})`;
  }
}

class AdvanceCommand implements Cmd {
  constructor(readonly ms: number) {}
  check(): boolean {
    return true;
  }
  run(_m: object, r: Real): void {
    r.clock.advance(this.ms);
    assertInvariants(r); // advancing alone never violates safety (roll is lazy, on next check)
  }
  toString(): string {
    return `advanceClock(${this.ms})`;
  }
}

class SetWeightCommand implements Cmd {
  constructor(
    readonly tenant: string,
    readonly weight: number,
  ) {}
  check(): boolean {
    return true;
  }
  run(_m: object, r: Real): void {
    // The WFE reads weightOf at each tenant's next check and recomputes that tenant's guaranteed
    // share — exercising "an idle tenant re-appearing must recompute its share" + contention rebalance.
    r.weightMap.set(this.tenant, this.weight);
    assertInvariants(r);
  }
  toString(): string {
    return `setWeight(${this.tenant}, ${this.weight})`;
  }
}

class RemoveCommand implements Cmd {
  constructor(readonly tenant: string) {}
  check(): boolean {
    return true;
  }
  run(_m: object, r: Real): void {
    r.escrow.reset(this.tenant); // tenant leaves the active set; its used returns to the pool
    r.demand.delete(this.tenant);
    assertInvariants(r);
  }
  toString(): string {
    return `remove(${this.tenant})`;
  }
}

class ResetAllCommand implements Cmd {
  check(): boolean {
    return true;
  }
  run(_m: object, r: Real): void {
    r.escrow.reset();
    r.demand.clear();
    const s = r.escrow.stats();
    expect(s.totalUsed).toBe(0);
    expect(s.tenants.length).toBe(0);
    assertInvariants(r);
  }
  toString(): string {
    return "reset()";
  }
}

function commandArbs(): fc.Arbitrary<Cmd>[] {
  const tenant = fc.constantFrom(...TENANTS);
  const check = fc
    .tuple(tenant, fc.integer({ min: 1, max: 4 }))
    .map(([t, c]) => new CheckCommand(t, c));
  const advance = fc.integer({ min: 0, max: 2500 }).map((ms) => new AdvanceCommand(ms));
  const setWeight = fc
    .tuple(tenant, fc.integer({ min: 1, max: 6 }))
    .map(([t, w]) => new SetWeightCommand(t, w));
  const remove = tenant.map((t) => new RemoveCommand(t));
  const resetAll = fc.constant(new ResetAllCommand());
  // ~60% check, the rest time advances + lifecycle ops (weight changes, removals, full reset).
  return [check, check, check, check, check, check, advance, advance, setWeight, remove, resetAll];
}

describe("weightedFairEscrow — streaming invariants (fc.commands, L1 mode)", () => {
  it("Σ≤L + conservation + no cross-window smuggling + waterfill-oracle bound", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 60 }), // L
        fc.integer({ min: 500, max: 2000 }), // windowMs
        // Initial weights for the 4 tenants (mutated later by setWeight commands).
        fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 4, maxLength: 4 }),
        fc.commands(commandArbs(), { maxCommands: 100 }),
        (L, windowMs, initWeights, cmds) => {
          const weightMap = new Map<string, number>(
            TENANTS.map((t, i) => [t, initWeights[i] as number]),
          );
          const clock = new ManualClock(1_700_000_000_000);
          const escrow = weightedFairEscrow({
            limit: L,
            windowMs,
            weightOf: (t) => weightMap.get(t) ?? 1,
            clock,
          });
          fc.modelRun(
            () => ({
              model: {},
              real: { clock, escrow, weightMap, demand: new Map(), L, windowMs },
            }),
            cmds,
          );
        },
      ),
      { numRuns: 300, seed: SEED },
    );
  });
});
