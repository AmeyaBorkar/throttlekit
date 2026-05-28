/**
 * TK-1306 — `onCoordinatorOutage: "regional-only"` outage mode.
 *
 * The availability-over-precision opt-in: when the coordinator is unreachable
 * AND a `regionalEscrow` is configured, the engine continues serving from
 * the L2 balance until depletion. Federation bound (Δ = 0) degrades to the
 * regional sub-bound (≤ perKeyBudget) during the outage. On recovery
 * (`coordinator.isHealthy()` returning true after `coordinatorHealthCheckMs`),
 * normal lease + reconcile resumes.
 *
 * Tests cover:
 * - The regional-only outage gate prevents per-request coord.lease attempts
 *   (vs fail-closed which retries every request)
 * - L2 with pre-seeded balance keeps serving during outage; engine resumes
 *   after coord recovery + probe interval elapse
 * - Window-boundary recovery: Δ = 0 re-enforced after recovery
 * - Health-probe cadence respects `coordinatorHealthCheckMs`
 * - Degenerate cases: no regionalEscrow → silent fall-back to fail-closed;
 *   no `coordinator.isHealthy` → stuck-in-unhealthy (documented limitation)
 *
 * State note: in steady-state engine flow, L2 typically reaches 0 between
 * refills (the engine eagerly pulls `batch` from L2 into L1 on shortage).
 * Tests that need L2 to have balance at outage onset seed it via direct
 * `l2.refill()` calls — this is the documented multi-process pattern where
 * one process refills L2 just before another reaches it.
 */

import { describe, expect, it } from "vitest";

import { fixedWindow } from "../../src/algorithms/fixed-window";
import { ManualClock } from "../../src/core/clock";
import { StoreUnavailableError } from "../../src/core/errors";
import { TestCoordinator, TestRegionalEscrow, federate } from "../../src/federation";
import type { GlobalCoordinator } from "../../src/federation";

const windowMs = 10_000; // long window so we control timing precisely

const mkEngine = (
  region: string,
  coord: GlobalCoordinator,
  l2: TestRegionalEscrow | undefined,
  clock: ManualClock,
  outage: "fail-closed" | "regional-only" = "regional-only",
  healthCheckMs = 5_000,
  batch = 8,
) =>
  federate({
    strategy: fixedWindow({ limit: 100, windowMs }),
    coordinator: coord,
    region,
    batch,
    clock,
    onCoordinatorOutage: outage,
    coordinatorHealthCheckMs: healthCheckMs,
    ...(l2 !== undefined ? { regionalEscrow: l2 } : {}),
  });

