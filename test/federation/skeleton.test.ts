/**
 * Skeleton tests for the federation public surface.
 *
 * - TK-902 froze the public types + classes + barrel exports.
 * - TK-904 made `FederatedStore.apply()` work (delegates to the shared
 *   federation engine; cost extracted from the transform's `lua.cost` hint;
 *   returns a synthesized Decision).
 *
 * The richer behavior tests (Δ = 0, window-coupling, coalescing, fail-closed,
 * utilization recovery) live in `window-coupled.test.ts` and
 * `federated-skew.test.ts`. This file stays focused on the surface
 * (constructor, defaults, validation, the Store↔engine wiring).
 *
 * TestCoordinator behavior tests are thorough here — it backs every later
 * subtask's tests so its semantics are pinned.
 */

import { describe, expect, it } from "vitest";

import { fixedWindow } from "../../src/algorithms/fixed-window";
import { ManualClock } from "../../src/core/clock";
import { StoreUnavailableError } from "../../src/core/errors";
import { decisionTransform } from "../../src/core/transform";
import type { Store } from "../../src/core/types";
import { FederatedStore, type GlobalCoordinator, TestCoordinator } from "../../src/federation";
import { MemoryStore } from "../../src/stores/memory";

const baseStrategy = () => fixedWindow({ limit: 100, windowMs: 1000 });

