import { describe, expect, it } from "vitest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { ManualClock } from "../../src/core/clock";
import type { Store, Transform } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";
import { twoTier } from "../../src/twotier";
import { type LeaseSizer, leaseSizer } from "../../src/twotier/sizing";

/**
 * Integration tests for adaptive (GALE Pillar 2) lease sizing wired INTO `twoTier` leased mode.
 *
 * The learner (leaseSizer) is proven in isolation — its O(√T) convergence to the EOQ optimum needs
 * thousands of windows and is covered in lease-sizer.test.ts. Here we pin only the WIRING, with
 * deterministic stubs and short directional runs: that the limiter (a) feeds each key's learner
 * exactly the demand that key served per window, (b) leases at the learner's size, (c) reflects a
 * resize, (d) keeps one independent learner per key, and — the load-bearing claim — (e) holds the
 * per-window global admissions ≤ Limit for EVERY size the learner emits (Pillar 1 decouples safety
 * from the size).
 */

/** Wrap a store to count `apply` (an L2 round trip / lease) invocations. */
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

/** A leaseSizer wrapper that records the demand it's told and the sizes it emits. */
function recordingSizer(inner: LeaseSizer): LeaseSizer & { observed: number[] } {
  const observed: number[] = [];
  return {
    size: () => inner.size(),
    observe(demand: number): void {
      observed.push(demand);
      inner.observe(demand);
    },
    get continuous(): number {
      return inner.continuous;
    },
    observed,
  };
}

/** A stub sizer that always returns `size` and ignores demand — to pin "the lease uses size()". */
function fixedSizer(size: number): LeaseSizer {
  return { size: () => size, observe: () => {}, continuous: size };
}

/** A stub that returns `before`, then `after` once it has been told any demand — to pin resizing. */
function growOnObserve(before: number, after: number): LeaseSizer {
  let grown = false;
  return {
    size: () => (grown ? after : before),
    observe: () => {
      grown = true;
    },
    get continuous(): number {
      return grown ? after : before;
    },
  };
}

describe("twoTier adaptive lease sizing — validation", () => {
  it("accepts `adaptive` with no fixed batch", () => {
    expect(() =>
      twoTier({
        strategy: fixedWindow({ limit: 1000, windowMs: 1000 }),
        l2: new MemoryStore(),
        mode: "leased",
        lease: { adaptive: { orderCost: 20, strandPenalty: 1 } },
      }),
    ).not.toThrow();
  });

  it("throws when leased mode has neither batch nor adaptive", () => {
    expect(() =>
      twoTier({
        strategy: fixedWindow({ limit: 1000, windowMs: 1000 }),
        l2: new MemoryStore(),
        mode: "leased",
        lease: {},
      }),
    ).toThrow(/lease\.batch.*adaptive/);
  });

  it("fails fast on invalid EOQ params (validated at construction, not first use)", () => {
    expect(() =>
      twoTier({
        strategy: fixedWindow({ limit: 1000, windowMs: 1000 }),
        l2: new MemoryStore(),
        mode: "leased",
        lease: { adaptive: { orderCost: -1, strandPenalty: 1 } },
      }),
    ).toThrow();
  });
});

