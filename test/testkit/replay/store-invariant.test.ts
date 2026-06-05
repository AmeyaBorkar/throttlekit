import { afterEach, describe, expect, it, vi } from "vitest";
import { gcra } from "../../../src/algorithms/gcra";
import { ManualClock } from "../../../src/core/clock";
import { rateLimit } from "../../../src/core/limiter";
import type { Decision } from "../../../src/core/types";
import { MemoryStore } from "../../../src/stores/memory";

/**
 * #281 What-If Replay — P0 PR0.2: the replay store-construction invariant (design §4.5).
 *
 * Deterministic replay rebuilds a limiter over `new MemoryStore({ clock, sweepIntervalMs: 0 })` where
 * `clock` is the SAME {@link ManualClock} instance the limiter reads. Two construction facts make the
 * replay reproducible, and both are pinned here:
 *
 *  1. `sweepIntervalMs: 0` arms NO background `setInterval` sweep. The default (5000ms) sweep advances
 *     the timing wheel against `clock.now()` at real wall-clock moments — non-deterministic during a
 *     replay that jumps the manual clock far forward. With the sweep off, key expiry is purely
 *     access-driven (the inline `exp <= now` check), which is deterministic.
 *  2. The store reads the SAME injected clock as the limiter, so TTL/expiry keys off the same instant
 *     as the decisions — not a second, drifting time base.
 *
 * Pure MemoryStore + ManualClock: no Redis, runs in the normal suite.
 */

describe("replay store-construction invariant (§4.5)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sweepIntervalMs:0 arms no wall-clock sweep timer", async () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const store = new MemoryStore({ clock: new ManualClock(0), sweepIntervalMs: 0 });
    expect(spy).not.toHaveBeenCalled();
    await store.close();
  });

  it("the default constructor DOES arm exactly one sweep timer (contrast)", async () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const store = new MemoryStore({ clock: new ManualClock(0) }); // default sweepIntervalMs = 5000
    expect(spy).toHaveBeenCalledTimes(1);
    await store.close(); // clears the real timer the spy passed through
  });

  it("key expiry is driven purely by the shared ManualClock, never by real wall-clock time", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore({ clock, sweepIntervalMs: 0 });
    // burst 1 ⇒ one allowed check sets a TAT/expiry at now + period; prefix omitted ⇒ store key == "k".
    const limiter = rateLimit({
      strategy: gcra({ limit: 1, periodMs: 1000, burst: 1 }),
      clock,
      store,
    });

    const first = await limiter.check("k");
    expect(first.allowed).toBe(true);
    expect(store.has("k")).toBe(true);

    // Real time passes, but the manual clock does NOT move. A background sweep (if one were armed)
    // could only fire off real time — so the key surviving proves expiry is not wall-clock-driven.
    await new Promise((r) => setTimeout(r, 25));
    expect(store.has("k")).toBe(true);

    // Advance only the shared logical clock past the entry's expiry: now the store reports it gone,
    // proving the store's time base IS this ManualClock.
    clock.set(2_000);
    expect(store.has("k")).toBe(false);

    await store.close();
  });

  it("two fresh limiter+store pairs replay a fixed arrival script bit-identically", async () => {
    // (dtMs, key, cost) — chained steps with same-instant hammering on "a" so the burst (5) is
    // exhausted (forcing denials) and gcra's fractional TAT accumulates across the run.
    const SCRIPT: ReadonlyArray<readonly [number, string, number]> = [
      [0, "a", 2], // allowed
      [0, "a", 2], // allowed (cumulative 4)
      [0, "a", 2], // DENIED (cumulative 6 > burst 5)
      [0, "a", 1], // DENIED (still over the burst at the same instant)
      [200, "b", 1], // allowed (fresh key)
      [300, "a", 1], // partial refill on "a"
      [0, "c", 3], // allowed
      [500, "a", 2], // allowed after further refill
      [1, "b", 1], // allowed
      [1000, "a", 1], // allowed after a long idle gap
    ];

    const run = async (): Promise<Decision[]> => {
      const clock = new ManualClock(1_700_000_000_000);
      const store = new MemoryStore({ clock, sweepIntervalMs: 0 });
      const limiter = rateLimit({
        strategy: gcra({ limit: 3, periodMs: 1000, burst: 5 }),
        clock,
        store,
      });
      const out: Decision[] = [];
      for (const [dt, key, cost] of SCRIPT) {
        clock.advance(dt);
        out.push(await limiter.check(key, cost));
      }
      await store.close();
      return out;
    };

    const a = await run();
    const b = await run();
    expect(b).toEqual(a);
    // Sanity: the script genuinely exercised both outcomes (not a vacuous all-allow match).
    expect(a.some((d) => d.allowed)).toBe(true);
    expect(a.some((d) => !d.allowed)).toBe(true);
  });
});
