/**
 * TK-904 — window-coupled federated leasing behavior tests.
 *
 * The headline contribution: K regions sharing one `GlobalCoordinator`
 * achieve **Δ = 0** per global window (admissions ≤ Limit) **independent
 * of K**, matching the formal `spec/GaleFederatedLeasing.tla` bound.
 *
 * Mirrors `test/twotier/window-coupled.test.ts` but lifted to the regional
 * (federated) layer rather than the in-process layer.
 */

import { describe, expect, it } from "vitest";

import { fixedWindow } from "../../src/algorithms/fixed-window";
import { ManualClock } from "../../src/core/clock";
import type { GlobalCoordinator } from "../../src/federation";
import { TestCoordinator, federate } from "../../src/federation";

/** A 1000-token-per-second federation strategy. */
const fedStrategy = (limit = 1000) => fixedWindow({ limit, windowMs: 1000 });

interface Region {
  region: string;
  limiter: ReturnType<typeof federate>;
}

function makeRegions(
  names: readonly string[],
  coordinator: GlobalCoordinator,
  clock: ManualClock,
  batch = 16,
  limit = 1000,
): Region[] {
  return names.map((region) => ({
    region,
    limiter: federate({
      strategy: fedStrategy(limit),
      coordinator,
      region,
      batch,
      clock,
    }),
  }));
}