describe("twoTier adaptive lease sizing — wiring", () => {
  it("feeds the learner exactly the demand each key served per window", async () => {
    const clock = new ManualClock(0);
    const W = 10_000;
    const l2 = new MemoryStore({ clock, sweepIntervalMs: 0 });
    const sizers: ReturnType<typeof recordingSizer>[] = [];
    const node = twoTier({
      strategy: fixedWindow({ limit: 1_000_000, windowMs: W }),
      l2,
      mode: "leased",
      lease: {
        windowCoupled: true,
        adaptive: () => {
          const s = recordingSizer(
            leaseSizer({ orderCost: 20, strandPenalty: 1, initialSize: 8, maxSize: 500 }),
          );
          sizers.push(s);
          return s;
        },
      },
      clock,
    });

    const demandPerWindow = [20, 5, 40, 13];
    for (let w = 0; w < demandPerWindow.length; w++) {
      clock.advance(w === 0 ? 0 : W);
      const d = demandPerWindow[w] ?? 0;
      for (let i = 0; i < d; i++) expect((await node.check("k")).allowed).toBe(true);
    }
    // One request in a fresh window flushes the observation of the final window's demand.
    clock.advance(W);
    await node.check("k");

    expect(sizers).toHaveLength(1); // one independent learner for the one key
    expect(sizers[0]?.observed).toEqual(demandPerWindow); // each window's served demand, in order
  });

  it("leases at the learner's size (a fixed stub of 7 ⇒ ⌈20/7⌉ = 3 leases)", async () => {
    const clock = new ManualClock(0);
    const { store, calls } = counting(new MemoryStore({ clock, sweepIntervalMs: 0 }));
    const node = twoTier({
      strategy: fixedWindow({ limit: 1_000_000, windowMs: 10_000 }),
      l2: store,
      mode: "leased",
      lease: { windowCoupled: true, adaptive: () => fixedSizer(7) },
      clock,
    });
    for (let i = 0; i < 20; i++) expect((await node.check("k")).allowed).toBe(true);
    expect(calls()).toBe(3); // 7 + 7 + 7 = 21 credits leased to serve 20
  });

  it("reflects a resize at the next window (4 → 40 after the learner observes)", async () => {
    const clock = new ManualClock(0);
    const W = 10_000;
    const { store, calls } = counting(new MemoryStore({ clock, sweepIntervalMs: 0 }));
    const node = twoTier({
      strategy: fixedWindow({ limit: 1_000_000, windowMs: W }),
      l2: store,
      mode: "leased",
      lease: { windowCoupled: true, adaptive: () => growOnObserve(4, 40) },
      clock,
    });

    clock.advance(0);
    const before = calls();
    for (let i = 0; i < 40; i++) await node.check("k");
    const w0 = calls() - before; // size 4 ⇒ 10 leases

    clock.advance(W);
    const mid = calls();
    for (let i = 0; i < 40; i++) await node.check("k");
    const w1 = calls() - mid; // observed at the roll ⇒ size 40 ⇒ 1 lease

    expect(w0).toBe(10);
    expect(w1).toBe(1);
  });

  it("reduces coordination over time on steady demand (the win)", async () => {
    const clock = new ManualClock(0);
    const W = 10_000;
    const { store, calls } = counting(new MemoryStore({ clock, sweepIntervalMs: 0 }));
    const node = twoTier({
      strategy: fixedWindow({ limit: 1_000_000, windowMs: W }),
      l2: store,
      mode: "leased",
      // High order cost ⇒ the learner wants a much larger batch than the tiny warm-start.
      lease: {
        windowCoupled: true,
        adaptive: { orderCost: 200, strandPenalty: 1, initialSize: 4, maxSize: 1000 },
      },
      clock,
    });

    const leasesFor = async (requests: number): Promise<number> => {
      const before = calls();
      for (let i = 0; i < requests; i++) await node.check("k");
      return calls() - before;
    };

    clock.advance(0);
    const firstWindowLeases = await leasesFor(60); // batch 4 ⇒ 15 leases
    for (let w = 1; w < 12; w++) {
      clock.advance(W);
      await leasesFor(60); // let the learner grow the batch on steady demand
    }
    clock.advance(W);
    const laterWindowLeases = await leasesFor(60);

    expect(firstWindowLeases).toBe(15);
    expect(laterWindowLeases).toBeLessThan(firstWindowLeases / 2); // far fewer L2 round trips
  });

  it("keeps one independent learner per key (each sees only its key's demand)", async () => {
    const clock = new ManualClock(0);
    const W = 10_000;
    const l2 = new MemoryStore({ clock, sweepIntervalMs: 0 });
    const sizers: ReturnType<typeof recordingSizer>[] = [];
    const node = twoTier({
      strategy: fixedWindow({ limit: 1_000_000, windowMs: W }),
      l2,
      mode: "leased",
      lease: {
        windowCoupled: true,
        adaptive: () => {
          const s = recordingSizer(
            leaseSizer({ orderCost: 20, strandPenalty: 1, initialSize: 4, maxSize: 500 }),
          );
          sizers.push(s);
          return s;
        },
      },
      clock,
    });

    for (let w = 0; w < 5; w++) {
      clock.advance(w === 0 ? 0 : W);
      for (let i = 0; i < 8; i++) await node.check("quiet"); // demand 8
      for (let i = 0; i < 150; i++) await node.check("busy"); // demand 150
    }
    clock.advance(W);
    await node.check("quiet");
    await node.check("busy");

    expect(sizers).toHaveLength(2);
    const byScale = [...sizers].sort((a, b) => Math.max(...a.observed) - Math.max(...b.observed));
    // Disjoint demand streams ⇒ the two learners never cross-contaminate.
    expect(Math.max(...(byScale[0]?.observed ?? [1]))).toBeLessThan(20);
    expect(Math.min(...(byScale[1]?.observed ?? [0]))).toBeGreaterThan(100);
  });
});

describe("twoTier adaptive lease sizing — safety (the invariant)", () => {
  it("holds per-window global admissions ≤ Limit for every size the learner emits", async () => {
    const clock = new ManualClock(0);
    const W = 10_000;
    const L = 100;
    const N = 4;
    const l2 = new MemoryStore({ clock, sweepIntervalMs: 0 });
    const nodes = Array.from({ length: N }, () =>
      twoTier({
        strategy: fixedWindow({ limit: L, windowMs: W }),
        l2,
        mode: "leased",
        // windowCoupled ⇒ the proven exact-Limit bound, independent of the (adaptive) batch.
        lease: {
          windowCoupled: true,
          adaptive: { orderCost: 30, strandPenalty: 1, initialSize: 1, maxSize: 50 },
        },
        clock,
      }),
    );

    // A deterministic, skewed, drifting per-node demand schedule that routinely over-subscribes L.
    const demand = (node: number, w: number): number => 5 + ((node * 7 + w * 13) % 60);

    for (let w = 0; w < 25; w++) {
      clock.advance(w === 0 ? 0 : W);
      let admittedThisWindow = 0;
      const want = nodes.map((_, i) => demand(i, w));
      const maxWant = Math.max(...want);
      for (let r = 0; r < maxWant; r++) {
        for (let i = 0; i < N; i++) {
          if (r < (want[i] ?? 0)) {
            const node = nodes[i];
            if (node !== undefined && (await node.check("shared")).allowed) admittedThisWindow++;
          }
        }
      }
      expect(admittedThisWindow).toBeLessThanOrEqual(L); // never over the global Limit
    }
  });

  it("leaves fixed-batch leased mode untouched (no adaptive ⇒ legacy behaviour)", async () => {
    const clock = new ManualClock(0);
    const { store, calls } = counting(new MemoryStore({ clock, sweepIntervalMs: 0 }));
    const node = twoTier({
      strategy: fixedWindow({ limit: 1000, windowMs: 10_000 }),
      l2: store,
      mode: "leased",
      lease: { batch: 10 },
      clock,
    });
    for (let i = 0; i < 10; i++) expect((await node.check("k")).allowed).toBe(true);
    expect(calls()).toBe(1); // exactly one batch of 10, as before
    await node.check("k");
    expect(calls()).toBe(2);
  });
});
