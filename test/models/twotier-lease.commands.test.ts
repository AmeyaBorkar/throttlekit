import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { ManualClock } from "../../src/core/clock";
import type { Limiter } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";
import { twoTier } from "../../src/twotier";

/**
 * Model-based (fc.asyncModelRun) test for `twoTier` leased mode with `windowCoupled: true` — the
 * cross-window credit-discard guarantee. Flavor: invariant-based stateful.
 *
 * Several nodes share ONE L2 `fixedWindow({ limit: L, windowMs })` counter under a single key. Each
 * node leases a batch and serves it locally. `windowCoupled` makes a node DISCARD any leftover leased
 * credits the moment the L2 window that granted them has rolled (`now >= lease.resetAt`), instead of
 * carrying them across the boundary — the sole source of leased cross-window overshoot.
 *
 * Documented bound (`src/twotier/index.ts` LeaseOptions.windowCoupled): the global per-window admit
 * count is then exactly `Limit`, independent of node count. So:
 *
 *  **INVARIANT — for every epoch-aligned window, the total ALLOWED cost across all nodes ≤ L.**
 *
 * A regression that smuggled a past window's credits across the boundary would let a later window's
 * admits exceed L and trip this tally.
 */

const SEED = 0x2c0f_1eaf;

interface Real {
  clock: ManualClock;
  nodes: Limiter[];
  windowMs: number;
  L: number;
  /** Allowed cost tallied per epoch-aligned window across ALL nodes (shared key). */
  admittedByWindow: Map<number, number>;
}

type Cmd = fc.AsyncCommand<object, Real>;

class CheckCommand implements Cmd {
  constructor(
    readonly node: number,
    readonly cost: number,
  ) {}
  check(): boolean {
    return true;
  }
  async run(_m: object, r: Real): Promise<void> {
    const now = r.clock.now();
    const limiter = r.nodes[this.node % r.nodes.length] as Limiter;
    const d = await limiter.check("k", this.cost);
    if (d.allowed) {
      const windowStart = Math.floor(now / r.windowMs) * r.windowMs;
      const n = (r.admittedByWindow.get(windowStart) ?? 0) + this.cost;
      r.admittedByWindow.set(windowStart, n);
      expect(
        n,
        `window ${windowStart}: admitted ${n} > L ${r.L} (cross-window credit smuggling)`,
      ).toBeLessThanOrEqual(r.L);
    }
  }
  toString(): string {
    return `check(node=${this.node}, cost=${this.cost})`;
  }
}

class AdvanceCommand implements Cmd {
  constructor(readonly ms: number) {}
  check(): boolean {
    return true;
  }
  async run(_m: object, r: Real): Promise<void> {
    r.clock.advance(this.ms);
  }
  toString(): string {
    return `advanceClock(${this.ms})`;
  }
}

function commandArbs(nNodes: number, maxCost: number, maxAdvance: number): fc.Arbitrary<Cmd>[] {
  const check = fc
    .tuple(fc.integer({ min: 0, max: nNodes - 1 }), fc.integer({ min: 1, max: maxCost }))
    .map(([node, cost]) => new CheckCommand(node, cost));
  const advance = fc.integer({ min: 0, max: maxAdvance }).map((ms) => new AdvanceCommand(ms));
  // ~67% check / 33% advance — advances must regularly cross window boundaries.
  return [check, check, advance];
}

describe("twoTier leased windowCoupled — cross-window credit discard (fc.asyncModelRun)", () => {
  it("total admitted cost per window ≤ L across all nodes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 6, max: 20 }), // L
        fc.integer({ min: 500, max: 1500 }), // windowMs
        fc.integer({ min: 2, max: 5 }), // batch (lease size)
        fc.integer({ min: 2, max: 3 }), // node count
        fc.commands(commandArbs(3, /*maxCost*/ 3, /*maxAdvance*/ 1800), { maxCommands: 90 }),
        async (L, windowMs, batch, nNodes, cmds) => {
          const clock = new ManualClock(1_700_000_000_000);
          // ONE shared L2 store + key; the fixedWindow counter caps the global per-window grant at L.
          const l2 = new MemoryStore({ clock, sweepIntervalMs: 0 });
          const nodes: Limiter[] = Array.from({ length: nNodes }, () =>
            twoTier({
              strategy: fixedWindow({ limit: L, windowMs }),
              l2,
              mode: "leased",
              lease: { batch, windowCoupled: true, lowWater: 0 },
              clock,
            }),
          );
          await fc.asyncModelRun(
            () => ({
              model: {},
              real: { clock, nodes, windowMs, L, admittedByWindow: new Map<number, number>() },
            }),
            cmds,
          );
          for (const n of nodes) await n.close?.();
        },
      ),
      { numRuns: 150, seed: SEED },
    );
  });
});
