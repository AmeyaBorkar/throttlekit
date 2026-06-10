import { ManualClock } from "throttlekit";
import type { GlobalCoordinator } from "throttlekit/federation";
import { describe, expect, it } from "vitest";

import { makeFederatedFleetSource } from "../src/fleet/source.js";

/**
 * FLA-1 conformance: the fleet source's node-clock window vs. the production coordinators' store-clock window.
 *
 * Every other fleet test uses `TestCoordinator`, which keys its window state on the `expiresAt` the source
 * passes — so source-clock == coordinator-window is tautological and the real cross-clock hazard is invisible.
 * The SHIPPED `RedisCoordinator`/`PostgresCoordinator` instead IGNORE the passed `expiresAt` (the param is
 * literally `_expiresAt`) and window the budget on their OWN store clock. This suite drives a coordinator that
 * mimics that shipped behaviour with an INDEPENDENT, offsettable clock, to pin two things:
 *   1. the GLOBAL per-window safety bound holds under arbitrary node↔store skew (the load-bearing property), and
 *   2. the boundary the client is told to discard at (node clock) can diverge from the window the budget
 *      drained against (store clock) — the documented `source.ts` (FLA-1) limitation, until the coordinator
 *      returns its authoritative boundary (a follow-up needing the next core release).
 */

/** A coordinator that windows the budget on its OWN clock and IGNORES the passed expiresAt — like the shipped
 *  Redis/Postgres coordinators (useServerTime defaults true). Per-key fixed-window budget. */
class StoreClockCoordinator implements GlobalCoordinator {
  readonly #budget: number;
  readonly #windowMs: number;
  readonly #clock: () => number;
  readonly #state = new Map<string, { windowStart: number; remaining: number }>();

  constructor(opts: { budgetPerWindow: number; windowMs: number; clock: () => number }) {
    this.#budget = opts.budgetPerWindow;
    this.#windowMs = opts.windowMs;
    this.#clock = opts.clock;
  }

  lease(key: string, tokens: number, _expiresAt: number): Promise<number> {
    const now = this.#clock(); // STORE clock — the passed _expiresAt is deliberately ignored (shipped behaviour)
    const windowStart = Math.floor(now / this.#windowMs) * this.#windowMs;
    let s = this.#state.get(key);
    if (s === undefined || s.windowStart !== windowStart) {
      s = { windowStart, remaining: this.#budget };
      this.#state.set(key, s);
    }
    const grant = Math.max(0, Math.min(Math.floor(tokens), s.remaining));
    s.remaining -= grant;
    return Promise.resolve(grant);
  }

  reconcile(): Promise<void> {
    return Promise.resolve();
  }
}

describe("Fleet source under node↔store clock skew (FLA-1)", () => {
  it("never grants more than the budget within a coordinator window, for any source-clock offset", async () => {
    const windowMs = 1000;
    const budget = 5;
    for (const offsetMs of [0, 250, 500, -300, 999]) {
      const storeNow = 100_000; // a fixed store window [100000, 101000)
      const coord = new StoreClockCoordinator({
        budgetPerWindow: budget,
        windowMs,
        clock: () => storeNow,
      });
      // The source's NODE clock is offset from the store clock — the exact skew case the suite couldn't reach.
      const source = makeFederatedFleetSource(coord, {
        windowMs,
        limit: budget,
        clock: new ManualClock(storeNow + offsetMs),
      });
      let granted = 0;
      for (let i = 0; i < 20; i++) granted += (await source.lease("api", 1)).capacity;
      // The coordinator's per-window cap holds regardless of what window the source thinks it is in.
      expect(granted).toBe(budget);
    }
  });

  it("documents the divergence: the client discard boundary (node clock) can differ from the drained window (store clock)", async () => {
    const windowMs = 1000;
    const storeNow = 100_900; // store clock: late in window [100000, 101000) — coordinator drains THIS window
    const coord = new StoreClockCoordinator({
      budgetPerWindow: 5,
      windowMs,
      clock: () => storeNow,
    });
    // Node clock skewed +200ms ACROSS the boundary: it already believes it is in window [101000, 102000).
    const source = makeFederatedFleetSource(coord, {
      windowMs,
      limit: 5,
      clock: new ManualClock(101_100),
    });
    const g = await source.lease("api", 3);
    expect(g.capacity).toBe(3);
    // The client is TOLD to discard at the node-clock boundary (102000), while the budget was drained from the
    // store's window [100000, 101000) (which resets at 101000) — the FLA-1 divergence, made explicit here.
    expect(g.expiresAt).toBe(102_000);
    // The GLOBAL bound still holds: a second lease at the same store instant draws from the SAME store window.
    expect((await source.lease("api", 5)).capacity).toBe(2); // 5 − 3 = 2 left in the coordinator's window
  });
});
