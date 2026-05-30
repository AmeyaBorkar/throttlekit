/**
 * TK-906 — RedisCoordinator behavior + end-to-end federation against a real
 * Redis. Gated on `THROTTLEKIT_TEST_REDIS` (set to e.g.
 * `redis://localhost:6380`); the rest of `npm run check` runs even without
 * a Redis available.
 *
 * Mirrors the TestCoordinator semantics from skeleton.test.ts and the
 * federate() behavior from window-coupled.test.ts, run against the
 * production Lua-backed coordinator. The bit-identical decisions across
 * the two coordinator implementations is the dual-path JS↔Lua federation
 * conformance.
 */

import { createClient } from "redis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { fixedWindow } from "../../src/algorithms/fixed-window";
import { ManualClock } from "../../src/core/clock";
import { RedisCoordinator, TestCoordinator, federate } from "../../src/federation";
import { fromNodeRedis } from "../../src/redis/clients";

const url = process.env.THROTTLEKIT_TEST_REDIS;
const d = url ? describe : describe.skip;

/**
 * Block until the start of a fresh window when the current one is about to roll. The RedisCoordinator
 * derives its window from real server time, so a multi-request e2e body that straddles a boundary sees
 * the per-window budget refresh mid-run — over-admitting against the ≤-budget assertion. Waiting for a
 * clean boundary gives the body a full `windowMs` of headroom, so the test is deterministic no matter
 * how busy/slow the run is. (Fixes a pre-existing release-gate flake that only surfaces under load.)
 */
async function alignToFreshWindow(
  c: ReturnType<typeof createClient>,
  windowMs: number,
): Promise<void> {
  const reply = (await c.sendCommand(["TIME"])) as unknown as [string | Buffer, string | Buffer];
  const serverMs =
    Number(reply[0].toString()) * 1000 + Math.floor(Number(reply[1].toString()) / 1000);
  const msToBoundary = windowMs - (serverMs % windowMs);
  // The e2e bodies complete in a few seconds even under load; only wait when the window is closer.
  if (msToBoundary < 10_000)
    await new Promise((resolve) => setTimeout(resolve, msToBoundary + 100));
}