describe("federation × regional-only outage mode (TK-1306)", () => {
  describe("the regional-only outage gate", () => {
    it("once tripped, subsequent requests bypass coord.lease entirely (fast fail)", async () => {
      // Setup: warm up with one coord trip, then outage. The first request
      // post-outage hits coord.lease (which throws → marks unhealthy). All
      // subsequent requests should DENY via the gate without further
      // coord.lease attempts.
      const clock = new ManualClock(0);
      const coord = new TestCoordinator({ budgetPerWindow: 100 });
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      const eng = mkEngine("us-east", coord, l2, clock, "regional-only", 5_000, 8);

      // Warm up — drains L1 and L2.
      for (let i = 0; i < 16; i++) await eng.check("k");

      // Take coord down.
      coord.setHealthy(false);
      // Track coord.lease invocations by wrapping (proxy via spy).
      let leaseCalls = 0;
      const realLease = coord.lease.bind(coord);
      coord.lease = async (...args) => {
        leaseCalls++;
        return realLease(...args);
      };

      // First request: L1=0, L2=0, falls through to coord.lease which throws
      // and marks unhealthy.
      await eng.check("k");
      expect(leaseCalls).toBe(1);

      // Next 50 requests: gate should short-circuit them all WITHOUT touching coord.
      for (let i = 0; i < 50; i++) await eng.check("k");
      expect(leaseCalls).toBe(1); // still 1 — the gate prevented further attempts
    });

    it("fail-closed mode keeps retrying coord.lease per request (no gate)", async () => {
      const clock = new ManualClock(0);
      const coord = new TestCoordinator({ budgetPerWindow: 100 });
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      const eng = mkEngine("us-east", coord, l2, clock, "fail-closed", 5_000, 8);

      for (let i = 0; i < 16; i++) await eng.check("k");

      coord.setHealthy(false);
      let leaseCalls = 0;
      const realLease = coord.lease.bind(coord);
      coord.lease = async (...args) => {
        leaseCalls++;
        return realLease(...args);
      };

      // 10 requests during outage — fail-closed retries coord.lease each time.
      for (let i = 0; i < 10; i++) await eng.check("k");
      expect(leaseCalls).toBe(10);
    });
  });

  describe("L2-seeded outage: serves from L2 until depletion", () => {
    it("L2 with balance keeps admitting during coord outage; denies once L2 drains", async () => {
      const clock = new ManualClock(0);
      const coord = new TestCoordinator({ budgetPerWindow: 100 });
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      const eng = mkEngine("us-east", coord, l2, clock, "regional-only", 5_000, 8);

      // Seed L2 with the current window's source_lease so the engine reaches it.
      const ws = 0; // window starts at 0
      await l2.refill("k", 24, ws);
      expect(l2.balanceFor("k")).toBe(24);

      // Take coord down. L2 still has 24 + the engine has no L1 balance yet.
      coord.setHealthy(false);

      // Engine serves from L2 — each check pulls batch=8 to L1, then admits.
      // 24 L2 tokens + 8-token L1 batches → ~24 admits total (give or take L1
      // leftover dropping when L2 is exhausted).
      let admitted = 0;
      for (let i = 0; i < 200; i++) {
        if ((await eng.check("k")).allowed) admitted++;
      }
      expect(admitted).toBeGreaterThanOrEqual(20);
      expect(admitted).toBeLessThanOrEqual(24);

      // Once depleted, all further requests denied (gate active).
      for (let i = 0; i < 10; i++) {
        expect((await eng.check("k")).allowed).toBe(false);
      }
    });

    it("recovery via probe: coord heals + clock advances past healthCheckMs → resumes", async () => {
      const clock = new ManualClock(0);
      const coord = new TestCoordinator({ budgetPerWindow: 100 });
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      const eng = mkEngine("us-east", coord, l2, clock, "regional-only", 5_000, 8);

      // Trigger outage. Engine marks unhealthy on first L1+L2-exhausted check.
      for (let i = 0; i < 16; i++) await eng.check("k");
      coord.setHealthy(false);
      // Need to drive a coord.lease attempt to trip the unhealthy mark.
      await eng.check("k"); // marks unhealthy
      // Verify: subsequent checks all denied.
      expect((await eng.check("k")).allowed).toBe(false);

      // Heal coord; advance clock past healthCheckMs.
      coord.setHealthy(true);
      clock.advance(5_001);

      // Next check probes coord.isHealthy → returns true → marks healthy → resumes.
      const d = await eng.check("k");
      expect(d.allowed).toBe(true);
    });
  });

  describe("window-boundary recovery", () => {
    it("after recovery in a fresh window, Δ = 0 federation bound holds", async () => {
      const clock = new ManualClock(0);
      const coord = new TestCoordinator({ budgetPerWindow: 100 });
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      const eng = mkEngine("us-east", coord, l2, clock, "regional-only", 5_000, 8);

      // Window 1: warm up and trigger outage.
      for (let i = 0; i < 16; i++) await eng.check("k");
      coord.setHealthy(false);
      // Drive a coord.lease attempt to mark unhealthy.
      await eng.check("k");

      // Roll into window 2 while coord still down.
      clock.set(windowMs + 1);

      // During window-2 outage with no L2 balance, deny all.
      for (let i = 0; i < 50; i++) {
        expect((await eng.check("k")).allowed).toBe(false);
      }

      // Coord recovers mid-window 2.
      coord.setHealthy(true);
      clock.advance(5_001); // past probe interval

      // Engine resumes. Window 2 has a fresh perKeyBudget.
      let admittedW2 = 0;
      for (let i = 0; i < 200; i++) {
        if ((await eng.check("k")).allowed) admittedW2++;
      }
      // Δ = 0 federation bound: ≤ perKeyBudget.
      expect(admittedW2).toBeLessThanOrEqual(100);
      expect(admittedW2).toBeGreaterThan(80);
    });
  });

  describe("health-probe cadence", () => {
    it("respects coordinatorHealthCheckMs — no probe before interval elapses", async () => {
      const clock = new ManualClock(0);
      const coord = new TestCoordinator({ budgetPerWindow: 100 });
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      const eng = mkEngine("us-east", coord, l2, clock, "regional-only", 5_000, 8);

      // Warm up + trigger outage.
      for (let i = 0; i < 16; i++) await eng.check("k");
      coord.setHealthy(false);
      await eng.check("k"); // mark unhealthy

      // Coord heals BEFORE the probe interval elapses.
      coord.setHealthy(true);

      // Probe only fires after healthCheckMs elapsed since the unhealthy mark.
      clock.advance(4_000);
      const dEarly = await eng.check("k");
      expect(dEarly.allowed).toBe(false); // still gated; probe not yet fired

      // Pass the interval boundary.
      clock.advance(1_500); // total 5_500 > 5_000
      const dLate = await eng.check("k");
      expect(dLate.allowed).toBe(true); // probe fired; healthy detected
    });

    it("the validator rejects invalid coordinatorHealthCheckMs", () => {
      const coord = new TestCoordinator({ budgetPerWindow: 100 });
      const clock = new ManualClock(0);
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      expect(() =>
        federate({
          strategy: fixedWindow({ limit: 100, windowMs }),
          coordinator: coord,
          region: "us-east",
          regionalEscrow: l2,
          coordinatorHealthCheckMs: 0,
        }),
      ).toThrow(RangeError);
      expect(() =>
        federate({
          strategy: fixedWindow({ limit: 100, windowMs }),
          coordinator: coord,
          region: "us-east",
          regionalEscrow: l2,
          coordinatorHealthCheckMs: -1,
        }),
      ).toThrow(RangeError);
    });
  });

  describe("degenerate cases", () => {
    it("regional-only WITHOUT regionalEscrow silently degrades to fail-closed", async () => {
      const clock = new ManualClock(0);
      const coord = new TestCoordinator({ budgetPerWindow: 100 });
      const eng = mkEngine("us-east", coord, undefined, clock, "regional-only", 5_000, 8);

      // Warm up.
      await eng.check("k");
      // Outage.
      coord.setHealthy(false);
      // Drain L1.
      for (let i = 0; i < 200; i++) await eng.check("k");
      // All denied past initial L1 drain (no L2 buffer, no gate).
      for (let i = 0; i < 50; i++) {
        expect((await eng.check("k")).allowed).toBe(false);
      }

      // Recovery picks up reactively on next successful lease.
      coord.setHealthy(true);
      expect((await eng.check("k")).allowed).toBe(true);
    });

    it("regional-only with NO coordinator.isHealthy: stuck in unhealthy until next-window roll", async () => {
      // Build a coordinator that exposes lease + reconcile but NO isHealthy.
      // Without a probe, the engine has no way to learn that the coordinator
      // has recovered — the gate stays active. This is a documented
      // limitation of the regional-only mode.
      const inner = new TestCoordinator({ budgetPerWindow: 100 });
      const coordNoHealth: GlobalCoordinator = {
        lease: (k, t, e) => inner.lease(k, t, e),
        reconcile: (k, l, ws) => inner.reconcile(k, l, ws),
        // isHealthy deliberately omitted
      };
      const clock = new ManualClock(0);
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      const eng = mkEngine("us-east", coordNoHealth, l2, clock, "regional-only", 5_000, 8);

      // Warm up.
      for (let i = 0; i < 16; i++) await eng.check("k");

      // Outage.
      inner.setHealthy(false);
      // Drive a coord.lease attempt to mark unhealthy.
      await eng.check("k");
      // Subsequent requests denied (gate).
      expect((await eng.check("k")).allowed).toBe(false);

      // Coord heals. No probe possible (isHealthy missing).
      inner.setHealthy(true);
      clock.advance(10_000); // past probe interval — but no probe to run

      // Documented limitation: without `coordinator.isHealthy`, regional-only
      // mode has no automated recovery — the engine stays gated indefinitely
      // (even across window rolls, because the `coordinatorHealthy` flag is
      // engine-global, not per-window). Prefer to expose `isHealthy` on
      // coordinators destined for regional-only mode (both RedisCoordinator
      // and PostgresCoordinator do).
      const d = await eng.check("k");
      expect(d.allowed).toBe(false);
    });

    it("L2.refill failure during coord-lease path doesn't lose the grant", async () => {
      // If the L2 refill throws but coord.lease succeeded, the engine credits
      // the grant directly to L1 (matches 0.8.4 behavior). Tests this
      // degradation path.
      const clock = new ManualClock(0);
      const coord = new TestCoordinator({ budgetPerWindow: 100 });
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      // Wrap l2.refill to throw.
      const realRefill = l2.refill.bind(l2);
      l2.refill = async () => {
        throw new StoreUnavailableError("synthetic L2 outage");
      };
      const eng = mkEngine("us-east", coord, l2, clock, "regional-only", 5_000, 8);

      // Engine attempts: L2.lease(8) → 0 (empty). coord.lease(8) → 8.
      // L2.refill(8, ws) → throws. Engine fallback: credit 8 directly to L1.
      const d = await eng.check("k");
      expect(d.allowed).toBe(true);

      // Restore refill so we can verify subsequent normal flow.
      l2.refill = realRefill;
    });
  });
});
