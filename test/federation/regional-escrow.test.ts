/**
 * TK-1306 — `RegionalEscrow` contract tests against the deterministic
 * `TestRegionalEscrow`. The atomic-Lua parity against a real Redis is in
 * `redis-regional-escrow.test.ts` (gated on `THROTTLEKIT_TEST_REDIS`).
 *
 * These tests pin the L2 contract documented in `research/regional-escrow/
 * DESIGN.md`:
 * - LEASE returns 0 for fresh / empty / expired windows; granted ≤ balance
 * - REFILL is additive within a window; replaces on window mismatch; drops
 *   refills for already-expired windows (window-coupling)
 * - RELEASE captures-and-zeroes; idempotent on `(key, sourceWindowStart)`
 * - All operations propagate `StoreUnavailableError` when partitioned
 */

import { describe, expect, it } from "vitest";

import { ManualClock } from "../../src/core/clock";
import { StoreUnavailableError } from "../../src/core/errors";
import { TestRegionalEscrow } from "../../src/federation";

describe("TestRegionalEscrow (TK-1306)", () => {
  const windowMs = 1000;

  describe("lease() — consume from L2 balance", () => {
    it("returns 0 on a fresh key (no entry yet)", async () => {
      const l2 = new TestRegionalEscrow({ windowMs, clock: new ManualClock(0) });
      expect(await l2.lease("k", 10)).toBe(0);
    });

    it("returns 0 when tokens = 0 without touching balance", async () => {
      const clock = new ManualClock(0);
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      await l2.refill("k", 20, 0);
      expect(await l2.lease("k", 0)).toBe(0);
      expect(l2.balanceFor("k")).toBe(20); // untouched
    });

    it("grants up to balance; partial when tokens > balance", async () => {
      const clock = new ManualClock(0);
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      await l2.refill("k", 10, 0);
      expect(await l2.lease("k", 7)).toBe(7);
      expect(l2.balanceFor("k")).toBe(3);
      expect(await l2.lease("k", 100)).toBe(3); // partial
      expect(l2.balanceFor("k")).toBe(0);
      expect(await l2.lease("k", 1)).toBe(0); // exhausted
    });

    it("returns 0 when the active window has expired (window-coupling)", async () => {
      const clock = new ManualClock(0);
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      await l2.refill("k", 50, 0);
      expect(l2.balanceFor("k")).toBe(50);

      // Advance past the window boundary.
      clock.set(windowMs + 1);
      expect(await l2.lease("k", 10)).toBe(0); // window expired; no grant
      expect(l2.balanceFor("k")).toBe(0); // balanceFor honors expiry too
    });

    it("rejects malformed inputs", async () => {
      const l2 = new TestRegionalEscrow({ windowMs, clock: new ManualClock(0) });
      await expect(l2.lease("k", -1)).rejects.toBeInstanceOf(RangeError);
      await expect(l2.lease("k", Number.NaN)).rejects.toBeInstanceOf(RangeError);
    });

    it("throws StoreUnavailableError when partitioned", async () => {
      const l2 = new TestRegionalEscrow({ windowMs, clock: new ManualClock(0) });
      l2.setHealthy(false);
      await expect(l2.lease("k", 5)).rejects.toBeInstanceOf(StoreUnavailableError);
    });
  });

  describe("refill() — add an L3 grant; idempotent on sourceWindowStart", () => {
    it("initializes a fresh entry", async () => {
      const clock = new ManualClock(0);
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      expect(await l2.refill("k", 25, 0)).toBe(true);
      expect(l2.balanceFor("k")).toBe(25);
    });

    it("is additive within the same window (multi-process refills accumulate)", async () => {
      const clock = new ManualClock(0);
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      await l2.refill("k", 10, 0); // P1 grant
      await l2.refill("k", 15, 0); // P2 grant — same window
      expect(l2.balanceFor("k")).toBe(25); // accumulated
    });

    it("replaces on a different sourceWindowStart (new window starts fresh)", async () => {
      const clock = new ManualClock(0);
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      await l2.refill("k", 10, 0); // window 0
      clock.set(windowMs); // advance to window 1
      await l2.refill("k", 100, windowMs); // window 1 grant — replaces
      expect(l2.balanceFor("k")).toBe(100); // NOT 110
    });

    it("drops refills for already-expired windows (window-coupling)", async () => {
      const clock = new ManualClock(0);
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      // We're at time 0 but trying to refill window starting at -2*windowMs.
      clock.set(2 * windowMs);
      expect(await l2.refill("k", 10, 0)).toBe(false); // stale window — dropped
      expect(l2.balanceFor("k")).toBe(0); // no entry created
    });

    it("zero grant is a no-op (returns true; no entry touched)", async () => {
      const clock = new ManualClock(0);
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      await l2.refill("k", 10, 0);
      expect(await l2.refill("k", 0, 0)).toBe(true);
      expect(l2.balanceFor("k")).toBe(10); // unchanged
    });

    it("rejects malformed inputs", async () => {
      const l2 = new TestRegionalEscrow({ windowMs, clock: new ManualClock(0) });
      await expect(l2.refill("k", -1, 0)).rejects.toBeInstanceOf(RangeError);
      await expect(l2.refill("k", 5, -1)).rejects.toBeInstanceOf(RangeError);
      await expect(l2.refill("k", Number.NaN, 0)).rejects.toBeInstanceOf(RangeError);
    });

    it("throws StoreUnavailableError when partitioned", async () => {
      const l2 = new TestRegionalEscrow({ windowMs, clock: new ManualClock(0) });
      l2.setHealthy(false);
      await expect(l2.refill("k", 5, 0)).rejects.toBeInstanceOf(StoreUnavailableError);
    });
  });

  describe("release() — capture and zero at window roll; idempotent", () => {
    it("returns the balance and clears the entry", async () => {
      const clock = new ManualClock(0);
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      await l2.refill("k", 20, 0);
      await l2.lease("k", 5);
      expect(await l2.release("k", 0)).toBe(15);
      expect(l2.balanceFor("k")).toBe(0);
    });

    it("is idempotent per (key, sourceWindowStart) — second caller gets 0", async () => {
      const clock = new ManualClock(0);
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      await l2.refill("k", 20, 0);
      expect(await l2.release("k", 0)).toBe(20);
      expect(await l2.release("k", 0)).toBe(0); // already released
      expect(await l2.release("k", 0)).toBe(0); // still 0
    });

    it("returns 0 when sourceWindowStart mismatches the L2's source_lease", async () => {
      const clock = new ManualClock(0);
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      await l2.refill("k", 20, 0);
      // Release for a DIFFERENT window — no-op.
      expect(await l2.release("k", windowMs)).toBe(0);
      // The actual window's balance is still there.
      expect(l2.balanceFor("k")).toBe(20);
    });

    it("returns 0 when no entry exists", async () => {
      const l2 = new TestRegionalEscrow({ windowMs, clock: new ManualClock(0) });
      expect(await l2.release("k", 0)).toBe(0);
    });

    it("rejects malformed inputs", async () => {
      const l2 = new TestRegionalEscrow({ windowMs, clock: new ManualClock(0) });
      await expect(l2.release("k", -1)).rejects.toBeInstanceOf(RangeError);
      await expect(l2.release("k", Number.NaN)).rejects.toBeInstanceOf(RangeError);
    });

    it("throws StoreUnavailableError when partitioned", async () => {
      const l2 = new TestRegionalEscrow({ windowMs, clock: new ManualClock(0) });
      l2.setHealthy(false);
      await expect(l2.release("k", 0)).rejects.toBeInstanceOf(StoreUnavailableError);
    });
  });

  describe("isHealthy() — partition detector", () => {
    it("returns true when healthy, false when set unhealthy", async () => {
      const l2 = new TestRegionalEscrow({ windowMs, clock: new ManualClock(0) });
      expect(await l2.isHealthy()).toBe(true);
      l2.setHealthy(false);
      expect(await l2.isHealthy()).toBe(false);
      l2.setHealthy(true);
      expect(await l2.isHealthy()).toBe(true);
    });
  });

  describe("validates constructor options", () => {
    it("rejects non-positive windowMs", () => {
      expect(() => new TestRegionalEscrow({ windowMs: 0 })).toThrow(RangeError);
      expect(() => new TestRegionalEscrow({ windowMs: -1 })).toThrow(RangeError);
      // biome-ignore lint/suspicious/noExplicitAny: deliberate undefined for runtime guard test
      expect(() => new TestRegionalEscrow({ windowMs: undefined as any })).toThrow(RangeError);
    });
  });

  describe("end-to-end: multi-process sharing pattern (without engine)", () => {
    it("two processes' refills accumulate; their leases are atomic against shared balance", async () => {
      // Models the M=2 multi-process pattern without involving the engine:
      // P1 and P2 each refill L2 with their coordinator grants; the L2 balance
      // is the sum; leases against it stay atomic (Δ ≤ total grants).
      const clock = new ManualClock(0);
      const l2 = new TestRegionalEscrow({ windowMs, clock });

      // P1's coord grant (16) lands; P2's coord grant (16) lands.
      await l2.refill("k", 16, 0);
      await l2.refill("k", 16, 0);
      expect(l2.balanceFor("k")).toBe(32);

      // Each process leases batch=8 from the SHARED L2.
      const p1 = await l2.lease("k", 8);
      const p2 = await l2.lease("k", 8);
      const p1b = await l2.lease("k", 8);
      const p2b = await l2.lease("k", 8);
      const p1c = await l2.lease("k", 8); // exhausted

      const totalLeased = p1 + p2 + p1b + p2b + p1c;
      expect(totalLeased).toBe(32); // matches refill sum (no overshoot)
      expect(p1c).toBe(0); // L2 depleted; further leases stall
      expect(l2.balanceFor("k")).toBe(0);
    });

    it("release-race: only one of M concurrent releasers gets non-zero", async () => {
      const clock = new ManualClock(0);
      const l2 = new TestRegionalEscrow({ windowMs, clock });
      await l2.refill("k", 50, 0);

      // Three processes all try to release the same window concurrently.
      const [r1, r2, r3] = await Promise.all([
        l2.release("k", 0),
        l2.release("k", 0),
        l2.release("k", 0),
      ]);
      // Exactly one gets the leftover; the others get 0.
      const sum = r1 + r2 + r3;
      expect(sum).toBe(50);
      const nonZero = [r1, r2, r3].filter((x) => x > 0);
      expect(nonZero).toHaveLength(1);
      expect(nonZero[0]).toBe(50);
    });
  });
});
