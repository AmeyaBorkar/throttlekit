/**
 * TK-1306 — `RedisRegionalEscrow` behavior against a real regional Redis.
 * Gated on `THROTTLEKIT_TEST_REDIS` (set to e.g. `redis://localhost:6380`;
 * see `memory/local-test-redis.md`); the rest of `npm run check` runs even
 * without a Redis available.
 *
 * The atomic-Lua contract is verified against the same `RegionalEscrow`
 * surface that `TestRegionalEscrow` honors — the parity is the L2 dual-path
 * conformance (RedisRegionalEscrow ≡ TestRegionalEscrow). Bit-identical-up-to-
 * server-time-anchoring under deterministic workloads.
 */

import { createClient } from "redis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { RedisRegionalEscrow } from "../../src/federation";
import { fromNodeRedis } from "../../src/redis/clients";

const url = process.env.THROTTLEKIT_TEST_REDIS;
const d = url ? describe : describe.skip;

d("RedisRegionalEscrow (TK-1306)", () => {
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    // DB 10 (the next free slot after redis-coordinator @ 8 and property @ 9).
    client = createClient({ url: url as string, database: 10 });
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

  const make = (opts?: Partial<{ region: string; prefix: string; windowMs: number }>) =>
    new RedisRegionalEscrow({
      client: fromNodeRedis(client),
      windowMs: opts?.windowMs ?? 60_000,
      region: opts?.region ?? "us-east",
      prefix: opts?.prefix ?? "test",
    });

  describe("lease() / refill() / release() — atomic Lua semantics", () => {
    it("lease returns 0 on a fresh key (no entry)", async () => {
      const l2 = make({ prefix: "lease0" });
      expect(await l2.lease("k", 10)).toBe(0);
    });

    it("refill initializes a fresh entry; subsequent lease consumes from it", async () => {
      const l2 = make({ prefix: "refillinit" });
      // Use server-time aligned windowStart: align to the current Redis window.
      const ws = Math.floor(Date.now() / 60_000) * 60_000;
      expect(await l2.refill("k", 25, ws)).toBe(true);
      expect(await l2.lease("k", 10)).toBe(10);
      expect(await l2.lease("k", 20)).toBe(15); // partial
      expect(await l2.lease("k", 1)).toBe(0); // exhausted
    });

    it("refill is additive within the same window", async () => {
      const l2 = make({ prefix: "refilladd" });
      const ws = Math.floor(Date.now() / 60_000) * 60_000;
      await l2.refill("k", 10, ws);
      await l2.refill("k", 15, ws);
      expect(await l2.lease("k", 100)).toBe(25); // both refills accumulated
    });

    it("refill drops grants for already-expired windows (window-coupling)", async () => {
      const l2 = make({ prefix: "refillstale" });
      // sourceWindowStart far in the past; expires_at = ws + 60_000 < now.
      const staleWs = Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000;
      expect(await l2.refill("k", 10, staleWs)).toBe(false);
      expect(await l2.lease("k", 100)).toBe(0); // nothing was refilled
    });

    it("refill zero grant is a true no-op", async () => {
      const l2 = make({ prefix: "refill0" });
      const ws = Math.floor(Date.now() / 60_000) * 60_000;
      await l2.refill("k", 20, ws);
      expect(await l2.refill("k", 0, ws)).toBe(true);
      expect(await l2.lease("k", 100)).toBe(20); // unchanged
    });

    it("release captures-and-zeroes; second release for same window returns 0", async () => {
      const l2 = make({ prefix: "rel1" });
      const ws = Math.floor(Date.now() / 60_000) * 60_000;
      await l2.refill("k", 30, ws);
      await l2.lease("k", 10);
      expect(await l2.release("k", ws)).toBe(20);
      expect(await l2.release("k", ws)).toBe(0); // idempotency
      expect(await l2.lease("k", 100)).toBe(0); // balance zeroed
    });

    it("release for a mismatched sourceWindowStart returns 0 (no-op)", async () => {
      const l2 = make({ prefix: "rel2" });
      const ws = Math.floor(Date.now() / 60_000) * 60_000;
      await l2.refill("k", 30, ws);
      // Release for a different window — no-op.
      expect(await l2.release("k", ws - 60_000)).toBe(0);
      // The actual window's balance is untouched.
      expect(await l2.lease("k", 100)).toBe(30);
    });

    it("isHealthy returns true against a live Redis", async () => {
      const l2 = make({ prefix: "health" });
      expect(await l2.isHealthy()).toBe(true);
    });

    it("rejects malformed inputs", async () => {
      const l2 = make({ prefix: "malf" });
      await expect(l2.lease("k", -1)).rejects.toBeInstanceOf(RangeError);
      await expect(l2.lease("k", Number.NaN)).rejects.toBeInstanceOf(RangeError);
      await expect(l2.refill("k", -1, 0)).rejects.toBeInstanceOf(RangeError);
      await expect(l2.refill("k", 5, -1)).rejects.toBeInstanceOf(RangeError);
      await expect(l2.release("k", -1)).rejects.toBeInstanceOf(RangeError);
    });

    it("validates required constructor options", () => {
      expect(
        () =>
          new RedisRegionalEscrow({
            client: fromNodeRedis(client),
            // biome-ignore lint/suspicious/noExplicitAny: deliberate undefined for runtime guard test
            windowMs: undefined as any,
            region: "us-east",
          }),
      ).toThrow(RangeError);
      expect(
        () =>
          new RedisRegionalEscrow({
            client: fromNodeRedis(client),
            windowMs: 60_000,
            region: "",
          }),
      ).toThrow(RangeError);
    });
  });

  describe("multi-process atomicity — Lua scripts serialize concurrent ops", () => {
    it("M=8 concurrent leases against shared balance never exceed the refilled amount", async () => {
      const l2 = make({ prefix: "concurrent" });
      const ws = Math.floor(Date.now() / 60_000) * 60_000;
      await l2.refill("k", 100, ws);

      // 20 concurrent leases of 8 tokens each (≥ refilled amount; some must partial).
      const results = await Promise.all(Array.from({ length: 20 }, () => l2.lease("k", 8)));
      const total = results.reduce((a, b) => a + b, 0);
      expect(total).toBe(100); // exactly the refilled balance — no overshoot, no loss
      // Subsequent lease finds balance = 0.
      expect(await l2.lease("k", 1)).toBe(0);
    });

    it("release race: only one of M concurrent releasers gets the non-zero balance", async () => {
      const l2 = make({ prefix: "relrace" });
      const ws = Math.floor(Date.now() / 60_000) * 60_000;
      await l2.refill("k", 75, ws);

      const results = await Promise.all([
        l2.release("k", ws),
        l2.release("k", ws),
        l2.release("k", ws),
        l2.release("k", ws),
      ]);
      const sum = results.reduce((a, b) => a + b, 0);
      expect(sum).toBe(75); // exactly captured once
      const nonZero = results.filter((x) => x > 0);
      expect(nonZero).toHaveLength(1); // only one releaser
      expect(nonZero[0]).toBe(75);
    });
  });

  describe("region key isolation — two regions on the same Redis don't collide", () => {
    it("same prefix, different regions: independent balances", async () => {
      const east = new RedisRegionalEscrow({
        client: fromNodeRedis(client),
        windowMs: 60_000,
        region: "us-east",
        prefix: "regiso",
      });
      const west = new RedisRegionalEscrow({
        client: fromNodeRedis(client),
        windowMs: 60_000,
        region: "us-west",
        prefix: "regiso",
      });
      const ws = Math.floor(Date.now() / 60_000) * 60_000;
      await east.refill("k", 10, ws);
      await west.refill("k", 50, ws);
      expect(await east.lease("k", 100)).toBe(10); // east's
      expect(await west.lease("k", 100)).toBe(50); // west's — untouched by east
    });
  });
});
