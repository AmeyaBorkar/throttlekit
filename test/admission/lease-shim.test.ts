/**
 * TK-1003 — Lease ↔ Decision shim tests.
 *
 * Spec source: `research/bigger-bets/unified/DESIGN.md` §5 (D-U7).
 *
 * The shim wraps `adaptiveConcurrency()`'s `ConcurrencyGuard` into the
 * Decision-shaped admission the unified algebra (TK-1002) operates on,
 * with the release returned separately so the caller can wire it to its
 * own request lifecycle. These tests pin every clause of §5:
 *
 * - accepted-lease Decision shape (allowed, limit, remaining post-consume,
 *   resetAt = now, retryAfterMs = 0)
 * - rejected-lease Decision shape (denied, limit, remaining = 0, resetAt =
 *   now, retryAfterMs = max(1, round(lastRtt || 1)))
 * - release pass-through (admit then release frees a slot)
 * - dropped-request signal flows through to the underlying gradient2/AIMD
 *   limit update (the limit contracts when releases are dropped)
 * - double-release idempotency
 * - integer-only numeric fields on the Decision (bit-identity preservation)
 */

import { describe, expect, it } from "vitest";

import { leaseAsAdmission } from "../../src/admission/lease-shim";
import { adaptiveConcurrency } from "../../src/concurrency/adaptive";
import { ManualClock } from "../../src/core/clock";
import { combineDecisions } from "../../src/core/combine";
import type { Decision } from "../../src/core/types";

describe("leaseAsAdmission — accepted lease decision shape", () => {
  it("admits when slots are free; reports allowed=true and post-consume remaining", () => {
    const clock = new ManualClock(1_000);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const shim = leaseAsAdmission(guard, { clock });

    const { decision, release } = shim.acquire();
    expect(decision.allowed).toBe(true);
    expect(decision.limit).toBe(4);
    // Post-consume: one slot taken, so 3 left of 4.
    expect(decision.remaining).toBe(3);
    expect(decision.resetAt).toBe(1_000); // = clock.now()
    expect(decision.retryAfterMs).toBe(0);

    release();
  });

  it("the post-consume remaining drops as more slots are taken", () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 3, initialLimit: 3, maxLimit: 3 });
    const shim = leaseAsAdmission(guard, { clock });

    const remainings: number[] = [];
    const releases: (() => void)[] = [];
    for (let i = 0; i < 3; i++) {
      const { decision, release } = shim.acquire();
      expect(decision.allowed).toBe(true);
      remainings.push(decision.remaining);
      releases.push(release);
    }
    expect(remainings).toEqual([2, 1, 0]); // 3 → 2 → 1 → 0
    releases.forEach((r) => r());
  });
});

describe("leaseAsAdmission — rejected lease decision shape", () => {
  it("denies once the ceiling is hit; allowed=false, remaining=0, retryAfterMs >= 1", () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 2, initialLimit: 2, maxLimit: 2 });
    const shim = leaseAsAdmission(guard, { clock });

    // Fill to ceiling.
    const a = shim.acquire();
    const b = shim.acquire();
    expect(a.decision.allowed).toBe(true);
    expect(b.decision.allowed).toBe(true);

    // 3rd is rejected.
    const c = shim.acquire();
    expect(c.decision.allowed).toBe(false);
    expect(c.decision.limit).toBe(2);
    expect(c.decision.remaining).toBe(0);
    expect(c.decision.resetAt).toBe(0); // clock.now()
    // No samples yet (no release has happened) → lastRtt = 0 → max(1, round(0||1)) = 1.
    expect(c.decision.retryAfterMs).toBe(1);

    a.release();
    b.release();
  });

  it("retryAfterMs tracks the last observed RTT after a release", () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 2, initialLimit: 2, maxLimit: 2 });
    const shim = leaseAsAdmission(guard, { clock });

    // First cycle: acquire, advance the clock 37 ms, release — records lastRtt = 37.
    const first = shim.acquire();
    clock.advance(37);
    first.release();

    // Re-fill and provoke a denial.
    const a = shim.acquire();
    const b = shim.acquire();
    expect(a.decision.allowed).toBe(true);
    expect(b.decision.allowed).toBe(true);

    const denied = shim.acquire();
    expect(denied.decision.allowed).toBe(false);
    // retryAfterMs reflects the recorded RTT: 37 → round(37) → max(1, 37) = 37.
    expect(denied.decision.retryAfterMs).toBe(37);

    a.release();
    b.release();
  });

  it("retryAfterMs is an integer even when lastRtt would be fractional", () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 1, initialLimit: 1, maxLimit: 1 });
    const shim = leaseAsAdmission(guard, { clock });

    // Drive a fractional RTT into lastRtt via two clock.now() reads with a
    // half-millisecond gap. The shim must round it to a whole integer.
    const first = shim.acquire();
    clock.set(0.5); // half-ms RTT
    first.release();
    expect(guard.stats().lastRtt).toBe(0.5);

    const a = shim.acquire();
    const denied = shim.acquire();
    expect(denied.decision.allowed).toBe(false);
    // round(0.5) = 1 (banker's rounding in JS is round-half-away-from-zero
    // for positives via Math.round); max(1, 1) = 1.
    expect(denied.decision.retryAfterMs).toBe(1);
    expect(Number.isInteger(denied.decision.retryAfterMs)).toBe(true);
    a.release();
  });
});

