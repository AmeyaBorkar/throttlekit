/**
 * TK-907 — cross-region failure-mode tests.
 *
 * Forces each of the three documented federation failure modes
 * (PLAN.md §3.4 / DESIGN.md §5) and asserts the bound holds under all
 * three. No flakiness — uses TestCoordinator's `setHealthy(false)` lever
 * for partition simulation; no real Redis required.
 *
 * The three scenarios:
 * - Region partitioned from coordinator → fail-closed locally; Δ = 0 holds
 *   trivially because no new admissions happen during the outage.
 * - Coordinator crash + recovery before next window → idempotent reconcile
 *   converges; Δ = 0 maintained across the recovery.
 * - Coordinator unavailable across a window boundary → no admissions
 *   during outage (federation is fully unavailable); Δ = 0 by construction.
 *
 * The takeaway: federation fails CLOSED across every outage shape — there
 * is no outage scenario where Δ exceeds 0 (PLAN.md §3.4 bullet 3 was
 * pessimistic about the cross-window-boundary case; the actual behavior
 * is "zero admissions during the outage", which trivially satisfies the
 * bound).
 */

import { describe, expect, it } from "vitest";

import { fixedWindow } from "../../src/algorithms/fixed-window";
import { ManualClock } from "../../src/core/clock";
import { TestCoordinator, federate } from "../../src/federation";

const windowMs = 1000;
const mkLimiter = (region: string, coordinator: TestCoordinator, clock: ManualClock, batch = 8) =>
  federate({
    strategy: fixedWindow({ limit: 100, windowMs }),
    coordinator,
    region,
    batch,
    clock,
  });

