/**
 * TK-902 skeleton tests — verify the public federation surface compiles,
 * the FederatedStore correctly signals "not implemented yet" on apply()
 * (so callers know the gate), and the in-memory TestCoordinator's actual
 * behavior matches the design contract (DESIGN.md §3.1).
 *
 * TestCoordinator IS implemented at this commit (it's the test backbone for
 * TK-903+) so its tests are thorough; FederatedStore is only the surface
 * shape, so its tests are surface-only. The real behavior tests for
 * FederatedStore land in TK-903 (static-partition) and TK-904 (federated
 * window-coupled leasing).
 */

import { describe, expect, it } from "vitest";

import { NotImplementedError, StoreUnavailableError } from "../../src/core/errors";
import type { Store, Transform } from "../../src/core/types";
import { FederatedStore, type GlobalCoordinator, TestCoordinator } from "../../src/federation";
import { MemoryStore } from "../../src/stores/memory";

const noopTransform = <S>(_state: S | undefined): never => {
  throw new Error("noop transform should not have been invoked at this commit");
};

describe("federation/skeleton (TK-902)", () => {
  describe("FederatedStore — public surface", () => {
    it("constructs with required options + sensible defaults", () => {
      const fed = new FederatedStore({
        regional: new MemoryStore({ sweepIntervalMs: 0 }),
        coordinator: new TestCoordinator({ budgetPerWindow: 100 }),
        region: "us-east",
      });
      expect(fed.region).toBe("us-east");
      expect(fed.batch).toBe(16); // default
      expect(fed.onCoordinatorOutage).toBe("fail-closed"); // safe default
    });

    it("honors explicit batch + outage mode", () => {
      const fed = new FederatedStore({
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

    it("apply() throws NotImplementedError (TK-903/904 land the behavior)", () => {
      const fed = new FederatedStore({
        regional: new MemoryStore({ sweepIntervalMs: 0 }),
        coordinator: new TestCoordinator(),
        region: "us-east",
      });
      // FederatedStore.apply is the only path that throws — caught synchronously
      // because the throw happens before any await/Promise creation.
      expect(() => fed.apply("k", noopTransform as Transform<unknown, unknown>)).toThrow(
        NotImplementedError,
      );
      expect(() => fed.apply("k", noopTransform as Transform<unknown, unknown>)).toThrow(/TK-903/);
    });

    it("reset() delegates to the regional store", async () => {
      let resetKey: string | undefined;
      const spyRegional: Store = {
        apply: async () => {
          throw new Error("unused");
        },
        reset: async (key: string) => {
          resetKey = key;
        },
      };
      const fed = new FederatedStore({
        regional: spyRegional,
        coordinator: new TestCoordinator(),
        region: "us-east",
      });
      await fed.reset("user:42");
      expect(resetKey).toBe("user:42");
    });

    it("close() is a no-op (no owned resources at this commit)", async () => {
      const fed = new FederatedStore({
        regional: new MemoryStore({ sweepIntervalMs: 0 }),
        coordinator: new TestCoordinator(),
        region: "us-east",
      });
      await expect(fed.close()).resolves.toBeUndefined();
    });

    it("recommendedBatch() falls back to the static batch when no sizer / invalid sizer output", () => {
      const fed = new FederatedStore({
        regional: new MemoryStore({ sweepIntervalMs: 0 }),
        coordinator: new TestCoordinator(),
        region: "us-east",
        batch: 24,
      });
      expect(fed.recommendedBatch()).toBe(24);

      const fedWithBadSizer = new FederatedStore({
        regional: new MemoryStore({ sweepIntervalMs: 0 }),
        coordinator: new TestCoordinator(),
        region: "us-east",
        batch: 12,
        sizer: { recommend: () => Number.NaN },
      });
      expect(fedWithBadSizer.recommendedBatch()).toBe(12);

      const fedWithGoodSizer = new FederatedStore({
        regional: new MemoryStore({ sweepIntervalMs: 0 }),
        coordinator: new TestCoordinator(),
        region: "us-east",
        batch: 12,
        sizer: { recommend: () => 7.9 },
      });
      // Floors the sizer output — leases must be whole tokens.
      expect(fedWithGoodSizer.recommendedBatch()).toBe(7);
    });

    it("exposes the underlying regional store + coordinator for introspection", () => {
      const regional = new MemoryStore({ sweepIntervalMs: 0 });
      const coordinator = new TestCoordinator({ budgetPerWindow: 50 });
      const fed = new FederatedStore({ regional, coordinator, region: "ap-south" });
      expect(fed.regional).toBe(regional);
      expect(fed.coordinator).toBe(coordinator);
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
      // Next window: fresh budget, leftover from prior window forfeit (the
      // window-coupling commitment — formalised in spec/GaleFederatedLeasing.tla).
      const nextExpires = T_EXPIRES + 60_000;
      expect(await c.lease("k", 8, nextExpires)).toBe(8);
    });

    it("reconcile is idempotent on windowStart (partition-recovery safe)", async () => {
      const c = new TestCoordinator({ budgetPerWindow: 100 });
      await c.lease("k", 50, T_EXPIRES); // 50 remaining
      const windowStart = T_EXPIRES - 60_000;
      await c.reconcile("k", 20, windowStart); // 70 remaining
      expect(c.remainingFor("k", T_EXPIRES - 1)).toBe(70);
      // Duplicate reconcile for the SAME windowStart MUST be a no-op.
      await c.reconcile("k", 20, windowStart);
      expect(c.remainingFor("k", T_EXPIRES - 1)).toBe(70);
      // A DIFFERENT windowStart (i.e. a true second reconciliation event)
      // counts independently.
      await c.reconcile("k", 5, windowStart - 60_000);
      expect(c.remainingFor("k", T_EXPIRES - 1)).toBe(75);
    });

    it("reconcile caps at the configured per-key budget (no inflation)", async () => {
      const c = new TestCoordinator({ budgetPerWindow: 100 });
      await c.lease("k", 30, T_EXPIRES); // 70 remaining
      await c.reconcile("k", 1000, T_EXPIRES - 60_000);
      // Reconciliation must never inflate beyond budgetPerWindow.
      expect(c.remainingFor("k", T_EXPIRES - 1)).toBe(100);
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
      // Compile-time assertion: TestCoordinator IS a GlobalCoordinator.
      const fn = (g: GlobalCoordinator): GlobalCoordinator => g;
      expect(fn(new TestCoordinator())).toBeInstanceOf(TestCoordinator);
    });
  });
});
