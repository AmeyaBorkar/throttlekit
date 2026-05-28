/**
 * TK-1302 — `PostgresCoordinator` behavior + drop-in parity vs
 * `RedisCoordinator`. Gated on `THROTTLEKIT_TEST_POSTGRES` (e.g.
 * `postgres://user:pass@localhost:5433/db`); the rest of `npm run check`
 * runs even without a Postgres available.
 *
 * Mirrors `test/federation/redis-coordinator.test.ts` 1:1 — the same
 * lease/reconcile semantics, the same idempotency contract, the same
 * per-key budget overrides. The bit-identical decisions across the two
 * coordinator implementations is the dual-path conformance for federation
 * (`RedisCoordinator ≡ PostgresCoordinator`).
 */

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PostgresCoordinator } from "../../src/federation";

const url = process.env.THROTTLEKIT_TEST_POSTGRES;
const d = url ? describe : describe.skip;

/** Per-file unique table so parallel test files don't collide. */
const TABLE = `tk_fed_state_t_${Math.random().toString(36).slice(2, 8)}`;

d("PostgresCoordinator (TK-1302)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url as string, max: 10 });
    // Drop any leftover from a prior aborted run.
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await pool.end();
  });

  afterEach(async () => {
    // Truncate between tests. The table may not exist on the first run;
    // ON CONFLICT-style CREATE in the coordinator creates it lazily.
    await pool.query(`TRUNCATE TABLE ${TABLE}`).catch(() => {
      // table not yet created in this test — fine.
    });
  });

  const make = (opts?: Partial<{ budget: number; prefix: string; windowMs: number }>) =>
    new PostgresCoordinator({
      pool,
      windowMs: opts?.windowMs ?? 60_000,
      budgetPerWindow: opts?.budget ?? 100,
      tableName: TABLE,
      prefix: opts?.prefix ?? "test",
      gcIntervalMs: 0, // disable GC noise in tests
    });

  describe("lease() / reconcile() — atomic single-row transaction semantics", () => {
    it("lease grants up to the per-key budget; partial under contention", async () => {
      const c = make({ budget: 100, prefix: "lease1" });
      try {
        // expiresAt is unused by the coordinator (it derives from windowMs); pass any value.
        const expiresAt = Date.now() + 60_000;
        expect(await c.lease("k", 30, expiresAt)).toBe(30);
        expect(await c.lease("k", 30, expiresAt)).toBe(30);
        expect(await c.lease("k", 50, expiresAt)).toBe(40); // partial — only 40 left
        expect(await c.lease("k", 10, expiresAt)).toBe(0); // exhausted
      } finally {
        c.close();
      }
    });

    it("zero tokens returns 0 without touching the row", async () => {
      const c = make({ prefix: "lease0" });
      try {
        const expiresAt = Date.now() + 60_000;
        expect(await c.lease("k", 0, expiresAt)).toBe(0);
      } finally {
        c.close();
      }
    });

    it("per-key budget overrides the default", async () => {
      const c = make({ budget: 100, prefix: "vip" });
      try {
        c.setBudget("vip", 1000);
        c.setBudget("free", 5);
        const expiresAt = Date.now() + 60_000;
        expect(await c.lease("vip", 500, expiresAt)).toBe(500);
        expect(await c.lease("free", 50, expiresAt)).toBe(5);
        expect(await c.lease("default", 50, expiresAt)).toBe(50);
      } finally {
        c.close();
      }
    });

    it("reconcile is idempotent on windowStart", async () => {
      const c = make({ budget: 100, prefix: "recidem" });
      try {
        const expiresAt = Date.now() + 60_000;
        await c.lease("k", 50, expiresAt); // budget = 50
        const windowStart = Date.now() - 60_000;
        await c.reconcile("k", 20, windowStart); // budget = 70
        // Re-reconcile same windowStart MUST be a no-op (the partition-recovery contract).
        await c.reconcile("k", 20, windowStart);
        // Verify by checking how much we can lease.
        expect(await c.lease("k", 100, expiresAt)).toBe(70); // 70 remaining, not 90
      } finally {
        c.close();
      }
    });

    it("reconcile caps at the per-key budget (no inflation)", async () => {
      const c = make({ budget: 100, prefix: "reccap" });
      try {
        const expiresAt = Date.now() + 60_000;
        await c.lease("k", 30, expiresAt); // budget = 70
        await c.reconcile("k", 1000, Date.now() - 60_000);
        // Capped at perKeyBudget=100. Can lease 100, not 1070.
        expect(await c.lease("k", 200, expiresAt)).toBe(100);
      } finally {
        c.close();
      }
    });

    it("reconcile zero leftover is a no-op", async () => {
      const c = make({ budget: 100, prefix: "rec0" });
      try {
        const expiresAt = Date.now() + 60_000;
        await c.lease("k", 50, expiresAt); // budget = 50
        await c.reconcile("k", 0, Date.now() - 60_000); // no-op
        expect(await c.lease("k", 100, expiresAt)).toBe(50); // still 50, not 50+0
      } finally {
        c.close();
      }
    });

    it("isHealthy returns true against a live Postgres", async () => {
      const c = make({ prefix: "health" });
      try {
        expect(await c.isHealthy()).toBe(true);
      } finally {
        c.close();
      }
    });

    it("rejects malformed inputs", async () => {
      const c = make({ prefix: "malf" });
      try {
        const expiresAt = Date.now() + 60_000;
        await expect(c.lease("k", -1, expiresAt)).rejects.toBeInstanceOf(RangeError);
        await expect(c.lease("k", Number.NaN, expiresAt)).rejects.toBeInstanceOf(RangeError);
        await expect(c.reconcile("k", -1, Date.now())).rejects.toBeInstanceOf(RangeError);
      } finally {
        c.close();
      }
    });

    it("validates required constructor options", () => {
      expect(
        () =>
          new PostgresCoordinator({
            pool,
            // biome-ignore lint/suspicious/noExplicitAny: deliberate undefined for runtime guard test
            windowMs: undefined as any,
            tableName: TABLE,
          }),
      ).toThrow(RangeError);
      expect(
        () =>
          new PostgresCoordinator({
            pool,
            windowMs: 60_000,
            budgetPerWindow: -1,
            tableName: TABLE,
          }),
      ).toThrow(RangeError);
      // Table name validation — must be a safe SQL identifier
      expect(
        () =>
          new PostgresCoordinator({
            pool,
            windowMs: 60_000,
            tableName: "bad'; DROP TABLE foo; --",
          }),
      ).toThrow(RangeError);
    });

    it("invalid setBudget rejects", () => {
      const c = make({ prefix: "setbad" });
      try {
        expect(() => c.setBudget("k", -1)).toThrow(RangeError);
        expect(() => c.setBudget("k", Number.NaN)).toThrow(RangeError);
        expect(() => c.setBudget("k", 0)).toThrow(RangeError);
      } finally {
        c.close();
      }
    });

    it("window roll resets the budget (different expiresAt → fresh window)", async () => {
      // Use a SHORT window so the test can observe a real roll without sleeping.
      // windowMs = 200ms; sleep just over 200ms between leases.
      const c = make({ budget: 100, prefix: "roll", windowMs: 200 });
      try {
        const expiresAt = Date.now() + 200;
        await c.lease("k", 100, expiresAt); // exhausts window 1
        expect(await c.lease("k", 10, expiresAt)).toBe(0); // still in window 1; denied
        // Wait for window 2.
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        // Window has rolled — budget back to 100.
        expect(await c.lease("k", 50, Date.now() + 200)).toBe(50);
      } finally {
        c.close();
      }
    });

    it("close() is idempotent", () => {
      const c = make({ prefix: "close" });
      c.close();
      c.close();
      c.close(); // does not throw
    });
  });
});
