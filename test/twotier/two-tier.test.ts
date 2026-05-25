import { describe, expect, it } from "vitest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { gcra } from "../../src/algorithms/gcra";
import { ManualClock } from "../../src/core/clock";
import type { Store, Transform } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";
import { twoTier } from "../../src/twotier";

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

describe("twoTier", () => {
  it("strict mode consults L2 on every check (exact)", async () => {
    const clock = new ManualClock(0);
    const { store, calls } = counting(new MemoryStore({ clock }));
    const limiter = twoTier({
      strategy: gcra({ limit: 2, periodMs: 1000 }),
      l2: store,
      mode: "strict",
      clock,
    });
    expect((await limiter.check("k")).allowed).toBe(true);
    expect((await limiter.check("k")).allowed).toBe(true);
    expect((await limiter.check("k")).allowed).toBe(false);
    expect(calls()).toBe(3); // one L2 round trip per request
  });

  it("cached-deny serves denials locally, sparing L2", async () => {
    const clock = new ManualClock(0);
    const { store, calls } = counting(new MemoryStore({ clock }));
    const limiter = twoTier({
      strategy: gcra({ limit: 1, periodMs: 10_000 }),
      l2: store,
      mode: "cached-deny",
      clock,
    });
    expect((await limiter.check("k")).allowed).toBe(true); // L2 call 1
    expect((await limiter.check("k")).allowed).toBe(false); // L2 call 2, caches the denial
    // Further hammering of the blocked key is served locally — no new L2 traffic.
    for (let i = 0; i < 50; i++) expect((await limiter.check("k")).allowed).toBe(false);
    expect(calls()).toBe(2);
  });

  it("leased serves a batch locally, amortizing L2 round trips", async () => {
    const clock = new ManualClock(0);
    const { store, calls } = counting(new MemoryStore({ clock }));
    const limiter = twoTier({
      strategy: fixedWindow({ limit: 100, windowMs: 10_000 }),
      l2: store,
      mode: "leased",
      lease: { batch: 10 },
      clock,
    });
    for (let i = 0; i < 10; i++) expect((await limiter.check("k")).allowed).toBe(true);
    expect(calls()).toBe(1); // 10 requests served from a single leased batch
    expect((await limiter.check("k")).allowed).toBe(true); // 11th triggers a second lease
    expect(calls()).toBe(2);
  });

  it("leased global overshoot stays within L×batch across a refill boundary", async () => {
    const clock = new ManualClock(0);
    const l2 = new MemoryStore({ clock, sweepIntervalMs: 0 });
    const L = 4;
    const B = 10;
    const K = 100;
    const W = 10_000;
    const nodes = Array.from({ length: L }, () =>
      twoTier({
        strategy: fixedWindow({ limit: K, windowMs: W }),
        l2,
        mode: "leased",
        lease: { batch: B }, // lowWater 0 ⇒ tightest bound
        clock,
      }),
    );

    // Window 0: every node leases a batch but serves only one, leaving leftover credits.
    for (const node of nodes) expect((await node.check("k")).allowed).toBe(true);

    // Cross into window 1: L2's fixed window resets, but local leftovers persist.
    clock.advance(W);

    let allowed = 0;
    for (let i = 0; i < 1000; i++) {
      const node = nodes[i % L];
      if (node !== undefined && (await node.check("k")).allowed) allowed++;
    }

    // The overshoot vs the configured limit is bounded by leftover credits, ≤ L×batch.
    expect(allowed).toBeLessThanOrEqual(K + L * B);
    expect(allowed).toBeGreaterThanOrEqual(K); // and at least the honest quota is served
  });

  it("checkSync is unsupported (L2 is async)", () => {
    const limiter = twoTier({
      strategy: gcra({ limit: 1, periodMs: 1000 }),
      l2: new MemoryStore(),
      mode: "cached-deny",
    });
    expect(() => limiter.checkSync("k")).toThrow(/checkSync is not supported/);
  });

  it("leased requires lease.batch", () => {
    expect(() =>
      twoTier({
        strategy: gcra({ limit: 1, periodMs: 1000 }),
        l2: new MemoryStore(),
        mode: "leased",
      }),
    ).toThrow(/lease\.batch/);
  });
});
