/**
 * TK-1332 — self-fencing (D-DAC-21): the REAL-guard tests for the partition-overshoot fix
 * whose timing model is gated in `distributed-self-fence-model.test.ts`. A partitioned/silent
 * node stops admitting on its OWN clock (`lastSuccessExpiresAt − fenceSafetyMargin`) strictly
 * before the coordinator reclaims its budget, so peers never ramp into budget it still holds.
 *
 * Determinism: a ManualClock + a non-firing scheduler, so beats happen only when the test calls
 * `heartbeat()` and "the node stops getting beats through" (a partition) is modeled by simply
 * not beating while time advances (the node's last-good share stays frozen — exactly the case
 * 0.10.x's throw-driven fail-closed did NOT cover, since a partition hangs rather than throws).
 */
import { describe, expect, it } from "vitest";

import type { Lease } from "../../src/concurrency/adaptive";
import { ManualClock } from "../../src/core/clock";
import {
  type DistributedAdaptiveConcurrencyOptions,
  type HeartbeatScheduler,
  TestConcurrencyCoordinator,
  distributedAdaptiveConcurrency,
} from "../../src/index";

const KEY = "backend";
const L = 4;
const HB = 1000;
const TTL = 2000; // 2·HB; default margin = (TTL−HB)/2 = 500 ⇒ fenceDeadline = expiresAt − 500

/** A scheduler that NEVER fires on its own — beats happen only via explicit heartbeat() calls. */
const nonFiring: HeartbeatScheduler = {
  schedule: () => ({ cancel: () => {} }),
  setTimer: () => ({ cancel: () => {} }),
};

function mk(
  clock: ManualClock,
  coord: TestConcurrencyCoordinator,
  nodeId: string,
  extra: Partial<DistributedAdaptiveConcurrencyOptions> = {},
) {
  return distributedAdaptiveConcurrency({
    coordinator: coord,
    nodeId,
    key: KEY,
    local: { minLimit: L, maxLimit: L, initialLimit: L, clock },
    heartbeatMs: HB,
    leaseTtlMs: TTL,
    onCoordinatorOutage: "fail-closed",
    clock,
    scheduler: nonFiring,
    ...extra,
  });
}

