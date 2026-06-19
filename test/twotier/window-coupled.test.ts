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

/**
 * Wrap a store so each `apply` commits to the inner store synchronously (the grant's `resetAt` is
 * baked at fire time, reflecting the window the clock was in) but its reply is HELD until `release()`
 * is called — modelling an L2 grant leased in window N whose network reply lands in window N+1.
 */
function gated(inner: Store): { store: Store; release: () => Promise<void> } {
  const gates: Array<() => void> = [];
  const store: Store = {
    async apply<S, R>(key: string, transform: Transform<S, R>): Promise<R> {
      const result = await inner.apply(key, transform); // commit now
      await new Promise<void>((resolve) => gates.push(resolve)); // hold the reply
      return result;
    },
    async reset(key: string): Promise<void> {
      await inner.reset(key);
    },
  };
  const release = async (): Promise<void> => {
    const g = gates.shift();
    if (g) g();
    await Promise.resolve(); // let the released .then run
    await Promise.resolve();
  };
  return { store, release };
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

  it("a late proactive (lowWater) refill leased in the prior window is not smuggled across the boundary", async () => {
    // The proactive refill path had no window re-check (unlike the discard at check() entry): a refill
    // leased just before a boundary whose reply lands after the window rolled would credit a stale
    // batch AND clobber lastDecision, blinding the discard. With windowCoupled the new window must
    // serve only its OWN fresh batch — remaining === batch-1, not batch+staleBatch-1.
    const B = 4;
    const clock = new ManualClock(0);
    const { store, release } = gated(new MemoryStore({ clock, sweepIntervalMs: 0 }));
    const node = twoTier({
      strategy: fixedWindow({ limit: 1000, windowMs: 1000 }),
      l2: store,
      mode: "leased",
      lease: { batch: B, lowWater: 2, windowCoupled: true },
      clock,
    });

    // step1 @ t=0: on-demand lease(4) for window 0 fires and is held; release it → credits 4, serve 1.
    const p1 = node.check("k");
    await Promise.resolve();
    await release();
    expect((await p1).remaining).toBe(B - 1); // 3

    // step2 @ t=0: serves locally to credits=2 (== lowWater) → a proactive window-0 refill fires, HELD.
    expect((await node.check("k")).remaining).toBe(2);

    // Roll into window 1.
    clock.set(1000);

    // step3 @ t=1000: discard zeros the 2 stale credits; an on-demand lease(4) for window 1 fires, HELD.
    const p3 = node.check("k");
    await Promise.resolve();
    // Land the window-0 proactive refill FIRST (must be dropped), then the window-1 on-demand lease.
    await release(); // stale window-0 refill .then — forfeited under windowCoupled
    await release(); // fresh window-1 on-demand .then — credits += 4
    const d3 = await p3;

    expect(d3.resetAt).toBe(2000); // served against the fresh window
    expect(d3.remaining).toBe(B - 1); // exactly the fresh batch (3), NOT 4 stale + 4 fresh − 1 = 7
  });
});
