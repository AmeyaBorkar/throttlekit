import { ManualClock } from "throttlekit";
import type { GlobalCoordinator } from "throttlekit/federation";
import { describe, expect, it } from "vitest";

import { makeFederatedFleetSource } from "../src/fleet/source.js";

/**
 * FLA-1: the fleet source's window boundary vs. the production coordinators' store-clock window.
 *
 * Every other fleet test uses `TestCoordinator`, which keys its window on the `expiresAt` the source passes —
 * so source-clock == coordinator-window is tautological. The SHIPPED `RedisCoordinator`/`PostgresCoordinator`
 * instead IGNORE the passed `expiresAt` and window the budget on their OWN store clock. This suite drives
 * coordinators that mimic that behaviour with an INDEPENDENT, offsettable clock, to pin the fix:
 *   - WITH the additive `leaseWindowed` (the fix), the source surfaces the coordinator's AUTHORITATIVE
 *     window, so the client discards exactly when the budget resets — no divergence under any skew.
 *   - WITHOUT it (an older coordinator), the source falls back to the node-clock window — the bounded,
 *     self-recovering pre-fix behaviour — and the GLOBAL per-window safety bound still holds either way.
 */

/** Shared per-key fixed-window budget, windowed on the coordinator's OWN clock (ignoring any passed
 *  expiresAt) — exactly how the shipped Redis/Postgres coordinators behave (useServerTime defaults true). */
class StoreClock {
  readonly #budget: number;
  readonly #windowMs: number;
  readonly #clock: () => number;
  readonly #state = new Map<string, { windowStart: number; remaining: number }>();

  constructor(opts: { budgetPerWindow: number; windowMs: number; clock: () => number }) {
    this.#budget = opts.budgetPerWindow;
    this.#windowMs = opts.windowMs;
    this.#clock = opts.clock;
  }

  /** Drain min(tokens, remaining) from the current store-clock window; return {granted, expiresAt}. */
  drain(key: string, tokens: number): { granted: number; expiresAt: number } {
    const now = this.#clock();
    const windowStart = Math.floor(now / this.#windowMs) * this.#windowMs;
    const expiresAt = windowStart + this.#windowMs;
    let s = this.#state.get(key);
    if (s === undefined || s.windowStart !== windowStart) {
      s = { windowStart, remaining: this.#budget };
      this.#state.set(key, s);
    }
    const granted = Math.max(0, Math.min(Math.floor(tokens), s.remaining));
    s.remaining -= granted;
    return { granted, expiresAt };
  }
}

/** Pre-fix coordinator: only `lease()` (windows on its own clock, ignores the passed expiresAt). */
class LegacyStoreClockCoordinator implements GlobalCoordinator {
  constructor(private readonly store: StoreClock) {}
  lease(key: string, tokens: number, _expiresAt: number): Promise<number> {
    return Promise.resolve(this.store.drain(key, tokens).granted);
  }
  reconcile(): Promise<void> {
    return Promise.resolve();
  }
}

/** Fixed (FLA-1) coordinator: adds `leaseWindowed()` returning the authoritative store-clock window. */
class WindowedStoreClockCoordinator implements GlobalCoordinator {
  constructor(private readonly store: StoreClock) {}
  lease(key: string, tokens: number, _expiresAt: number): Promise<number> {
    return Promise.resolve(this.store.drain(key, tokens).granted);
  }
  leaseWindowed(key: string, tokens: number): Promise<{ granted: number; expiresAt: number }> {
    return Promise.resolve(this.store.drain(key, tokens));
  }
  reconcile(): Promise<void> {
    return Promise.resolve();
  }
}

describe("Fleet source under node↔store clock skew (FLA-1)", () => {
  it("with leaseWindowed, the client discards at the AUTHORITATIVE store window even under source-clock skew", async () => {
    const windowMs = 1000;
    const storeNow = 100_900; // store clock: late in window [100000, 101000) — budget drains from THIS window
    const store = new StoreClock({ budgetPerWindow: 5, windowMs, clock: () => storeNow });
    const coord = new WindowedStoreClockCoordinator(store);
    // Node clock skewed +200ms ACROSS the boundary: it believes it is already in window [101000, 102000).
    const source = makeFederatedFleetSource(coord, {
      windowMs,
      limit: 5,
      clock: new ManualClock(101_100),
    });
    const g = await source.lease("api", 3);
    expect(g.capacity).toBe(3);
    // FIXED: the discard boundary is the STORE window the budget drained against (101000) — NOT the
    // node-clock window (102000) — so the client discards exactly when the coordinator resets. No divergence.
    expect(g.expiresAt).toBe(101_000);
  });

  it("the global per-window bound holds under the fix for any source-clock offset, and the boundary stays authoritative", async () => {
    const windowMs = 1000;
    const budget = 5;
    for (const offsetMs of [0, 250, 500, -300, 999]) {
      const storeNow = 100_000; // store window [100000, 101000)
      const store = new StoreClock({ budgetPerWindow: budget, windowMs, clock: () => storeNow });
      const coord = new WindowedStoreClockCoordinator(store);
      const source = makeFederatedFleetSource(coord, {
        windowMs,
        limit: budget,
        clock: new ManualClock(storeNow + offsetMs),
      });
      let granted = 0;
      for (let i = 0; i < 20; i++) granted += (await source.lease("api", 1)).capacity;
      expect(granted).toBe(budget); // coordinator caps the window at its budget regardless of source offset
      // Every grant's discard boundary is the authoritative store window, independent of the node offset.
      expect((await source.lease("api", 1)).expiresAt).toBe(101_000);
    }
  });

  it("without leaseWindowed, the source falls back to the node-clock boundary (bounded FLA-1 limitation; bound still holds)", async () => {
    const windowMs = 1000;
    const storeNow = 100_900;
    const store = new StoreClock({ budgetPerWindow: 5, windowMs, clock: () => storeNow });
    const coord = new LegacyStoreClockCoordinator(store); // no leaseWindowed ⇒ source falls back
    const source = makeFederatedFleetSource(coord, {
      windowMs,
      limit: 5,
      clock: new ManualClock(101_100),
    });
    const g = await source.lease("api", 3);
    expect(g.capacity).toBe(3);
    // The client is told to discard at the NODE-clock boundary (102000) while the budget drained from the
    // store window [100000, 101000) — the divergence the fix closes. The GLOBAL bound still holds:
    expect(g.expiresAt).toBe(102_000);
    expect((await source.lease("api", 5)).capacity).toBe(2); // 5 − 3 = 2 left in the SAME store window
  });
});