describe("self-fencing — real guard (TK-1332, D-DAC-21)", () => {
  it("a silent node self-fences at expiresAt − margin, BEFORE the coordinator would reclaim", async () => {
    const clock = new ManualClock(0);
    const coord = new TestConcurrencyCoordinator({ clock, aggregate: "min" });
    let fencedCalls = 0;
    const guard = mk(clock, coord, "A", { onFenced: () => fencedCalls++ });

    await guard.heartbeat(); // success ⇒ share 4, leaseExpiresAt = 2000, fenceDeadline = 1500
    expect(guard.stats().share).toBe(4);
    expect(guard.acquire().ok).toBe(true);

    // Just before the fence deadline: still admitting (the node hasn't given up yet).
    clock.set(1499);
    expect(guard.stats().fenced).toBe(false);
    expect(guard.acquire().ok).toBe(true);

    // At the deadline (no successful beat since t=0): self-fence — admit nothing, fire onFenced
    // ONCE — and this is strictly before the coordinator's reclaim point (expiresAt = 2000).
    clock.set(1500);
    expect(guard.acquire().ok).toBe(false);
    expect(guard.stats().fenced).toBe(true);
    expect(guard.acquire().ok).toBe(false); // still fenced
    expect(fencedCalls, "onFenced fires exactly once per episode").toBe(1);
    // The coordinator still considers A live here (its reclaim is at 2000) — proving the node
    // fenced ITSELF first, the whole point: no window where A admits into reassigned budget.
    expect("A" in coord.peek(KEY).shares).toBe(true);

    await guard.close();
  });

  it("a healthy node (beats keep landing) NEVER fences", async () => {
    const clock = new ManualClock(0);
    const coord = new TestConcurrencyCoordinator({ clock, aggregate: "min" });
    let fencedCalls = 0;
    const guard = mk(clock, coord, "A", { onFenced: () => fencedCalls++ });

    for (let t = 0; t <= 6000; t += 900) {
      clock.set(t);
      await guard.heartbeat(); // a successful beat every 900ms (< HB) keeps the lease fresh
      expect(guard.stats().fenced, `not fenced at t=${t}`).toBe(false);
      const l = guard.acquire();
      expect(l.ok, `admits at t=${t}`).toBe(true);
      l.release(); // release so capacity (not fencing) is never the reason a later acquire fails
    }
    expect(fencedCalls).toBe(0);
    await guard.close();
  });

  it("onFenced fires again after recovery + re-partition (once per episode)", async () => {
    const clock = new ManualClock(0);
    const coord = new TestConcurrencyCoordinator({ clock, aggregate: "min" });
    let fencedCalls = 0;
    const guard = mk(clock, coord, "A", { onFenced: () => fencedCalls++ });

    await guard.heartbeat(); // leaseExpiresAt 2000, deadline 1500
    clock.set(1500);
    expect(guard.acquire().ok).toBe(false);
    expect(fencedCalls).toBe(1); // episode 1

    // Recovery: a successful beat renews the lease ⇒ un-fence.
    await guard.heartbeat(); // leaseExpiresAt 1500+2000=3500, deadline 3000
    expect(guard.stats().fenced).toBe(false);
    expect(guard.acquire().ok).toBe(true);

    // Re-partition: advance past the new deadline ⇒ fence again, onFenced fires a 2nd time.
    clock.set(3000);
    expect(guard.acquire().ok).toBe(false);
    expect(fencedCalls, "a fresh episode re-fires onFenced").toBe(2);
    await guard.close();
  });

  it("local-only does NOT self-fence by default (it opts into serving through an outage)", async () => {
    const clock = new ManualClock(0);
    const coord = new TestConcurrencyCoordinator({ clock, aggregate: "min" });
    const guard = mk(clock, coord, "A", { onCoordinatorOutage: "local-only" });

    await guard.heartbeat(); // local-only: share = local.limit = 4
    clock.set(10_000); // long past any lease deadline, no beats
    expect(guard.stats().fenced, "local-only never self-fences by default").toBe(false);
    expect(guard.acquire().ok, "local-only keeps admitting (availability over bound)").toBe(true);
    await guard.close();
  });

  it("selfFence: false disables it even under fail-closed (opt-out)", async () => {
    const clock = new ManualClock(0);
    const coord = new TestConcurrencyCoordinator({ clock, aggregate: "min" });
    const guard = mk(clock, coord, "A", { selfFence: false });

    await guard.heartbeat();
    clock.set(10_000);
    expect(guard.stats().fenced).toBe(false);
    expect(guard.acquire().ok).toBe(true);
    await guard.close();
  });

  it("rejects a non-integer / negative fenceSafetyMargin when self-fencing", () => {
    const clock = new ManualClock(0);
    const coord = new TestConcurrencyCoordinator({ clock });
    expect(() => mk(clock, coord, "A", { fenceSafetyMargin: -5 })).toThrow(/fenceSafetyMargin/);
    expect(() => mk(clock, coord, "A", { fenceSafetyMargin: 2.5 })).toThrow(/fenceSafetyMargin/);
  });

  // THE HEADLINE: self-fencing closes the partition overshoot end to end. A saturates L, then
  // partitions; it self-fences + aborts (onFenced) at 1500, BEFORE the coordinator reclaims its
  // budget (2000). When B takes over, Σ inflight stays ≤ L. The selfFence:false run shows the
  // overshoot it fixes (the documented #4 residual).
  it("A self-fences + aborts before reclaim ⇒ B takes over with NO overshoot (vs the bug without it)", async () => {
    async function run(selfFence: boolean): Promise<number> {
      const clock = new ManualClock(0);
      const coord = new TestConcurrencyCoordinator({ clock, aggregate: "min" });
      const heldA: Lease[] = [];
      const a = mk(clock, coord, "A", {
        selfFence,
        // onFenced aborts A's in-flight (releases its leases) — the drain that closes the bound.
        onFenced: () => {
          for (const l of heldA.splice(0)) l.release();
        },
      });
      const b = mk(clock, coord, "B", { selfFence });

      // t=0: A solo ⇒ share 4; saturate. B joins ⇒ share 0 (A's budget reserved).
      await a.heartbeat();
      for (;;) {
        const l = a.acquire();
        if (!l.ok) break;
        heldA.push(l);
      }
      expect(a.inflight).toBe(4);
      await b.heartbeat();
      expect(b.stats().share).toBe(0);

      // A PARTITIONS (stops beating). At 1500 a request hits A → it checks its fence.
      clock.set(1500);
      a.acquire(); // triggers checkFence: self-fence (if on) ⇒ onFenced aborts A's in-flight

      // At 2001 the coordinator reclaims A (expiresAt 2000 < now); B re-beats and takes over.
      clock.set(2001);
      await b.heartbeat();
      expect("A" in coord.peek(KEY).shares, "coordinator has reclaimed the silent node").toBe(
        false,
      );
      expect(b.stats().share).toBe(4);
      for (;;) {
        const l = b.acquire();
        if (!l.ok) break;
      }

      // Σ inflight across both, AFTER the reassignment. With self-fencing A drained to 0 ⇒ ≤ L.
      const sum = a.inflight + b.inflight;
      await a.close();
      await b.close();
      return sum;
    }

    const withFence = await run(true);
    const withoutFence = await run(false);
    expect(
      withFence,
      "self-fencing: A aborted before B took over ⇒ Σ inflight ≤ L",
    ).toBeLessThanOrEqual(L);
    expect(
      withoutFence,
      "without self-fencing: A's in-flight + B's takeover overshoot L (#4)",
    ).toBeGreaterThan(L);
  });
});