d("RedisCoordinator + federate (TK-906)", () => {
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    client = createClient({ url: url as string, database: 8 });
    await client.connect();
    await client.flushDb();
  });

  afterAll(async () => {
    if (client?.isOpen) {
      await client.flushDb();
      await client.quit();
    }
  });

  afterEach(async () => {
    await client.flushDb();
  });

  describe("lease() / reconcile() — atomic Lua semantics", () => {
    it("lease grants up to the per-key budget; partial under contention", async () => {
      const c = new RedisCoordinator({
        client: fromNodeRedis(client),
        windowMs: 60_000,
        budgetPerWindow: 100,
        prefix: "test1",
      });
      // expiresAt is unused by the Lua (it derives from windowMs); pass any value.
      const expiresAt = Date.now() + 60_000;
      expect(await c.lease("k", 30, expiresAt)).toBe(30);
      expect(await c.lease("k", 30, expiresAt)).toBe(30);
      expect(await c.lease("k", 50, expiresAt)).toBe(40); // partial — only 40 left
      expect(await c.lease("k", 10, expiresAt)).toBe(0); // exhausted
    });

    it("per-key budget overrides the default", async () => {
      const c = new RedisCoordinator({
        client: fromNodeRedis(client),
        windowMs: 60_000,
        budgetPerWindow: 100,
        prefix: "test2",
      });
      c.setBudget("vip", 1000);
      c.setBudget("free", 5);
      const expiresAt = Date.now() + 60_000;
      expect(await c.lease("vip", 500, expiresAt)).toBe(500);
      expect(await c.lease("free", 50, expiresAt)).toBe(5);
      expect(await c.lease("default", 50, expiresAt)).toBe(50);
    });

    it("reconcile is idempotent on windowStart", async () => {
      const c = new RedisCoordinator({
        client: fromNodeRedis(client),
        windowMs: 60_000,
        budgetPerWindow: 100,
        prefix: "test3",
      });
      const expiresAt = Date.now() + 60_000;
      await c.lease("k", 50, expiresAt); // budget=50
      const windowStart = Date.now() - 60_000;
      await c.reconcile("k", 20, windowStart); // budget=70
      // Re-reconcile same windowStart MUST be a no-op (the partition-recovery contract).
      await c.reconcile("k", 20, windowStart);
      // Verify by checking how much we can lease.
      expect(await c.lease("k", 100, expiresAt)).toBe(70); // 70 remaining, not 90
    });

    it("reconcile caps at the per-key budget (no inflation)", async () => {
      const c = new RedisCoordinator({
        client: fromNodeRedis(client),
        windowMs: 60_000,
        budgetPerWindow: 100,
        prefix: "test4",
      });
      const expiresAt = Date.now() + 60_000;
      await c.lease("k", 30, expiresAt); // budget=70
      await c.reconcile("k", 1000, Date.now() - 60_000);
      // Capped at perKeyBudget=100. Can lease 100, not 1070.
      expect(await c.lease("k", 200, expiresAt)).toBe(100);
    });

    it("isHealthy returns true against a live Redis", async () => {
      const c = new RedisCoordinator({
        client: fromNodeRedis(client),
        windowMs: 60_000,
        budgetPerWindow: 100,
        prefix: "test5",
      });
      expect(await c.isHealthy()).toBe(true);
    });

    it("rejects malformed inputs", async () => {
      const c = new RedisCoordinator({
        client: fromNodeRedis(client),
        windowMs: 60_000,
        prefix: "test6",
      });
      const expiresAt = Date.now() + 60_000;
      await expect(c.lease("k", -1, expiresAt)).rejects.toBeInstanceOf(RangeError);
      await expect(c.lease("k", Number.NaN, expiresAt)).rejects.toBeInstanceOf(RangeError);
      await expect(c.reconcile("k", -1, Date.now())).rejects.toBeInstanceOf(RangeError);
    });

    it("validates required constructor options", () => {
      expect(
        () =>
          new RedisCoordinator({
            client: fromNodeRedis(client),
            // biome-ignore lint/suspicious/noExplicitAny: deliberate undefined for runtime guard test
            windowMs: undefined as any,
          }),
      ).toThrow(RangeError);
      expect(
        () =>
          new RedisCoordinator({
            client: fromNodeRedis(client),
            windowMs: 60_000,
            budgetPerWindow: -1,
          }),
      ).toThrow(RangeError);
    });
  });

  describe("dual-path: RedisCoordinator produces same Decisions as TestCoordinator", () => {
    it("federation Δ = 0 across K=3 regions matches TestCoordinator results", async () => {
      // Run the SAME workload twice, once against TestCoordinator, once
      // against RedisCoordinator. The total-admitted numbers and the
      // per-region admit pattern should match (modulo Redis's PEXPIRE
      // timing; we use a long window to avoid that).
      const L = 600;
      const windowMs = 60_000;
      const batch = 16;
      const regions = ["us-east", "eu-west", "ap-south"] as const;

      // --- TestCoordinator run ---
      const testClock = new ManualClock(1000);
      const testCoord = new TestCoordinator({ budgetPerWindow: L });
      const testLimiters = regions.map((region) =>
        federate({
          strategy: fixedWindow({ limit: L, windowMs }),
          coordinator: testCoord,
          region,
          batch,
          clock: testClock,
        }),
      );
      let testAdmitted = 0;
      // Adversarial: hot us-east, balanced others.
      for (let i = 0; i < 400; i++) {
        if ((await testLimiters[0]!.check("k")).allowed) testAdmitted++;
      }
      for (let i = 0; i < 200; i++) {
        if ((await testLimiters[1]!.check("k")).allowed) testAdmitted++;
        if ((await testLimiters[2]!.check("k")).allowed) testAdmitted++;
      }
      expect(testAdmitted).toBeLessThanOrEqual(L); // Δ = 0
      expect(testAdmitted).toBeGreaterThan(L - regions.length * batch); // bounded loss

      // --- RedisCoordinator run ---
      const redisCoord = new RedisCoordinator({
        client: fromNodeRedis(client),
        windowMs,
        budgetPerWindow: L,
        prefix: "test-dual",
        useServerTime: true,
      });
      // Use a real clock; the window is 60s so no boundary will roll during this test.
      const redisLimiters = regions.map((region) =>
        federate({
          strategy: fixedWindow({ limit: L, windowMs }),
          coordinator: redisCoord,
          region,
          batch,
        }),
      );
      await alignToFreshWindow(client, windowMs); // run entirely within one real-time window
      let redisAdmitted = 0;
      for (let i = 0; i < 400; i++) {
        if ((await redisLimiters[0]!.check("k")).allowed) redisAdmitted++;
      }
      for (let i = 0; i < 200; i++) {
        if ((await redisLimiters[1]!.check("k")).allowed) redisAdmitted++;
        if ((await redisLimiters[2]!.check("k")).allowed) redisAdmitted++;
      }
      expect(redisAdmitted).toBeLessThanOrEqual(L);
      expect(redisAdmitted).toBeGreaterThan(L - regions.length * batch);

      // The TWO admit totals should be CLOSE — both bounded by L, both
      // recovering most of L. They needn't be byte-identical (the engine's
      // per-coordinator state is in-memory; Redis adds RTT non-determinism)
      // but the headline Δ = 0 holds for both.
      const gap = Math.abs(testAdmitted - redisAdmitted);
      expect(gap).toBeLessThanOrEqual(regions.length * batch);
    });
  });

  describe("end-to-end: K=3 federation against real Redis", () => {
    it("Δ = 0 — total admissions across regions ≤ global budget per window", async () => {
      const coordinator = new RedisCoordinator({
        client: fromNodeRedis(client),
        windowMs: 60_000,
        budgetPerWindow: 500,
        prefix: "test-e2e",
      });
      const regions = ["us-east", "eu-west", "ap-south"];
      const limiters = regions.map((region) =>
        federate({
          strategy: fixedWindow({ limit: 500, windowMs: 60_000 }),
          coordinator,
          region,
          batch: 16,
        }),
      );

      await alignToFreshWindow(client, 60_000); // run entirely within one real-time window
      // Drive ~1000 reqs total (way past the budget).
      let total = 0;
      for (let i = 0; i < 350; i++) {
        for (const l of limiters) {
          const d = await l.check("k");
          if (d.allowed) total++;
        }
      }
      expect(total).toBeLessThanOrEqual(500); // Δ = 0
      expect(total).toBeGreaterThan(500 - regions.length * 16); // bounded loss
    });
  });
});