describe("federation/skeleton (TK-902 surface, TK-904 wiring)", () => {
  describe("FederatedStore — public surface", () => {
    it("constructs with required options + sensible defaults", () => {
      const fed = new FederatedStore({
        strategy: baseStrategy(),
        regional: new MemoryStore({ sweepIntervalMs: 0 }),
        coordinator: new TestCoordinator({ budgetPerWindow: 100 }),
        region: "us-east",
      });
      expect(fed.region).toBe("us-east");
      expect(fed.batch).toBe(16); // default
      expect(fed.onCoordinatorOutage).toBe("fail-closed"); // safe default
      expect(fed.strategy.name).toBe("fixedWindow");
    });

    it("honors explicit batch + outage mode", () => {
      const fed = new FederatedStore({
        strategy: baseStrategy(),
        regional: new MemoryStore({ sweepIntervalMs: 0 }),
        coordinator: new TestCoordinator(),
        region: "eu-west",
        batch: 32,
        onCoordinatorOutage: "regional-only",
      });
      expect(fed.batch).toBe(32);
      expect(fed.onCoordinatorOutage).toBe("regional-only");
    });

    it("rejects non-positive / non-finite batch", () => {
      const base = {
        strategy: baseStrategy(),
        regional: new MemoryStore({ sweepIntervalMs: 0 }),
        coordinator: new TestCoordinator(),
        region: "us-east",
      } as const;
      expect(() => new FederatedStore({ ...base, batch: 0 })).toThrow(RangeError);
      expect(() => new FederatedStore({ ...base, batch: -1 })).toThrow(RangeError);
      expect(() => new FederatedStore({ ...base, batch: Number.NaN })).toThrow(RangeError);
      expect(() => new FederatedStore({ ...base, batch: Number.POSITIVE_INFINITY })).toThrow(
        RangeError,
      );
    });

    it("apply() now works — synthesizes a Decision from the engine (TK-904)", async () => {
      const clock = new ManualClock(0);
      const fed = new FederatedStore({
        strategy: baseStrategy(),
        regional: new MemoryStore({ sweepIntervalMs: 0 }),
        coordinator: new TestCoordinator({ budgetPerWindow: 100 }),
        region: "us-east",
        clock,
      });
      const d = await fed.apply("k", decisionTransform(baseStrategy(), 0, 1));
      expect(d).toMatchObject({
        allowed: true,
        limit: 100,
        retryAfterMs: 0,
      });
      // resetAt is the window boundary at windowMs=1000, now=0 → 1000.
      expect((d as { resetAt: number }).resetAt).toBe(1000);
    });

    it("reset() drops the engine's per-key state AND delegates to the regional store", async () => {
      let resetKey: string | undefined;
      const spyRegional: Store = {
        apply: async () => ({}) as never,
        reset: async (key: string) => {
          resetKey = key;
        },
      };
      const fed = new FederatedStore({
        strategy: baseStrategy(),
        regional: spyRegional,
        coordinator: new TestCoordinator({ budgetPerWindow: 100 }),
        region: "us-east",
      });
      await fed.reset("user:42");
      expect(resetKey).toBe("user:42");
    });

    it("close() releases engine state (no caller-owned resources)", async () => {
      const fed = new FederatedStore({
        strategy: baseStrategy(),
        regional: new MemoryStore({ sweepIntervalMs: 0 }),
        coordinator: new TestCoordinator(),
        region: "us-east",
      });
      await expect(fed.close()).resolves.toBeUndefined();
    });

    it("recommendedBatch() falls back to the static batch when no sizer / invalid sizer output", () => {
      const fed = new FederatedStore({
        strategy: baseStrategy(),
        regional: new MemoryStore({ sweepIntervalMs: 0 }),
        coordinator: new TestCoordinator(),
        region: "us-east",
        batch: 24,
      });
      expect(fed.recommendedBatch()).toBe(24);

      const fedWithBadSizer = new FederatedStore({
        strategy: baseStrategy(),
        regional: new MemoryStore({ sweepIntervalMs: 0 }),
        coordinator: new TestCoordinator(),
        region: "us-east",
        batch: 12,
        sizer: { recommend: () => Number.NaN },
      });
      expect(fedWithBadSizer.recommendedBatch()).toBe(12);

      const fedWithGoodSizer = new FederatedStore({
        strategy: baseStrategy(),
        regional: new MemoryStore({ sweepIntervalMs: 0 }),
        coordinator: new TestCoordinator(),
        region: "us-east",
        batch: 12,
        sizer: { recommend: () => 7.9 },
      });
      // Floors the sizer output — leases must be whole tokens.
      expect(fedWithGoodSizer.recommendedBatch()).toBe(7);
    });

    it("exposes the underlying regional store + coordinator + strategy for introspection", () => {
      const strategy = baseStrategy();
      const regional = new MemoryStore({ sweepIntervalMs: 0 });
      const coordinator = new TestCoordinator({ budgetPerWindow: 50 });
      const fed = new FederatedStore({ strategy, regional, coordinator, region: "ap-south" });
      expect(fed.regional).toBe(regional);
      expect(fed.coordinator).toBe(coordinator);
      expect(fed.strategy).toBe(strategy);
    });
  });

  describe("TestCoordinator — implements GlobalCoordinator contract", () => {
    const T_EXPIRES = 1_700_000_000_000;

    it("lease grants the requested tokens when budget allows", async () => {
      const c = new TestCoordinator({ budgetPerWindow: 100 });
      expect(await c.lease("k", 16, T_EXPIRES)).toBe(16);
      expect(await c.lease("k", 16, T_EXPIRES)).toBe(16);
      expect(c.remainingFor("k", T_EXPIRES - 1)).toBe(100 - 32);
    });

    it("lease grants partially when contention drains the budget below request", async () => {
      const c = new TestCoordinator({ budgetPerWindow: 10 });
      expect(await c.lease("k", 16, T_EXPIRES)).toBe(10); // partial grant
      expect(await c.lease("k", 5, T_EXPIRES)).toBe(0); // exhausted
    });

    it("rolls the budget when expiresAt changes (window-coupling)", async () => {
      const c = new TestCoordinator({ budgetPerWindow: 10 });
      expect(await c.lease("k", 8, T_EXPIRES)).toBe(8);
      const nextExpires = T_EXPIRES + 60_000;
      expect(await c.lease("k", 8, nextExpires)).toBe(8);
    });

    it("reconcile is idempotent on windowStart (partition-recovery safe)", async () => {
      const c = new TestCoordinator({ budgetPerWindow: 100 });
      await c.lease("k", 50, T_EXPIRES);
      const windowStart = T_EXPIRES - 60_000;
      await c.reconcile("k", 20, windowStart);
      expect(c.remainingFor("k", T_EXPIRES - 1)).toBe(70);
      await c.reconcile("k", 20, windowStart);
      expect(c.remainingFor("k", T_EXPIRES - 1)).toBe(70);
      await c.reconcile("k", 5, windowStart - 60_000);
      expect(c.remainingFor("k", T_EXPIRES - 1)).toBe(75);
    });

    it("reconcile caps at the configured per-key budget (no inflation)", async () => {
      const c = new TestCoordinator({ budgetPerWindow: 100 });
      await c.lease("k", 30, T_EXPIRES);
      await c.reconcile("k", 1000, T_EXPIRES - 60_000);
      expect(c.remainingFor("k", T_EXPIRES - 1)).toBe(100);
    });

    // --- window-coupling guard (windowMs configured): leftover from a ROLLED window is forfeit ---

    it("credits leftover into the still-active window (windowStart === activeStart)", async () => {
      const c = new TestCoordinator({ budgetPerWindow: 100, windowMs: 60_000 });
      await c.lease("k", 50, T_EXPIRES); // active window [T_EXPIRES−60k, T_EXPIRES)
      await c.reconcile("k", 20, T_EXPIRES - 60_000); // its OWN start ⇒ legitimate restore
      expect(c.remainingFor("k", T_EXPIRES - 1)).toBe(70);
      await c.reconcile("k", 20, T_EXPIRES - 60_000); // idempotent on windowStart
      expect(c.remainingFor("k", T_EXPIRES - 1)).toBe(70);
    });

    it("FORFEITS leftover from a rolled window — it cannot exceed one window's budget", async () => {
      // Reproduces the over-admit the federation bound forbids. Window 1 [0,60k): lease the whole budget
      // but only serve part — 40 is left un-served. Window 2 [60k,120k): a fresh budget, drained to 0.
      // A reconcile of window 1's leftover must NOT refill window 2 (that would admit 140 in a 100 window).
      const c = new TestCoordinator({ budgetPerWindow: 100, windowMs: 60_000 });
      expect(await c.lease("k", 100, 60_000)).toBe(100); // window 1 fully leased (40 of it goes un-served)
      expect(await c.lease("k", 100, 120_000)).toBe(100); // window 2 fresh budget, fully drained
      await c.reconcile("k", 40, 0); // window 1's leftover — its window has ROLLED
      // Pre-fix: window 2 budget refilled to 40 ⇒ 40 extra admissions ⇒ 140 total (over-admit).
      expect(c.remainingFor("k", 60_001)).toBe(0); // forfeit: window 2 stays capped at its 100
      expect(await c.lease("k", 1000, 120_000)).toBe(0); // no carried-over budget to grant
    });

    it("per-key budget overrides the default", async () => {
      const c = new TestCoordinator({ budgetPerWindow: 100 });
      c.setBudget("vip", 1000);
      c.setBudget("free", 10);
      expect(await c.lease("vip", 500, T_EXPIRES)).toBe(500);
      expect(await c.lease("free", 500, T_EXPIRES)).toBe(10);
      expect(await c.lease("default", 500, T_EXPIRES)).toBe(100);
    });

    it("setHealthy(false) makes lease() + reconcile() throw StoreUnavailableError", async () => {
      const c = new TestCoordinator({ budgetPerWindow: 100 });
      c.setHealthy(false);
      await expect(c.lease("k", 1, T_EXPIRES)).rejects.toBeInstanceOf(StoreUnavailableError);
      await expect(c.reconcile("k", 1, T_EXPIRES - 1)).rejects.toBeInstanceOf(
        StoreUnavailableError,
      );
      expect(await c.isHealthy()).toBe(false);
      c.setHealthy(true);
      expect(await c.lease("k", 1, T_EXPIRES)).toBe(1);
    });

    it("rejects malformed inputs loudly", async () => {
      const c = new TestCoordinator();
      await expect(c.lease("k", -1, T_EXPIRES)).rejects.toBeInstanceOf(RangeError);
      await expect(c.lease("k", Number.NaN, T_EXPIRES)).rejects.toBeInstanceOf(RangeError);
      await expect(c.reconcile("k", -1, T_EXPIRES - 1)).rejects.toBeInstanceOf(RangeError);
    });

    it("satisfies the GlobalCoordinator interface (structural type-check)", () => {
      const fn = (g: GlobalCoordinator): GlobalCoordinator => g;
      expect(fn(new TestCoordinator())).toBeInstanceOf(TestCoordinator);
    });
  });
});
