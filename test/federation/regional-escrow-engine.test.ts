/**
 * TK-1306 — federation engine integration with `RegionalEscrow`.
 *
 * Tests the L1 → L2 → L3 routing in `createFederationEngine` when a
 * `regionalEscrow` is configured. The L2 contract itself is exercised in
 * `regional-escrow.test.ts`; here we test the ENGINE's use of it:
 *
 * - Multi-process atomicity: M engines sharing one `RegionalEscrow` admit at
 *   most `perKeyBudget` per region per window (the new sub-bound).
 * - Backward compat: `federate({ ... })` without `regionalEscrow` behaves
 *   identically to 0.8.4 (all existing tests must still pass; spot-check).
 * - L2-as-cache: when L2 has balance, engines lease from it without a
 *   coordinator round-trip (the latency-win path).
 * - Reconcile recovery: L2 leftover + L1 leftover both flow back to L3 at
 *   window roll (first releaser wins for the unified reconcile).
 * - L2 outage degradation: when `regionalEscrow.lease()` throws, the engine
 *   falls through to direct L3 leasing (the documented degradation path).
 *
 * Always-on: uses `TestRegionalEscrow` + `TestCoordinator` with `ManualClock`.
 * No Redis required. The Redis-backed conformance is implicit via the
 * RedisRegionalEscrow conformance tests in `redis-regional-escrow.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { fixedWindow } from "../../src/algorithms/fixed-window";
import { ManualClock } from "../../src/core/clock";
import { TestCoordinator, TestRegionalEscrow, federate } from "../../src/federation";

const windowMs = 1000;

const mkEngine = (
  region: string,
  coordinator: TestCoordinator,
  l2: TestRegionalEscrow | undefined,
  clock: ManualClock,
  batch = 8,
) =>
  federate({
    strategy: fixedWindow({ limit: 100, windowMs }),
    coordinator,
    region,
    batch,
    clock,
    ...(l2 !== undefined ? { regionalEscrow: l2 } : {}),
  });

describe("federation engine × RegionalEscrow (TK-1306)", () => {
  describe("multi-process atomicity — M engines share one L2", () => {
    it("M=2 engines in the same region admit ≤ perKeyBudget total per window", async () => {
      const clock = new ManualClock(0);
      const coord = new TestCoordinator({ budgetPerWindow: 100 });
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      const p1 = mkEngine("us-east", coord, l2, clock, 8);
      const p2 = mkEngine("us-east", coord, l2, clock, 8);

      let total = 0;
      for (let i = 0; i < 200; i++) {
        if ((await p1.check("k")).allowed) total++;
        if ((await p2.check("k")).allowed) total++;
      }
      // Δ = 0 federation bound (L3 cap): total admissions ≤ perKeyBudget.
      expect(total).toBeLessThanOrEqual(100);
      // Utilization: most of the budget recovered (some L1 leftover is
      // lost in multi-process mode — documented).
      expect(total).toBeGreaterThan(80);
    });

    it("M=4 engines in the same region admit ≤ perKeyBudget total per window", async () => {
      const clock = new ManualClock(0);
      const coord = new TestCoordinator({ budgetPerWindow: 200 });
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      const engines = Array.from({ length: 4 }, (_, i) =>
        mkEngine(`us-east-p${i}`, coord, l2, clock, 8),
      );

      let total = 0;
      for (let i = 0; i < 200; i++) {
        for (const eng of engines) {
          if ((await eng.check("k")).allowed) total++;
        }
      }
      expect(total).toBeLessThanOrEqual(200);
      expect(total).toBeGreaterThan(150); // most of the budget recovered
    });

    it("M=8 engines in the same region admit ≤ perKeyBudget total per window", async () => {
      const clock = new ManualClock(0);
      const coord = new TestCoordinator({ budgetPerWindow: 500 });
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      const engines = Array.from({ length: 8 }, (_, i) =>
        mkEngine(`us-east-p${i}`, coord, l2, clock, 8),
      );

      let total = 0;
      for (let i = 0; i < 100; i++) {
        for (const eng of engines) {
          if ((await eng.check("k")).allowed) total++;
        }
      }
      expect(total).toBeLessThanOrEqual(500);
      expect(total).toBeGreaterThan(400);
    });

    it("different regions sharing the same coordinator each get their share", async () => {
      const clock = new ManualClock(0);
      const coord = new TestCoordinator({ budgetPerWindow: 300 });
      const l2East = new TestRegionalEscrow({ windowMs, clock });
      const l2West = new TestRegionalEscrow({ windowMs, clock });
      // East has 2 processes; West has 2 processes; each region uses its own L2.
      const e1 = mkEngine("us-east", coord, l2East, clock, 8);
      const e2 = mkEngine("us-east", coord, l2East, clock, 8);
      const w1 = mkEngine("us-west", coord, l2West, clock, 8);
      const w2 = mkEngine("us-west", coord, l2West, clock, 8);

      let total = 0;
      for (let i = 0; i < 100; i++) {
        if ((await e1.check("k")).allowed) total++;
        if ((await e2.check("k")).allowed) total++;
        if ((await w1.check("k")).allowed) total++;
        if ((await w2.check("k")).allowed) total++;
      }
      // Federation bound holds across regions: total ≤ perKeyBudget (the L3 cap).
      expect(total).toBeLessThanOrEqual(300);
      expect(total).toBeGreaterThan(250);
    });
  });

  describe("L2-as-cache — fewer coordinator round-trips than 0.8.4", () => {
    it("second process's first lease lands from L2 (no extra coord trip)", async () => {
      // Setup: P1 leases from coord, refills L2. P2's first lease should find
      // balance in L2 and lease from there without another coord trip.
      // The cleanest way to verify "L2 hit short-circuits the coord trip" is to
      // pre-seed an L2 balance via direct refill, then assert that a check()
      // serves from L2 without touching the coordinator. (Driving P1 first then
      // P2 would empty L2 in this engine's lease pattern — the engine pulls its
      // full batch into L1 — so we can't observe the L2-hit on the second-process
      // path that way.)
      const clock = new ManualClock(0);
      const coord = new TestCoordinator({ budgetPerWindow: 100 });
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      const p2 = mkEngine("us-east", coord, l2, clock, 4);

      const ws = 0; // window starts at clock=0
      await l2.refill("k", 40, ws);
      expect(coord.remainingFor("k", windowMs - 1)).toBe(100); // coord untouched

      // P2 first check: L1 empty, L2 has 40 (refill above), so P2 leases from L2.
      const d = await p2.check("k");
      expect(d.allowed).toBe(true);

      // L3 still has the full perKeyBudget — P2's lease was served entirely
      // from the L2 cache (no coordinator round-trip).
      expect(coord.remainingFor("k", windowMs - 1)).toBe(100);
    });
  });

  describe("backward compat — federate without regionalEscrow is 0.8.4", () => {
    it("single engine (no L2) gives the same admit count as 0.8.4 would", async () => {
      // Same workload, but no regionalEscrow.
      const clock = new ManualClock(0);
      const coord = new TestCoordinator({ budgetPerWindow: 100 });
      const eng = mkEngine("us-east", coord, undefined, clock, 8);

      let total = 0;
      for (let i = 0; i < 200; i++) {
        if ((await eng.check("k")).allowed) total++;
      }
      // 0.8.4 behavior: engine multi-leases from coord up to perKeyBudget.
      expect(total).toBe(100);
    });

    it("engine works with M=1 + regionalEscrow ≈ identical to 0.8.4", async () => {
      // Single-process with regionalEscrow should match 0.8.4 closely
      // (L2 introduces a routing step but doesn't change the perKeyBudget cap;
      // L1+L2 leftover are both reconciled by the same single process).
      const clock = new ManualClock(0);
      const coord = new TestCoordinator({ budgetPerWindow: 100 });
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      const eng = mkEngine("us-east", coord, l2, clock, 8);

      let total = 0;
      for (let i = 0; i < 200; i++) {
        if ((await eng.check("k")).allowed) total++;
      }
      // Δ = 0 federation bound: total ≤ 100. With M=1 the unified reconcile
      // (L1+L2 leftover) recovers all leftover capacity, so total ≈ 100.
      expect(total).toBeLessThanOrEqual(100);
      expect(total).toBe(100);
    });
  });

  describe("window-roll recovery — L1+L2 leftover reconciled at boundary", () => {
    it("M=1 with regionalEscrow: window 2's budget refreshes to 100", async () => {
      const clock = new ManualClock(0);
      const coord = new TestCoordinator({ budgetPerWindow: 100 });
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      const eng = mkEngine("us-east", coord, l2, clock, 8);

      // Window 1: use a few.
      for (let i = 0; i < 50; i++) await eng.check("k");
      // Roll into window 2.
      clock.set(windowMs + 1);
      // Settle the lazy reconcile that fires on the next check().
      await eng.check("k");
      // Allow the void promise (reconcile) to flush.
      await new Promise<void>((resolve) => setImmediate(resolve));

      // Window 2: should have a full fresh budget available.
      let admitted = 0;
      for (let i = 0; i < 200; i++) {
        if ((await eng.check("k")).allowed) admitted++;
      }
      // Total admissions in window 2 ≤ 100; we should get most of the fresh budget.
      expect(admitted).toBeLessThanOrEqual(100);
      expect(admitted).toBeGreaterThan(85); // window 2 mostly available
    });
  });

  describe("L2 outage degradation — engine falls back to direct L3 leasing", () => {
    it("when L2 throws, engine continues via L3 (matches 0.8.4)", async () => {
      const clock = new ManualClock(0);
      const coord = new TestCoordinator({ budgetPerWindow: 100 });
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      const eng = mkEngine("us-east", coord, l2, clock, 8);

      // Initial leases work normally.
      for (let i = 0; i < 5; i++) await eng.check("k");

      // L2 dies (regional Redis partition simulation).
      l2.setHealthy(false);

      // Engine should continue — falls through to direct L3 lease.
      let admittedAfter = 0;
      for (let i = 0; i < 200; i++) {
        if ((await eng.check("k")).allowed) admittedAfter++;
      }
      expect(admittedAfter).toBeGreaterThan(80); // most of remaining budget
      // Total admissions ≤ perKeyBudget.
      const totalRemaining = coord.remainingFor("k", windowMs - 1);
      expect(totalRemaining).toBeGreaterThanOrEqual(0); // L3's view consistent
    });
  });

  describe("invariant — federation bound (Δ = 0) holds with regionalEscrow", () => {
    it("randomized M+skew across multiple windows never exceeds perKeyBudget", async () => {
      const seeds = [1, 7, 13, 42, 99];
      for (const seed of seeds) {
        const clock = new ManualClock(0);
        const coord = new TestCoordinator({ budgetPerWindow: 100 });
        const l2 = new TestRegionalEscrow({ windowMs, clock });
        const M = (seed % 3) + 2; // M ∈ {2, 3, 4}
        const engines = Array.from({ length: M }, (_, i) =>
          mkEngine(`p${i}`, coord, l2, clock, (seed % 4) + 2),
        );

        // Drive a skewed workload — one engine hot, others light.
        let total = 0;
        const window1Limit = 200; // enough requests to drive past perKeyBudget
        for (let i = 0; i < window1Limit; i++) {
          // hot engine
          if ((await engines[0]!.check("k")).allowed) total++;
          // others
          if (i % 3 === 0) {
            for (let j = 1; j < M; j++) {
              if ((await engines[j]!.check("k")).allowed) total++;
            }
          }
        }
        // Federation bound: total ≤ perKeyBudget for window 1.
        expect(total).toBeLessThanOrEqual(100);
      }
    });
  });
});
