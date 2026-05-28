import { describe, expect, it } from "vitest";

import type { Lease } from "../../src/concurrency/adaptive";
import type { ConcurrencyReport } from "../../src/concurrency/coordinator";
import {
  type HeartbeatScheduler,
  distributedAdaptiveConcurrency,
} from "../../src/concurrency/distributed";
import { TestConcurrencyCoordinator } from "../../src/concurrency/test-concurrency-coordinator";
import { ManualClock } from "../../src/core/clock";

/**
 * Unit substrate for `distributedAdaptiveConcurrency` (§11.1 of
 * research/bigger-bets/distributed-adaptive-concurrency/DESIGN.md). Every
 * heartbeat is driven deterministically: a FAKE {@link HeartbeatScheduler}
 * captures the timer callback (we invoke it by hand — no real timers, no
 * sleeps), the guard reads time from an injected {@link ManualClock}, and the
 * cross-node state lives in a {@link TestConcurrencyCoordinator}.
 *
 * The bullets covered, in order (§11.1):
 *   - equal-split shares + Σ share = L_global (min/median aggregate over reported lLocal);
 *   - the gate is min(share, local.limit): shrink share ⇒ shed; spike RTT ⇒
 *     local.limit drops ⇒ shed even under a large share (D-DAC-6);
 *   - cold start: fail-closed rejects pre-first-heartbeat; local-only admits to local.limit;
 *   - coordinator outage via setHealthy(false) for BOTH modes + recovery;
 *   - close() cancels the timer, calls leave(), is idempotent; post-close acquire is cold-start;
 *   - release idempotency inherited from the base guard.
 */

/**
 * A deterministic {@link HeartbeatScheduler} that never fires on its own: it
 * captures the callback + interval at construction so the test invokes the
 * heartbeat tick by hand. `cancel()` is recorded so `close()` can be asserted
 * to have stopped the timer.
 */
class FakeScheduler implements HeartbeatScheduler {
  fn: (() => void) | undefined;
  everyMs: number | undefined;
  cancelled = false;
  scheduleCalls = 0;

  schedule(fn: () => void, everyMs: number): { cancel(): void } {
    this.scheduleCalls++;
    this.fn = fn;
    this.everyMs = everyMs;
    return {
      cancel: (): void => {
        this.cancelled = true;
      },
    };
  }

  /** Fire the captured timer callback once (the steady-state heartbeat tick). */
  tick(): void {
    if (this.fn === undefined) throw new Error("FakeScheduler.tick before schedule()");
    this.fn();
  }
}

/**
 * Wraps {@link TestConcurrencyCoordinator} so a test can both (a) inspect what
 * `leave()` was called with and how many times, and (b) seed a *neighbour*
 * node's report directly — the neighbour's `lLocal` is what pulls `lGlobal`
 * (hence our `share`) up or down under a 2-node fleet.
 */
class SpyCoordinator extends TestConcurrencyCoordinator {
  leaveCalls: Array<{ key: string; nodeId: string }> = [];

  override async leave(args: { key: string; nodeId: string }): Promise<void> {
    this.leaveCalls.push(args);
    await super.leave(args);
  }
}

/** A neighbour heartbeat with a fixed `lLocal`, lease far in the future (stays live). */
function seedNeighbour(
  coord: TestConcurrencyCoordinator,
  args: { key: string; nodeId: string; lLocal: number; clock: ManualClock },
): Promise<unknown> {
  const report: ConcurrencyReport = {
    key: args.key,
    nodeId: args.nodeId,
    lLocal: args.lLocal,
    inflight: 0,
    expiresAt: args.clock.now() + 1_000_000,
  };
  return coord.heartbeat(report);
}

/** Drain a batch of leases (release each once, healthy). */
function releaseAll(leases: Lease[]): void {
  for (const l of leases) l.release();
}