describe("federation/failure-modes (TK-907)", () => {
  describe("scenario 1: region partitioned from coordinator", () => {
    it("fails closed — denies new traffic during outage; Δ stays 0", async () => {
      const clock = new ManualClock(0);
      const coord = new TestCoordinator({ budgetPerWindow: 100 });
      const us = mkLimiter("us-east", coord, clock);
      const eu = mkLimiter("eu-west", coord, clock);

      // Pre-outage: each region admits a few. (us takes 8 — one batch; eu takes 8.)
      for (let i = 0; i < 8; i++) await us.check("k");
      for (let i = 0; i < 8; i++) await eu.check("k");
      // Coordinator has 100 - 16 = 84 left. Each region's local escrow has 0 (batches consumed).

      // PARTITION: coordinator unreachable.
      coord.setHealthy(false);

      // Both regions try to lease — fail-closed (coordinator throws, fall through to "deny").
      let denied = 0;
      for (let i = 0; i < 50; i++) {
        if (!(await us.check("k")).allowed) denied++;
        if (!(await eu.check("k")).allowed) denied++;
      }
      expect(denied).toBe(100); // all denied (no leases possible)

      // HEAL.
      coord.setHealthy(true);
      // Lease should now succeed.
      const d = await us.check("k");
      expect(d.allowed).toBe(true);
    });

    it("a region with existing escrow keeps serving until the escrow runs out, then denies", async () => {
      // Verifies the in-process escrow IS NOT IMMEDIATELY DROPPED on outage —
      // it continues serving until exhaustion (matches twoTier(leased) semantics).
      // At our TK-904 commit, the engine doesn't pre-detect coordinator health;
      // it discovers the outage on the first lease attempt. So a region with
      // existing escrow serves the next (batch-1) requests with no coordinator
      // hits — this is the desired behavior.
      const clock = new ManualClock(0);
      const coord = new TestCoordinator({ budgetPerWindow: 100 });
      const us = mkLimiter("us-east", coord, clock, 8);

      // Lease one batch.
      await us.check("k"); // leases 8, consumes 1, balance=7

      // Partition.
      coord.setHealthy(false);

      // 7 more requests should ride the existing escrow without hitting the coordinator.
      let allowed = 0;
      for (let i = 0; i < 7; i++) {
        if ((await us.check("k")).allowed) allowed++;
      }
      expect(allowed).toBe(7); // all admit from existing escrow

      // 8th request: balance=0, lease attempt fails → deny.
      expect((await us.check("k")).allowed).toBe(false);
    });
  });

  describe("scenario 2: coordinator crash + recovery before next window", () => {
    it("idempotent reconciliation converges — Δ = 0 maintained across recovery", async () => {
      const clock = new ManualClock(0);
      const coord = new TestCoordinator({ budgetPerWindow: 100 });
      const us = mkLimiter("us-east", coord, clock, 8);
      const eu = mkLimiter("eu-west", coord, clock, 8);

      // Pre-outage: each leases one batch (8 each = 16 total drawn from 100).
      // us spends 1; eu spends 1; balances: us=7, eu=7. Coord remaining=84.
      await us.check("k");
      await eu.check("k");
      expect(coord.remainingFor("k", windowMs - 1)).toBe(84);

      // CRASH the coordinator mid-window. New leases fail; existing escrow keeps serving.
      coord.setHealthy(false);

      // us serves its 7 remaining, then denies.
      for (let i = 0; i < 7; i++) {
        const d = await us.check("k");
        expect(d.allowed).toBe(true);
      }
      expect((await us.check("k")).allowed).toBe(false);

      // RECOVER (still within the same window).
      coord.setHealthy(true);
      expect(coord.remainingFor("k", windowMs - 1)).toBe(84);

      // us should be able to lease again — coordinator's view of remaining is still 84.
      const d = await us.check("k");
      expect(d.allowed).toBe(true);

      // Δ = 0: total admissions never exceeded the global budget.
      // We admitted: us 1 + 7 + 1 = 9; eu 1 = 1. Total: 10. Far below 100.
      // Now drain the budget completely; total should never exceed 100.
      let total = 10; // already-admitted
      while (true) {
        const ud = (await us.check("k")).allowed;
        const ed = (await eu.check("k")).allowed;
        if (!ud && !ed) break;
        if (ud) total++;
        if (ed) total++;
        if (total > 200) break; // safety
      }
      expect(total).toBeLessThanOrEqual(100);
      expect(total).toBeGreaterThan(80); // most of the budget recovered
    });
  });

  describe("scenario 3: coordinator unavailable across a window boundary", () => {
    it("admits zero during the outage — Δ = 0 trivially", async () => {
      const clock = new ManualClock(0);
      const coord = new TestCoordinator({ budgetPerWindow: 100 });
      const us = mkLimiter("us-east", coord, clock, 8);

      // Lease in window 1.
      await us.check("k"); // balance=7
      for (let i = 0; i < 7; i++) await us.check("k"); // balance=0

      // PARTITION. Drive past window boundary while down.
      coord.setHealthy(false);
      clock.set(windowMs + 500); // window 2

      // No admissions during outage in window 2.
      let outageAdmits = 0;
      for (let i = 0; i < 50; i++) {
        if ((await us.check("k")).allowed) outageAdmits++;
      }
      expect(outageAdmits).toBe(0);

      // HEAL after the cross-window outage.
      coord.setHealthy(true);

      // Window 2's fresh budget should now be available.
      // The first request will lease against the fresh window's budget.
      let admittedAfterHeal = 0;
      for (let i = 0; i < 200; i++) {
        if ((await us.check("k")).allowed) admittedAfterHeal++;
      }
      // Window 2's budget is 100 (fresh window); region admits its share.
      expect(admittedAfterHeal).toBeLessThanOrEqual(100);
      expect(admittedAfterHeal).toBeGreaterThan(90); // most of fresh window recovered
    });
  });

  describe("invariant — Δ = 0 holds across EVERY outage shape", () => {
    it("randomized outage timing never causes Δ > 0", async () => {
      // Run multiple iterations with different partition timings and verify
      // total admissions across regions never exceeds the global budget per
      // window. This is the safety claim distilled to one assertion.
      const seeds = [1, 7, 13, 42, 99, 100, 1234];
      for (const seed of seeds) {
        const clock = new ManualClock(0);
        const coord = new TestCoordinator({ budgetPerWindow: 100 });
        const limiters = ["us-east", "eu-west", "ap-south"].map((r) =>
          mkLimiter(r, coord, clock, 8),
        );

        let total = 0;
        for (let i = 0; i < 200; i++) {
          // Partition at request `seed` for `seed % 30` requests, then heal.
          if (i === seed) coord.setHealthy(false);
          if (i === seed + (seed % 30)) coord.setHealthy(true);

          for (const l of limiters) {
            if ((await l.check("k")).allowed) total++;
          }
        }
        // Across however the outage played out, Δ = 0 must hold.
        expect(total).toBeLessThanOrEqual(100);
      }
    });
  });
});