describe("leaseAsAdmission — release pass-through", () => {
  it("calling release frees the underlying slot", () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 1, initialLimit: 1, maxLimit: 1 });
    const shim = leaseAsAdmission(guard, { clock });

    const first = shim.acquire();
    expect(first.decision.allowed).toBe(true);
    expect(guard.inflight).toBe(1);

    // Second acquire blocked at this point.
    const blocked = shim.acquire();
    expect(blocked.decision.allowed).toBe(false);

    // Release the first; slot is free again.
    first.release();
    expect(guard.inflight).toBe(0);

    const second = shim.acquire();
    expect(second.decision.allowed).toBe(true);
    second.release();
  });

  it("dropped: true contracts the AIMD limit (signal flows through)", () => {
    const clock = new ManualClock(0);
    // Use AIMD so the drop signal is unambiguous: ×0.9 backoff on a drop.
    const guard = adaptiveConcurrency({
      clock,
      algorithm: "aimd",
      minLimit: 4,
      initialLimit: 10,
      maxLimit: 16,
      backoffRatio: 0.5, // dramatic decrease so the test sees it without ambiguity
    });
    const shim = leaseAsAdmission(guard, { clock });

    expect(guard.limit).toBe(10);

    const lease = shim.acquire();
    clock.advance(5);
    lease.release({ dropped: true });

    // AIMD multiplicative decrease on drop: floor(10 × 0.5) = 5.
    expect(guard.limit).toBe(5);
  });

  it("double-release is a no-op (idempotent via the underlying Lease)", () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 1, initialLimit: 1, maxLimit: 1 });
    const shim = leaseAsAdmission(guard, { clock });

    const lease = shim.acquire();
    lease.release();
    expect(guard.inflight).toBe(0);

    // A second release must not push inflight negative or trigger another RTT sample.
    lease.release();
    expect(guard.inflight).toBe(0);
  });

  it("release on a rejected admission is a safe no-op", () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 1, initialLimit: 1, maxLimit: 1 });
    const shim = leaseAsAdmission(guard, { clock });

    const first = shim.acquire();
    const denied = shim.acquire();
    expect(denied.decision.allowed).toBe(false);

    // The rejected admission's release is a no-op (rejected leases hold no slot).
    denied.release();
    expect(guard.inflight).toBe(1); // still holding the first

    first.release();
  });
});

describe("leaseAsAdmission — integer bit-identity invariant", () => {
  it("every numeric field on an accepted Decision is an integer", () => {
    const clock = new ManualClock(123_456);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const shim = leaseAsAdmission(guard, { clock });

    const { decision } = shim.acquire();
    expect(Number.isInteger(decision.limit)).toBe(true);
    expect(Number.isInteger(decision.remaining)).toBe(true);
    expect(Number.isInteger(decision.resetAt)).toBe(true);
    expect(Number.isInteger(decision.retryAfterMs)).toBe(true);
  });

  it("every numeric field on a rejected Decision is an integer", () => {
    const clock = new ManualClock(123_456);
    const guard = adaptiveConcurrency({ clock, minLimit: 1, initialLimit: 1, maxLimit: 1 });
    const shim = leaseAsAdmission(guard, { clock });

    const a = shim.acquire();
    const denied = shim.acquire();
    expect(denied.decision.allowed).toBe(false);
    expect(Number.isInteger(denied.decision.limit)).toBe(true);
    expect(Number.isInteger(denied.decision.remaining)).toBe(true);
    expect(Number.isInteger(denied.decision.resetAt)).toBe(true);
    expect(Number.isInteger(denied.decision.retryAfterMs)).toBe(true);
    a.release();
  });
});

describe("leaseAsAdmission — composes with combineDecisions (forward link to unified)", () => {
  it("an admitted lease + a permissive rate decision combines to allow", () => {
    const clock = new ManualClock(1_000);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const shim = leaseAsAdmission(guard, { clock });

    const { decision: concDecision, release } = shim.acquire();
    const rateDecision: Decision = {
      allowed: true,
      limit: 100,
      remaining: 50,
      resetAt: 60_000,
      retryAfterMs: 0,
    };

    const combined = combineDecisions(concDecision, rateDecision);
    expect(combined.allowed).toBe(true);
    expect(combined.limit).toBe(4); // MIN: concurrency's 4 binds
    expect(combined.remaining).toBe(3); // MIN: concurrency's 3 (post-consume) binds
    expect(combined.resetAt).toBe(60_000); // MAX: rate's resetAt is later
    expect(combined.retryAfterMs).toBe(0);

    release();
  });

  it("a rejected lease combined with an allow yields a denied combined Decision", () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 1, initialLimit: 1, maxLimit: 1 });
    const shim = leaseAsAdmission(guard, { clock });

    const a = shim.acquire();
    const { decision: concDecision } = shim.acquire(); // rejected
    expect(concDecision.allowed).toBe(false);

    const rateDecision: Decision = {
      allowed: true,
      limit: 100,
      remaining: 50,
      resetAt: 60_000,
      retryAfterMs: 0,
    };

    const combined = combineDecisions(concDecision, rateDecision);
    expect(combined.allowed).toBe(false);
    expect(combined.limit).toBe(1); // MIN
    expect(combined.remaining).toBe(0); // MIN — concurrency forced this to 0
    expect(combined.resetAt).toBe(60_000); // MAX — rate dominates the clock-based reset
    expect(combined.retryAfterMs).toBe(1); // MAX — concurrency's 1ms hint (lastRtt = 0 cold start)
    a.release();
  });
});