describe("distributedAdaptiveConcurrency (§11.1)", () => {
  describe("equal-split shares + Σ share = L_global", () => {
    it("median aggregate over reported lLocal: share = ⌊L/N⌋ (+1 by rank) and Σ share = L", async () => {
      const clock = new ManualClock(0);
      // Two nodes, each pinning local.limit = 7 (min=max=initial ⇒ no RTT can move it),
      // so both report lLocal = 7. median([7,7]) = 7 = L_global, N = 2.
      const coord = new TestConcurrencyCoordinator({ aggregate: "median", clock });
      const local = { minLimit: 7, maxLimit: 7, initialLimit: 7 };

      const a = distributedAdaptiveConcurrency({
        coordinator: coord,
        nodeId: "node-a",
        key: "backend",
        local,
        clock,
        scheduler: new FakeScheduler(),
      });
      const b = distributedAdaptiveConcurrency({
        coordinator: coord,
        nodeId: "node-b",
        key: "backend",
        local,
        clock,
        scheduler: new FakeScheduler(),
      });

      await a.heartbeat();
      await b.heartbeat();
      // A second round so both shares reflect a 2-node fleet, not a's solo first heartbeat.
      await a.heartbeat();
      await b.heartbeat();

      // L = 7, N = 2 ⇒ base = 3, rem = 1. Sorted nodeIds: [node-a, node-b]; rank 0 gets +1.
      expect(a.stats().lGlobal).toBe(7);
      expect(a.stats().nodes).toBe(2);
      expect(a.stats().share).toBe(4); // ⌊7/2⌋ + 1 (rank 0)
      expect(b.stats().share).toBe(3); // ⌊7/2⌋     (rank 1)
      // Σ share = L_global exactly (the §6 safety lemma).
      expect(a.stats().share + b.stats().share).toBe(7);

      await a.close();
      await b.close();
    });

    it("min aggregate: the most-stressed node's lLocal caps the fleet; a fresh joiner sees 0 then converges to L/2", async () => {
      const clock = new ManualClock(0);
      const coord = new TestConcurrencyCoordinator({ aggregate: "min", clock });

      const a = distributedAdaptiveConcurrency({
        coordinator: coord,
        nodeId: "node-a",
        key: "backend",
        local: { minLimit: 10, maxLimit: 10, initialLimit: 10 }, // reports lLocal = 10
        clock,
        scheduler: new FakeScheduler(),
      });
      // Neighbour reports a far-lower lLocal = 4 and ALREADY holds the whole budget:
      // solo, min([4]) = 4 = L_global, share = min(4, 4−0) = 4.
      await seedNeighbour(coord, { key: "backend", nodeId: "node-z", lLocal: 4, clock });
      expect(coord.peek("backend").shares["node-z"]).toBe(4);

      // BUDGET-CAP semantics (D-DAC-17): A joins while node-z still holds share 4.
      // L = 4, N = 2 ⇒ target = 2, but others = node-z.share = 4, so
      // A.share = max(0, min(2, 4−4)) = 0 — a fresh joiner gets 0 until the
      // incumbent re-heartbeats DOWN. (The old stateless ⌊L/N⌋ would have handed
      // A=2 while z still held 4, i.e. Σ share = 6 > L = 4 — the bug.)
      await a.heartbeat();
      expect(a.stats().lGlobal).toBe(4);
      expect(a.stats().nodes).toBe(2);
      expect(a.stats().share).toBe(0);
      const afterJoin = coord.peek("backend");
      // GlobalCap holds throughout: 4 + 0 ≤ 4.
      expect(afterJoin.shares["node-a"]! + afterJoin.shares["node-z"]!).toBeLessThanOrEqual(4);

      // Incumbent re-heartbeats: node-z now sees others = A.share = 0, target = 2,
      // so z.share = min(2, 4−0) = 2. Then A re-heartbeats: others = z.share = 2,
      // target = 2, A.share = min(2, 4−2) = 2. The fleet converges to the equal split.
      await seedNeighbour(coord, { key: "backend", nodeId: "node-z", lLocal: 4, clock });
      await a.heartbeat();
      expect(a.stats().share).toBe(2);
      const converged = coord.peek("backend");
      expect(converged.shares["node-a"]).toBe(2);
      expect(converged.shares["node-z"]).toBe(2);
      expect(converged.shares["node-a"]! + converged.shares["node-z"]!).toBe(4); // Σ share = L

      await a.close();
    });
  });

  describe("budget cap under staggered join (D-DAC-17)", () => {
    it("drives the coordinator directly: A alone ⇒ L; B joins ⇒ B=0 while A holds L; A re-heartbeats ⇒ both = L/2 — Σ stored share ≤ lGlobal at every step", async () => {
      const clock = new ManualClock(0);
      // median over equal lLocal = 10 ⇒ lGlobal = 10 for any nonempty live set.
      const coord = new TestConcurrencyCoordinator({ aggregate: "median", clock });
      const L = 10;
      const expiresAt = clock.now() + 1_000_000; // stays live throughout
      const report = (nodeId: string): ConcurrencyReport => ({
        key: "backend",
        nodeId,
        lLocal: L,
        inflight: 0,
        expiresAt,
      });
      // GlobalCap assertion read from the coordinator's OWN stored shares (peek),
      // checked after every heartbeat — the hard invariant the bug violated.
      const assertGlobalCap = (label: string): void => {
        const { lGlobal, shares } = coord.peek("backend");
        const sum = Object.values(shares).reduce((acc, s) => acc + s, 0);
        expect(sum, `[${label}] Σ stored share=${sum} ≤ lGlobal=${lGlobal}`).toBeLessThanOrEqual(
          lGlobal,
        );
      };

      // 1. A heartbeats ALONE ⇒ solo, target = L, others = 0 ⇒ share = L.
      const gA1 = await coord.heartbeat(report("node-a"));
      expect(gA1.share).toBe(L);
      expect(gA1.lGlobal).toBe(L);
      expect(gA1.nodes).toBe(1);
      assertGlobalCap("A alone");

      // 2. B JOINS (first heartbeat) while A still holds the full L. base = 5,
      //    rem = 0 ⇒ target = 5, but others = A.share = L = 10, so the CAP gives
      //    B.share = max(0, min(5, 10−10)) = 0. The stateless ⌊L/N⌋ split (the bug)
      //    would have handed B = 5 while A still held 10 ⇒ Σ = 15 > L. The cap holds.
      const gB1 = await coord.heartbeat(report("node-b"));
      expect(gB1.share).toBe(0);
      expect(gB1.nodes).toBe(2);
      expect(coord.peek("backend").shares["node-a"]).toBe(L); // A unchanged: still holds L
      assertGlobalCap("B joins (B=0, A=L)");

      // 3. A RE-HEARTBEATS: others = B.share = 0, target = 5 ⇒ A.share = min(5, 10−0) = 5.
      const gA2 = await coord.heartbeat(report("node-a"));
      expect(gA2.share).toBe(5);
      assertGlobalCap("A re-splits to 5");

      // 4. B re-heartbeats: others = A.share = 5, target = 5 ⇒ B.share = min(5, 10−5) = 5.
      const gB2 = await coord.heartbeat(report("node-b"));
      expect(gB2.share).toBe(5);
      assertGlobalCap("B converges to 5");

      // Converged equal split: Σ stored share = L exactly (no capacity lost).
      const final = coord.peek("backend");
      expect(final.shares["node-a"]).toBe(5);
      expect(final.shares["node-b"]).toBe(5);
      expect(final.shares["node-a"]! + final.shares["node-b"]!).toBe(L);
    });
  });

  describe("gate is min(share, local.limit)", () => {
    it("shrink share ⇒ node sheds (share below local.limit closes the gate)", async () => {
      const clock = new ManualClock(0);
      // min aggregate so a low-lLocal neighbour drives our share down hard.
      const coord = new TestConcurrencyCoordinator({ aggregate: "min", clock });
      const guard = distributedAdaptiveConcurrency({
        coordinator: coord,
        nodeId: "node-a",
        key: "backend",
        // local.limit pinned high at 100 — the gate is NOT limited by local here.
        local: { minLimit: 100, maxLimit: 100, initialLimit: 100 },
        clock,
        scheduler: new FakeScheduler(),
      });

      // Neighbour with lLocal = 2 ⇒ min([100,2]) = 2 = L_global; N = 2 ⇒ base 1, rem 0 ⇒ target 1.
      // BUDGET-CAP semantics (D-DAC-17): node-z (seeded solo first) holds the whole
      // budget (share 2), so when node-a joins it is CAPPED to min(1, 2−2) = 0 until
      // the fleet re-splits. Drive the convergence round so node-a settles at share 1:
      //   - node-z re-heartbeats: others = a.share(0), target 1 ⇒ z.share = min(1, 2−0) = 1;
      //   - node-a re-heartbeats: others = z.share(1), target 1 ⇒ a.share = min(1, 2−1) = 1.
      await seedNeighbour(coord, { key: "backend", nodeId: "node-z", lLocal: 2, clock });
      await guard.heartbeat();
      expect(guard.stats().share).toBe(0); // fresh joiner: capped to 0 while z holds 2
      await seedNeighbour(coord, { key: "backend", nodeId: "node-z", lLocal: 2, clock });
      await guard.heartbeat();
      expect(guard.stats().share).toBe(1); // converged: ⌊2/2⌋ = 1
      expect(guard.stats().limit).toBe(1); // min(share=1, local.limit=100)

      // One admit fills the share; the gate is now closed despite local.limit = 100.
      const first = guard.acquire();
      expect(first.ok).toBe(true);
      expect(guard.inflight).toBe(1);

      const shed = guard.acquire();
      expect(shed.ok).toBe(false); // inflight(1) >= min(share=1, local.limit=100)
      expect(guard.inflight).toBe(1); // a rejected lease holds no slot

      first.release();
      await guard.close();
    });

    it("spike RTT ⇒ local.limit drops ⇒ node sheds even with a large share (D-DAC-6)", async () => {
      const clock = new ManualClock(0);
      // Both nodes report a high lLocal initially, so share is generously large and the gate
      // is governed by local.limit, not share.
      const coord = new TestConcurrencyCoordinator({ aggregate: "min", clock });
      const guard = distributedAdaptiveConcurrency({
        coordinator: coord,
        nodeId: "node-a",
        key: "backend",
        // local can move: starts at 100, floor 4. A dropped sample contracts it.
        local: { minLimit: 4, maxLimit: 512, initialLimit: 100 },
        clock,
        scheduler: new FakeScheduler(),
      });
      // Neighbour also high: min([100,100]) = 100 = L_global, N = 2 ⇒ base 50, rem 0 ⇒ target 50.
      // BUDGET-CAP semantics (D-DAC-17): node-z (seeded solo) holds the whole budget
      // (share 100), so node-a is capped to 0 on join; one convergence round re-splits
      // to the equal share 50 (z re-heartbeats to 50, then a heartbeats to min(50,100−50)=50).
      await seedNeighbour(coord, { key: "backend", nodeId: "node-z", lLocal: 100, clock });
      await guard.heartbeat();
      expect(guard.stats().share).toBe(0); // fresh joiner: capped to 0 while z holds 100
      await seedNeighbour(coord, { key: "backend", nodeId: "node-z", lLocal: 100, clock });
      await guard.heartbeat();
      const shareBefore = guard.stats().share;
      expect(shareBefore).toBe(50); // a large share, governed by neither local nor share yet
      expect(guard.stats().limit).toBe(50); // min(share=50, local.limit=100) = 50

      // Drive local.limit down via dropped samples at full utilization. Each round fills to the
      // effective ceiling min(share, local.limit), advances the clock, and drops every lease: a
      // dropped sample pins the gradient2 ratio to its 0.5 floor, so local.limit contracts
      // monotonically toward minLimit (4) — well below the large share (50).
      let prevLimit = guard.stats().limit;
      for (let round = 0; round < 30 && guard.stats().limit > 4; round++) {
        const leases: Lease[] = [];
        for (;;) {
          const l = guard.acquire();
          if (!l.ok) break;
          leases.push(l);
        }
        clock.advance(1);
        for (const l of leases) l.release({ dropped: true });
        const now = guard.stats().limit;
        expect(now).toBeLessThanOrEqual(prevLimit); // the gate is non-increasing under drops
        prevLimit = now;
      }

      // local.limit has collapsed toward its floor, well below the large share. The effective
      // gate is now local.limit, not share — the node sheds without any new heartbeat
      // (sub-heartbeat local reaction, D-DAC-6).
      expect(guard.stats().share).toBe(50); // share is UNCHANGED (no heartbeat since)
      expect(guard.stats().limit).toBeLessThan(50); // gate dropped: min(50, local.limit) = local.limit

      // Fill exactly to the (now small) effective ceiling, then the next acquire sheds — even
      // though the share (50) is huge.
      const fill: Lease[] = [];
      for (;;) {
        const l = guard.acquire();
        if (!l.ok) break;
        fill.push(l);
      }
      expect(fill.length).toBe(guard.stats().limit);
      expect(fill.length).toBeLessThan(shareBefore); // sheds far below the share
      const shed = guard.acquire();
      expect(shed.ok).toBe(false);

      releaseAll(fill);
      await guard.close();
    });
  });

  describe("cold start (D-DAC-12)", () => {
    it("fail-closed: acquire() rejects before the first heartbeat (share = 0)", () => {
      const clock = new ManualClock(0);
      const coord = new TestConcurrencyCoordinator({ clock });
      const guard = distributedAdaptiveConcurrency({
        coordinator: coord,
        nodeId: "node-a",
        key: "backend",
        local: { minLimit: 8, maxLimit: 8, initialLimit: 8 },
        onCoordinatorOutage: "fail-closed",
        clock,
        scheduler: new FakeScheduler(), // captured, never auto-fires
      });

      // No heartbeat has landed: share = 0 ⇒ min(0, 8) = 0 ⇒ admit nothing.
      expect(guard.stats().share).toBe(0);
      expect(guard.stats().limit).toBe(0);
      const l = guard.acquire();
      expect(l.ok).toBe(false);
      expect(guard.inflight).toBe(0);
      l.release(); // rejected-lease release is a harmless no-op
      expect(guard.inflight).toBe(0);
    });

    it("local-only: acquire() admits up to local.limit before the first heartbeat (share = local.limit)", () => {
      const clock = new ManualClock(0);
      const coord = new TestConcurrencyCoordinator({ clock });
      const guard = distributedAdaptiveConcurrency({
        coordinator: coord,
        nodeId: "node-a",
        key: "backend",
        local: { minLimit: 5, maxLimit: 5, initialLimit: 5 },
        onCoordinatorOutage: "local-only",
        clock,
        scheduler: new FakeScheduler(),
      });

      // Cold start under local-only: share = local.limit = 5 ⇒ gate is pure in-process adaptive.
      expect(guard.stats().share).toBe(5);
      expect(guard.stats().limit).toBe(5);

      const leases: Lease[] = [];
      for (;;) {
        const l = guard.acquire();
        if (!l.ok) break;
        leases.push(l);
      }
      expect(leases.length).toBe(5); // admits exactly up to local.limit
      expect(guard.acquire().ok).toBe(false); // and no further
      releaseAll(leases);
    });
  });

  describe("coordinator outage (§8.2) — both modes + recovery", () => {
    it("fail-closed: setHealthy(false) drives share → 0; setHealthy(true) restores it", async () => {
      const clock = new ManualClock(0);
      const coord = new TestConcurrencyCoordinator({ aggregate: "min", clock });
      const guard = distributedAdaptiveConcurrency({
        coordinator: coord,
        nodeId: "node-a",
        key: "backend",
        local: { minLimit: 6, maxLimit: 6, initialLimit: 6 },
        onCoordinatorOutage: "fail-closed",
        clock,
        scheduler: new FakeScheduler(),
      });

      // Healthy heartbeat: solo node ⇒ share = lLocal = 6.
      await guard.heartbeat();
      expect(guard.stats().share).toBe(6);
      expect(guard.acquire().ok).toBe(true);

      // OUTAGE: heartbeat throws (StoreUnavailableError, swallowed) ⇒ fail-closed ⇒ share 0.
      coord.setHealthy(false);
      await guard.heartbeat(); // never throws (outage → outage policy)
      expect(guard.stats().share).toBe(0);
      expect(guard.stats().limit).toBe(0);
      // A fresh acquire sheds (existing leases drain, but nothing new is admitted).
      expect(guard.acquire().ok).toBe(false);

      // RECOVERY: heal and heartbeat — share is restored.
      coord.setHealthy(true);
      await guard.heartbeat();
      expect(guard.stats().share).toBe(6);
      expect(guard.acquire().ok).toBe(true);

      await guard.close();
    });

    it("local-only: setHealthy(false) drives share → local.limit; setHealthy(true) restores the coordinated share", async () => {
      const clock = new ManualClock(0);
      const coord = new TestConcurrencyCoordinator({ aggregate: "min", clock });
      const guard = distributedAdaptiveConcurrency({
        coordinator: coord,
        nodeId: "node-a",
        key: "backend",
        local: { minLimit: 9, maxLimit: 9, initialLimit: 9 }, // local.limit pinned at 9
        onCoordinatorOutage: "local-only",
        clock,
        scheduler: new FakeScheduler(),
      });

      // A low-lLocal neighbour (seeded solo) holds the whole budget, so node-a is
      // capped to 0 on join (BUDGET-CAP, D-DAC-17); one convergence round re-splits to
      // the steady coordinated share 1 (min([9,2]) = 2; base 1, rem 0 ⇒ each gets 1).
      await seedNeighbour(coord, { key: "backend", nodeId: "node-z", lLocal: 2, clock });
      await guard.heartbeat();
      expect(guard.stats().share).toBe(0); // fresh joiner: capped while z holds 2
      await seedNeighbour(coord, { key: "backend", nodeId: "node-z", lLocal: 2, clock });
      await guard.heartbeat();
      expect(guard.stats().share).toBe(1); // converged steady share
      expect(guard.stats().limit).toBe(1);

      // OUTAGE: local-only ⇒ share = local.limit = 9 (each node self-limits; fleet may overshoot).
      coord.setHealthy(false);
      await guard.heartbeat();
      expect(guard.stats().share).toBe(9);
      expect(guard.stats().limit).toBe(9); // min(9, local.limit=9)

      // RECOVERY: the coordinated (tight) share comes back. node-z still holds its
      // converged share 1 in coordinator state, so a single heartbeat re-derives
      // a.share = min(1, 2−1) = 1 (no extra convergence needed).
      coord.setHealthy(true);
      await guard.heartbeat();
      expect(guard.stats().share).toBe(1);
      expect(guard.stats().limit).toBe(1);

      await guard.close();
    });
  });

  describe("close() lifecycle", () => {
    it("cancels the timer, calls leave(), and is idempotent", async () => {
      const clock = new ManualClock(0);
      const coord = new SpyCoordinator({ clock });
      const scheduler = new FakeScheduler();
      const guard = distributedAdaptiveConcurrency({
        coordinator: coord,
        nodeId: "node-a",
        key: "backend",
        local: { minLimit: 4, maxLimit: 4, initialLimit: 4 },
        clock,
        scheduler,
      });

      await guard.heartbeat();
      expect(scheduler.scheduleCalls).toBe(1); // the timer was scheduled at construction
      expect(scheduler.cancelled).toBe(false);

      await guard.close();
      expect(scheduler.cancelled).toBe(true); // timer cancelled
      expect(coord.leaveCalls).toEqual([{ key: "backend", nodeId: "node-a" }]); // leave() called

      // Idempotent: a second close() does not throw and does not call leave() again.
      await guard.close();
      expect(coord.leaveCalls).toHaveLength(1);
    });

    it("post-close acquire behaves per cold-start: no timer means share is never refreshed", async () => {
      const clock = new ManualClock(0);
      const coord = new TestConcurrencyCoordinator({ clock });
      const scheduler = new FakeScheduler();
      const guard = distributedAdaptiveConcurrency({
        coordinator: coord,
        nodeId: "node-a",
        key: "backend",
        local: { minLimit: 4, maxLimit: 4, initialLimit: 4 },
        onCoordinatorOutage: "fail-closed",
        clock,
        scheduler,
      });

      await guard.close();
      // close() cancelled the timer, so no heartbeat ever refreshes the share. Under fail-closed
      // the cold-start share stayed 0, so a post-close acquire sheds — exactly the cold-start gate.
      expect(scheduler.cancelled).toBe(true);
      expect(guard.stats().share).toBe(0);
      expect(guard.stats().limit).toBe(0);
      const l = guard.acquire();
      expect(l.ok).toBe(false);
      expect(guard.inflight).toBe(0);
    });
  });

  describe("release idempotency (inherited from the base guard)", () => {
    it("a double release() does not decrement inflight twice", async () => {
      const clock = new ManualClock(0);
      const coord = new TestConcurrencyCoordinator({ aggregate: "min", clock });
      const guard = distributedAdaptiveConcurrency({
        coordinator: coord,
        nodeId: "node-a",
        key: "backend",
        local: { minLimit: 10, maxLimit: 10, initialLimit: 10 },
        clock,
        scheduler: new FakeScheduler(),
      });

      await guard.heartbeat(); // solo node ⇒ share = 10
      const l = guard.acquire();
      expect(l.ok).toBe(true);
      expect(guard.inflight).toBe(1);

      clock.advance(5);
      l.release();
      expect(guard.inflight).toBe(0);

      // Second release is a no-op — inflight is not driven negative / double-decremented.
      l.release({ dropped: true });
      expect(guard.inflight).toBe(0);

      await guard.close();
    });
  });
});
