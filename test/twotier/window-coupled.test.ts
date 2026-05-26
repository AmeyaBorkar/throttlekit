import { describe, expect, it } from "vitest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { ManualClock } from "../../src/core/clock";
import type { Store, Transform } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";
import { twoTier } from "../../src/twotier";

/**
 * Window-coupled leasing (`lease.windowCoupled`): the shipped realisation of GALE Pillar 1. By
 * expiring a key's leased credits when the L2 window that granted them rolls over — instead of
 * carrying them across the boundary — it removes the sole source of cross-window overshoot, so the
 * per-window global bound drops from `Limit + L×(batch−1)` (legacy) to exactly `Limit`, independent
 * of the node count. Proven exhaustively in test/gale/leasing-variants.test.ts and
 * spec/GaleWindowCoupledLeasing.tla; here we verify the library implements it.
 */

/** Wrap a store to count how many times `apply` (an L2 round trip) is invoked. */
function counting(inner: Store): { store: Store; calls: () => number } {
  let n = 0;
  const store: Store = {
    apply<S, R>(key: string, transform: Transform<S, R>): Promise<R> {
      n++;
      return inner.apply(key, transform);
    },
    async reset(key: string): Promise<void> {
      await inner.reset(key);
    },
  };
  return { store, calls: () => n };
}

describe("twoTier leased — window-coupled credits", () => {
  it("re-leases after a window boundary instead of serving stale carried-over credits", async () => {
    async function callsAfterBoundary(windowCoupled: boolean | undefined): Promise<number> {
      const clock = new ManualClock(0);
      const { store, calls } = counting(new MemoryStore({ clock }));
      const node = twoTier({
        strategy: fixedWindow({ limit: 100, windowMs: 1000 }),
        l2: store,
        mode: "leased",
        lease: windowCoupled === undefined ? { batch: 4 } : { batch: 4, windowCoupled },
        clock,
      });
      await node.check("k"); // leases 4 (1 L2 call), serves 1, leaves 3 local credits
      const before = calls();
      clock.advance(1000); // cross the L2 window boundary
      await node.check("k");
      return calls() - before;
    }

    // Window-coupled: the carried-over credits expired, so the post-boundary request re-leases.
    expect(await callsAfterBoundary(true)).toBe(1);
    // Legacy (and the default): the stale credit is served locally — no L2 round trip.
    expect(await callsAfterBoundary(false)).toBe(0);
    expect(await callsAfterBoundary(undefined)).toBe(0); // default is legacy carry-over
  });

  it("eliminates cross-window overshoot — admitted == Limit regardless of node leftovers", async () => {
    const L = 4;
    const B = 10;
    const K = 100;
    const W = 10_000;

    async function postBoundaryAllowed(windowCoupled: boolean): Promise<number> {
      const clock = new ManualClock(0);
      const l2 = new MemoryStore({ clock, sweepIntervalMs: 0 });
      const nodes = Array.from({ length: L }, () =>
        twoTier({
          strategy: fixedWindow({ limit: K, windowMs: W }),
          l2,
          mode: "leased",
          lease: { batch: B, windowCoupled }, // lowWater 0 ⇒ tightest case
          clock,
        }),
      );
      // Window 0: every node leases a batch but serves only one, leaving B-1 leftover credits each.
      for (const node of nodes) expect((await node.check("k")).allowed).toBe(true);
      // Cross into window 1: L2's fixed window resets to a fresh Limit.
      clock.advance(W);
      let allowed = 0;
      for (let i = 0; i < 1000; i++) {
        const node = nodes[i % L];
        if (node !== undefined && (await node.check("k")).allowed) allowed++;
      }
      return allowed;
    }

    const legacy = await postBoundaryAllowed(false);
    const coupled = await postBoundaryAllowed(true);

    // Legacy carries L×(B-1) leftover credits over the boundary — served on top of the new window.
    expect(legacy).toBe(K + L * (B - 1)); // 100 + 4*9 = 136
    // Window-coupled discards them: the new window admits at most its budget. Zero overshoot.
    expect(coupled).toBe(K); // 100
    expect(coupled).toBeLessThan(legacy);
  });
});