describe("federation/window-coupled (TK-904)", () => {
  describe("Δ = 0: total admissions across K regions ≤ Limit per window", () => {
    it("K=3 uniform load: total admitted is bounded by the global budget", async () => {
      const clock = new ManualClock(0);
      const coordinator = new TestCoordinator({ budgetPerWindow: 1000 });
      const regions = makeRegions(["us-east", "eu-west", "ap-south"], coordinator, clock, 16, 1000);

      // Offer 400 reqs at each region (1200 total — well past the 1000 budget).
      // Federation must cap total admissions at 1000.
      let admittedTotal = 0;
      for (let i = 0; i < 400; i++) {
        for (const { limiter } of regions) {
          const d = await limiter.check("k");
          if (d.allowed) admittedTotal++;
        }
      }
      // **Δ = 0 across regions:** never exceeds the global budget.
      expect(admittedTotal).toBeLessThanOrEqual(1000);
      // Also: should be CLOSE to 1000 (the federation pools effectively).
      expect(admittedTotal).toBeGreaterThan(900);
    });

    it("K=3 max-skew load: hot region admits up to global budget; others don't push it over", async () => {
      const clock = new ManualClock(0);
      const coordinator = new TestCoordinator({ budgetPerWindow: 1000 });
      const regions = makeRegions(["us-east", "eu-west", "ap-south"], coordinator, clock, 16, 1000);

      // ALL load lands on us-east. eu-west / ap-south get zero traffic.
      const usEast = regions[0]!.limiter;
      let admitted = 0;
      for (let i = 0; i < 2000; i++) {
        const d = await usEast.check("k");
        if (d.allowed) admitted++;
      }
      // Hot region admits up to (but never exceeds) the full global budget.
      expect(admitted).toBeLessThanOrEqual(1000);
      expect(admitted).toBeGreaterThan(900); // most of the global budget recovered
    });

    it("K=5 max-skew: bound is independent of K (the keystone GALE-federated claim)", async () => {
      const clock = new ManualClock(0);
      const coordinator = new TestCoordinator({ budgetPerWindow: 1000 });
      const regions = makeRegions(["r0", "r1", "r2", "r3", "r4"], coordinator, clock, 16, 1000);

      // All load on r0; r1..r4 idle.
      let admitted = 0;
      for (let i = 0; i < 2000; i++) {
        const d = await regions[0]!.limiter.check("k");
        if (d.allowed) admitted++;
      }
      expect(admitted).toBeLessThanOrEqual(1000); // same K-independent bound
      expect(admitted).toBeGreaterThan(900);
    });
  });

  describe("window-coupling: escrow expires at the window boundary", () => {
    it("uncommitted escrow forfeits across a window boundary", async () => {
      const clock = new ManualClock(0);
      const coordinator = new TestCoordinator({ budgetPerWindow: 1000 });
      const limiter = federate({
        strategy: fedStrategy(1000),
        coordinator,
        region: "us-east",
        batch: 100,
        clock,
      });

      // One check: leases batch=100. Now balance=99 (one consumed).
      const d1 = await limiter.check("k");
      expect(d1.allowed).toBe(true);
      expect(d1.remaining).toBe(99);

      // Advance past the window boundary.
      clock.set(1500);

      // Next check: balance should have expired (was 99 → 0), so a fresh
      // lease happens against the FRESH window's budget. Coordinator's
      // budget for the new window is 1000 again.
      const d2 = await limiter.check("k");
      expect(d2.allowed).toBe(true);
      // New window's expiresAt should be 2000 (next boundary after 1500).
      expect(d2.resetAt).toBe(2000);
    });

    it("admissions per window are independent — no carryover overshoot", async () => {
      const clock = new ManualClock(0);
      const coordinator = new TestCoordinator({ budgetPerWindow: 100 });
      const limiter = federate({
        strategy: fedStrategy(100),
        coordinator,
        region: "us-east",
        batch: 16,
        clock,
      });

      // Window 1: drive all 100. Verify exactly 100 admitted.
      let admittedW1 = 0;
      for (let i = 0; i < 200; i++) {
        const d = await limiter.check("k");
        if (d.allowed) admittedW1++;
      }
      expect(admittedW1).toBe(100);

      // Roll the window.
      clock.set(1500);

      // Window 2: another 200. Despite any leftover escrow, we should admit
      // up to 100 again (the fresh budget) — NOT 100 + leftover.
      let admittedW2 = 0;
      for (let i = 0; i < 200; i++) {
        const d = await limiter.check("k");
        if (d.allowed) admittedW2++;
      }
      expect(admittedW2).toBe(100);
    });

    it("reconcile fires at the next-window check (best-effort)", async () => {
      const clock = new ManualClock(0);
      const reconcileCalls: { key: string; leftover: number; windowStart: number }[] = [];
      const coordinator: GlobalCoordinator = {
        async lease(_key: string, tokens: number) {
          return tokens;
        },
        async reconcile(key: string, leftover: number, windowStart: number) {
          reconcileCalls.push({ key, leftover, windowStart });
        },
      };
      const limiter = federate({
        strategy: fedStrategy(100),
        coordinator,
        region: "us-east",
        batch: 16,
        clock,
      });

      // One check at t=0: lease batch=16, consume 1, balance=15.
      await limiter.check("k");

      // Roll to next window and trigger reconciliation via the next check.
      clock.set(1500);
      await limiter.check("k");

      expect(reconcileCalls).toHaveLength(1);
      expect(reconcileCalls[0]).toEqual({
        key: "k",
        leftover: 15,
        windowStart: 0,
      });
    });
  });

  describe("in-flight lease that resolves after a window roll must not credit the old window into the new", () => {
    /**
     * A per-window-budget coordinator (budget keyed by `expiresAt`) that commits each lease's draw
     * synchronously but HOLDS the resolving promise until released by `expiresAt` — modelling a real
     * (Redis/Postgres) coordinator where `lease()` awaits a network round trip and so can be in flight
     * while a concurrent same-key check rolls the window. Releasing by `expiresAt` lets us settle the
     * fresh-window lease BEFORE the stale one, isolating the window-roll path from the separate
     * coalescing double-credit.
     */
    function gatedPerWindow(budgetPerWindow: number) {
      const budgets = new Map<number, number>();
      const gates: { exp: number; resolve: () => void }[] = [];
      const reconciles: { leftover: number; windowStart: number }[] = [];
      const coordinator: GlobalCoordinator = {
        async lease(_key, tokens, expiresAt) {
          const rem = budgets.get(expiresAt) ?? budgetPerWindow;
          const granted = Math.min(tokens, rem);
          budgets.set(expiresAt, rem - granted); // commit the draw at fire time (resetAt baked here)
          await new Promise<void>((resolve) => gates.push({ exp: expiresAt, resolve }));
          return granted;
        },
        async reconcile(_key, leftover, windowStart) {
          reconciles.push({ leftover, windowStart });
        },
      };
      const releaseExp = async (exp: number): Promise<void> => {
        const i = gates.findIndex((g) => g.exp === exp);
        if (i >= 0) gates.splice(i, 1)[0]!.resolve();
        await Promise.resolve();
        await Promise.resolve();
      };
      return { coordinator, releaseExp, reconciles };
    }

    it("forfeits a grant leased against a rolled window and reconciles it to the old window", async () => {
      const clock = new ManualClock(0);
      const g = gatedPerWindow(100);
      const limiter = federate({
        strategy: fedStrategy(100),
        coordinator: g.coordinator,
        region: "us-east",
        batch: 100,
        clock,
      });

      // A leases against window [0,1000) and blocks in flight.
      clock.set(10);
      const pA = limiter.check("k");
      await Promise.resolve();
      await Promise.resolve();

      // Roll into window [1000,2000); B issues its OWN lease (the roll nulled A's pending) and blocks.
      clock.set(1500);
      const pB = limiter.check("k");
      await Promise.resolve();
      await Promise.resolve();

      // Settle the fresh window-1 lease first (so A re-loops into existing credits, not a coalesce),
      // then the stale window-0 lease.
      await g.releaseExp(2000);
      await g.releaseExp(1000);

      const decA = await pA;
      const decB = await pB;

      // Both served against the fresh window; total admitted is bounded by ONE fresh batch (100),
      // not the smuggled two (the stale window-0 grant + the fresh window-1 grant = 200 pre-fix).
      expect(decA.resetAt).toBe(2000);
      expect(decB.resetAt).toBe(2000);
      expect(Math.max(decA.remaining, decB.remaining)).toBeLessThanOrEqual(99);
      // The stale grant is forfeited from L1 and reconciled back to its OWN (window-0) start.
      expect(g.reconciles).toContainEqual({ leftover: 100, windowStart: 0 });
    });
  });

  describe("lease coalescing: at most one in-flight lease per key per region", () => {
    it("concurrent shortages on the same key issue ONE lease", async () => {
      const clock = new ManualClock(0);
      let leaseCalls = 0;
      const coordinator: GlobalCoordinator = {
        async lease(_key: string, tokens: number) {
          leaseCalls++;
          // Simulate cross-region RTT — defer the resolution so concurrent
          // callers actually race onto the in-flight promise.
          await Promise.resolve();
          await Promise.resolve();
          return tokens;
        },
        async reconcile() {},
      };
      const limiter = federate({
        strategy: fedStrategy(1000),
        coordinator,
        region: "us-east",
        batch: 16,
        clock,
      });

      // 100 concurrent checks on the same key when balance starts at 0.
      const results = await Promise.all(Array.from({ length: 100 }, () => limiter.check("hot")));

      // All concurrent shortages should have ridden a SMALL number of leases —
      // ideally a handful, definitely not 100. The exact count depends on
      // microtask scheduling but is bounded by ceil(100 / batch) = 7.
      expect(leaseCalls).toBeLessThanOrEqual(7);
      expect(results.every((r) => r.allowed)).toBe(true);
    });
  });

  describe("fail-closed on coordinator outage", () => {
    it("returns denied Decision when the coordinator throws (fail-closed default)", async () => {
      const clock = new ManualClock(0);
      const coordinator = new TestCoordinator({ budgetPerWindow: 1000 });
      coordinator.setHealthy(false); // simulate partition

      const limiter = federate({
        strategy: fedStrategy(1000),
        coordinator,
        region: "us-east",
        batch: 16,
        clock,
      });

      const d = await limiter.check("k");
      expect(d.allowed).toBe(false);
      expect(d.remaining).toBe(0);
      expect(d.retryAfterMs).toBeGreaterThan(0);
    });

    it("recovers once the coordinator returns", async () => {
      const clock = new ManualClock(0);
      const coordinator = new TestCoordinator({ budgetPerWindow: 1000 });
      const limiter = federate({
        strategy: fedStrategy(1000),
        coordinator,
        region: "us-east",
        batch: 16,
        clock,
      });

      // Heal mid-test.
      coordinator.setHealthy(false);
      expect((await limiter.check("k")).allowed).toBe(false);
      coordinator.setHealthy(true);
      expect((await limiter.check("k")).allowed).toBe(true);
    });
  });

  describe("federate() Limiter surface", () => {
    it("returns a real Limiter whose checkSync throws (federation is async)", async () => {
      const clock = new ManualClock(0);
      const limiter = federate({
        strategy: fedStrategy(100),
        coordinator: new TestCoordinator({ budgetPerWindow: 100 }),
        region: "us-east",
        clock,
      });
      expect(limiter.strategy.name).toBe("fixedWindow");
      expect(() => limiter.checkSync("k")).toThrow(/cannot run sync/);
      expect(() => limiter.checkManySync(["k"])).toThrow(/cannot run sync/);
    });

    it("checkMany delegates concurrently and returns per-key Decisions", async () => {
      const clock = new ManualClock(0);
      const limiter = federate({
        strategy: fedStrategy(100),
        coordinator: new TestCoordinator({ budgetPerWindow: 100 }),
        region: "us-east",
        clock,
      });
      const decisions = await limiter.checkMany(["a", "b", "c"]);
      expect(decisions).toHaveLength(3);
      expect(decisions.every((d) => d.allowed)).toBe(true);
    });

    it("reset() drops per-key state without contacting the coordinator", async () => {
      const clock = new ManualClock(0);
      let leaseCalls = 0;
      const coordinator: GlobalCoordinator = {
        async lease(_k: string, tokens: number) {
          leaseCalls++;
          return tokens;
        },
        async reconcile() {},
      };
      const limiter = federate({
        strategy: fedStrategy(100),
        coordinator,
        region: "us-east",
        batch: 16,
        clock,
      });
      await limiter.check("k"); // leases (1 call)
      const callsBefore = leaseCalls;
      await limiter.reset("k");
      // reset should not have triggered a new lease.
      expect(leaseCalls).toBe(callsBefore);
    });

    it("throws on construction when strategy has no windowMs (pure-rate unsupported)", () => {
      // Build a fake pure-rate strategy (no windowMs).
      const pureRate = {
        name: "fake",
        limit: 100,
        ttlMs: 1000,
        check: () => ({ state: undefined, result: {} as never, ttlMs: 0, persist: false }),
      };
      expect(() =>
        federate({
          // biome-ignore lint/suspicious/noExplicitAny: deliberate type punch to test runtime guard
          strategy: pureRate as any,
          coordinator: new TestCoordinator({ budgetPerWindow: 100 }),
          region: "us-east",
        }),
      ).toThrow(/windowMs must be defined/);
    });
  });
});
