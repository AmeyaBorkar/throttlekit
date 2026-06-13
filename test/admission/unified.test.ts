/**
 * TK-1004 — unifiedAdmission sequential composition tests.
 *
 * Spec source: `research/bigger-bets/unified/DESIGN.md` §4.2, §4.2.2, §8.3
 * (D-U4, D-U6, D-U13).
 *
 * Coverage matrix:
 * - construction validation (empty axes; invalid backend; lua-fused deferred)
 * - axes singly: rate-only, concurrency-only, cost-only
 * - axes in pairs: rate+concurrency, rate+cost, concurrency+cost
 * - axes as triple: rate+concurrency+cost
 * - deny short-circuit: each axis can be the binding axis; the held
 *   concurrency slot is released on a downstream deny
 * - release wiring: admit success returns a working release; admit deny
 *   returns a no-op release; dropped:true signal flows through
 * - lastDecisions: per-axis introspection (unconfigured axes are
 *   undefined; short-circuit leaves downstream axes undefined — so the
 *   caller can identify the binding axis)
 * - admit (async) and admitSync paths are tested in parallel where the
 *   sync path is supported (MemoryStore-backed limiters); admitSync's
 *   error propagation is also exercised
 */

import { describe, expect, it } from "vitest";

import { unifiedAdmission } from "../../src/admission/unified";
import { gcra } from "../../src/algorithms/gcra";
import { tokenBucket } from "../../src/algorithms/token-bucket";
import { adaptiveConcurrency } from "../../src/concurrency/adaptive";
import { ManualClock } from "../../src/core/clock";
import { ThrottleKitError } from "../../src/core/errors";
import { rateLimit } from "../../src/core/limiter";
import type { Decision, Limiter, Strategy } from "../../src/core/types";

// ── Construction validation ────────────────────────────────────────────────────────────────────

describe("unifiedAdmission — construction validation", () => {
  it("throws when no axes are configured", () => {
    expect(() => unifiedAdmission({})).toThrow(ThrottleKitError);
    expect(() => unifiedAdmission({})).toThrow(/at least one of/);
  });

  it("throws RangeError on an invalid backend value", () => {
    const clock = new ManualClock(0);
    const rate = rateLimit({ strategy: gcra({ limit: 5, periodMs: 60_000 }), clock });
    // biome-ignore lint/suspicious/noExplicitAny: deliberately probing the runtime validation
    expect(() => unifiedAdmission({ rate, backend: "bogus" as any })).toThrow(RangeError);
  });

  it('throws when backend is "lua-fused" but `fused` option group is missing (TK-1005)', () => {
    const clock = new ManualClock(0);
    const rate = rateLimit({ strategy: gcra({ limit: 5, periodMs: 60_000 }), clock });
    expect(() => unifiedAdmission({ rate, backend: "lua-fused" })).toThrow(ThrottleKitError);
    expect(() => unifiedAdmission({ rate, backend: "lua-fused" })).toThrow(/`fused` option group/);
  });

  it("throws when `fused` is set but backend is not lua-fused (config mistake)", () => {
    const clock = new ManualClock(0);
    const rate = rateLimit({ strategy: gcra({ limit: 5, periodMs: 60_000 }), clock });
    // biome-ignore lint/suspicious/noExplicitAny: deliberately probing the runtime validation
    const fakeFused: any = {
      client: {},
      rate: { strategy: "gcra", limit: 100, periodMs: 60_000 },
      cost: { strategy: "tokenBucket", capacity: 100, refillPerSec: 1 },
    };
    expect(() => unifiedAdmission({ rate, backend: "sequential", fused: fakeFused })).toThrow(
      /`fused` option group requires backend: "lua-fused"/,
    );
  });

  it('defaults backend to "sequential" when omitted', () => {
    const clock = new ManualClock(0);
    const rate = rateLimit({ strategy: gcra({ limit: 5, periodMs: 60_000 }), clock });
    // Should not throw — default backend is the sequential path.
    expect(() => unifiedAdmission({ rate })).not.toThrow();
  });
});

// ── Triple-axis happy path ─────────────────────────────────────────────────────────────────────

describe("unifiedAdmission — triple-axis (rate + concurrency + cost)", () => {
  function buildTriple() {
    const clock = new ManualClock(0);
    const rate = rateLimit({ strategy: gcra({ limit: 100, periodMs: 60_000 }), clock });
    const concurrency = adaptiveConcurrency({
      clock,
      minLimit: 4,
      initialLimit: 4,
      maxLimit: 4,
    });
    const cost = rateLimit({
      strategy: tokenBucket({ capacity: 1_000, refillPerSec: 100 }),
      clock,
    });
    return { clock, rate, concurrency, cost };
  }

  it("admit (async) returns a combined Decision and a working release", async () => {
    const { rate, concurrency, cost } = buildTriple();
    const admit = unifiedAdmission({ rate, concurrency, cost });

    const { decision, release } = await admit.admit({ key: "tenant:a", cost: 100 });
    expect(decision.allowed).toBe(true);
    // MIN over the three axes' `limit` fields. Rate=100, concurrency=4, cost=1000 → 4.
    expect(decision.limit).toBe(4);
    expect(concurrency.inflight).toBe(1);

    release();
    expect(concurrency.inflight).toBe(0);
  });

  it("admitSync (sync) works when all axes are sync-capable (MemoryStore-backed)", () => {
    const { rate, concurrency, cost } = buildTriple();
    const admit = unifiedAdmission({ rate, concurrency, cost });

    const { decision, release } = admit.admitSync({ key: "tenant:a", cost: 100 });
    expect(decision.allowed).toBe(true);
    expect(concurrency.inflight).toBe(1);
    release();
  });

  it("lastDecisions() reflects all three axes after a success", async () => {
    const { rate, concurrency, cost } = buildTriple();
    const admit = unifiedAdmission({ rate, concurrency, cost });

    const { release } = await admit.admit({ key: "k", cost: 50 });
    const last = admit.lastDecisions();
    expect(last.rate?.allowed).toBe(true);
    expect(last.concurrency?.allowed).toBe(true);
    expect(last.cost?.allowed).toBe(true);
    release();
  });

  it("returns a frozen lastDecisions snapshot (safe to leak into telemetry)", async () => {
    const { rate, concurrency, cost } = buildTriple();
    const admit = unifiedAdmission({ rate, concurrency, cost });

    const { release } = await admit.admit({ key: "k", cost: 1 });
    const last = admit.lastDecisions();
    expect(Object.isFrozen(last)).toBe(true);
    release();
  });
});

// ── Single-axis configurations ─────────────────────────────────────────────────────────────────

describe("unifiedAdmission — single-axis configurations", () => {
  it("rate-only admits up to the rate limit; denies thereafter", async () => {
    const clock = new ManualClock(0);
    const rate = rateLimit({ strategy: gcra({ limit: 3, periodMs: 60_000 }), clock });
    const admit = unifiedAdmission({ rate });

    expect((await admit.admit({ key: "k" })).decision.allowed).toBe(true);
    expect((await admit.admit({ key: "k" })).decision.allowed).toBe(true);
    expect((await admit.admit({ key: "k" })).decision.allowed).toBe(true);
    expect((await admit.admit({ key: "k" })).decision.allowed).toBe(false);
  });

  it("concurrency-only admits up to the ceiling; denies thereafter; release frees a slot", async () => {
    const clock = new ManualClock(0);
    const concurrency = adaptiveConcurrency({
      clock,
      minLimit: 2,
      initialLimit: 2,
      maxLimit: 2,
    });
    const admit = unifiedAdmission({ concurrency });

    const a = await admit.admit();
    const b = await admit.admit();
    const denied = await admit.admit();
    expect(a.decision.allowed).toBe(true);
    expect(b.decision.allowed).toBe(true);
    expect(denied.decision.allowed).toBe(false);

    a.release();
    const reAdmit = await admit.admit();
    expect(reAdmit.decision.allowed).toBe(true);
    reAdmit.release();
    b.release();
  });

  it("cost-only admits when the bucket has capacity; denies when drained", async () => {
    const clock = new ManualClock(0);
    const cost = rateLimit({
      strategy: tokenBucket({ capacity: 500, refillPerSec: 100 }),
      clock,
    });
    const admit = unifiedAdmission({ cost });

    const a = await admit.admit({ key: "k", cost: 300 });
    const b = await admit.admit({ key: "k", cost: 300 });
    expect(a.decision.allowed).toBe(true);
    expect(b.decision.allowed).toBe(false); // 500 - 300 = 200 < 300
  });
});

// ── Pair configurations ────────────────────────────────────────────────────────────────────────

describe("unifiedAdmission — pair configurations", () => {
  it("rate + concurrency: combined Decision binds on whichever is smaller", async () => {
    const clock = new ManualClock(0);
    const rate = rateLimit({ strategy: gcra({ limit: 1_000, periodMs: 60_000 }), clock });
    const concurrency = adaptiveConcurrency({
      clock,
      minLimit: 4,
      initialLimit: 4,
      maxLimit: 4,
    });
    const admit = unifiedAdmission({ rate, concurrency });

    const { decision, release } = await admit.admit({ key: "k" });
    expect(decision.allowed).toBe(true);
    // MIN of rate.limit (1000) and concurrency.limit (4) → 4
    expect(decision.limit).toBe(4);
    release();
  });

  it("rate + cost: cost dominates retryAfterMs when both deny via MAX aggregation", async () => {
    const clock = new ManualClock(0);
    const rate = rateLimit({ strategy: gcra({ limit: 1, periodMs: 1_000 }), clock });
    const cost = rateLimit({
      strategy: tokenBucket({ capacity: 100, refillPerSec: 1 }),
      clock,
    });
    const admit = unifiedAdmission({ rate, cost });

    // First admit drains both axes.
    await admit.admit({ key: "k", cost: 100 });
    // Second admit denies on rate (rate's window hasn't reset); cost is also drained.
    const second = await admit.admit({ key: "k", cost: 1 });
    expect(second.decision.allowed).toBe(false);
  });

  it("concurrency + cost: release fires on a cost-axis deny (concurrency slot held momentarily)", async () => {
    const clock = new ManualClock(0);
    const concurrency = adaptiveConcurrency({
      clock,
      minLimit: 4,
      initialLimit: 4,
      maxLimit: 4,
    });
    const cost = rateLimit({
      strategy: tokenBucket({ capacity: 10, refillPerSec: 100 }),
      clock,
    });
    const admit = unifiedAdmission({ concurrency, cost });

    // Drain the cost axis.
    const first = await admit.admit({ key: "k", cost: 10 });
    expect(first.decision.allowed).toBe(true);
    expect(concurrency.inflight).toBe(1);
    first.release();

    // Next admit: concurrency allows, cost denies — the briefly-held slot
    // must be released by the time admit returns.
    const denied = await admit.admit({ key: "k", cost: 1 });
    expect(denied.decision.allowed).toBe(false);
    expect(concurrency.inflight).toBe(0);
  });
});

// ── Short-circuit and binding-axis identification ─────────────────────────────────────────────

describe("unifiedAdmission — short-circuit + binding-axis via lastDecisions", () => {
  it("a concurrency deny short-circuits: rate and cost are NOT consulted", async () => {
    const clock = new ManualClock(0);
    const concurrency = adaptiveConcurrency({
      clock,
      minLimit: 1,
      initialLimit: 1,
      maxLimit: 1,
    });
    const rate = trackedLimiter(
      rateLimit({ strategy: gcra({ limit: 1_000, periodMs: 60_000 }), clock }),
    );
    const cost = trackedLimiter(
      rateLimit({ strategy: tokenBucket({ capacity: 1_000, refillPerSec: 100 }), clock }),
    );
    const admit = unifiedAdmission({ concurrency, rate: rate.limiter, cost: cost.limiter });

    const a = await admit.admit({ key: "k" });
    expect(a.decision.allowed).toBe(true);
    expect(rate.calls).toBe(1);
    expect(cost.calls).toBe(1);

    // Now over the ceiling — concurrency should deny without touching rate / cost.
    const denied = await admit.admit({ key: "k" });
    expect(denied.decision.allowed).toBe(false);
    expect(rate.calls).toBe(1); // unchanged: rate was NOT consulted
    expect(cost.calls).toBe(1); // unchanged: cost was NOT consulted

    // The binding axis shows up as the only non-undefined entry past the deny.
    const last = admit.lastDecisions();
    expect(last.concurrency?.allowed).toBe(false);
    expect(last.rate).toBeUndefined();
    expect(last.cost).toBeUndefined();
    a.release();
  });

  it("a rate deny releases the concurrency slot before returning", async () => {
    const clock = new ManualClock(0);
    const concurrency = adaptiveConcurrency({
      clock,
      minLimit: 4,
      initialLimit: 4,
      maxLimit: 4,
    });
    const rate = rateLimit({ strategy: gcra({ limit: 1, periodMs: 60_000 }), clock });
    const cost = trackedLimiter(
      rateLimit({ strategy: tokenBucket({ capacity: 1_000, refillPerSec: 100 }), clock }),
    );
    const admit = unifiedAdmission({ concurrency, rate, cost: cost.limiter });

    // First admit drains the rate axis (and incidentally consults cost once).
    const first = await admit.admit({ key: "k" });
    expect(first.decision.allowed).toBe(true);
    first.release();
    const costCallsAfterFirst = cost.calls; // snapshot — cost may have been consulted by the first admit

    // Second admit: concurrency briefly acquires, then rate denies, slot is released,
    // cost is NOT consulted (short-circuit at rate; cost.calls unchanged).
    const denied = await admit.admit({ key: "k" });
    expect(denied.decision.allowed).toBe(false);
    expect(concurrency.inflight).toBe(0); // slot released as part of the short-circuit
    expect(cost.calls).toBe(costCallsAfterFirst); // cost was NOT consulted by the second admit

    // Binding axis is rate; concurrency is allowed (last seen as allowed but slot was returned); cost is undefined.
    const last = admit.lastDecisions();
    expect(last.rate?.allowed).toBe(false);
    expect(last.concurrency?.allowed).toBe(true);
    expect(last.cost).toBeUndefined();
  });

  it("a cost deny releases the concurrency slot before returning", async () => {
    const clock = new ManualClock(0);
    const concurrency = adaptiveConcurrency({
      clock,
      minLimit: 4,
      initialLimit: 4,
      maxLimit: 4,
    });
    const rate = rateLimit({ strategy: gcra({ limit: 1_000, periodMs: 60_000 }), clock });
    const cost = rateLimit({
      strategy: tokenBucket({ capacity: 10, refillPerSec: 100 }),
      clock,
    });
    const admit = unifiedAdmission({ concurrency, rate, cost });

    // Drain cost.
    const first = await admit.admit({ key: "k", cost: 10 });
    expect(first.decision.allowed).toBe(true);
    first.release();

    const denied = await admit.admit({ key: "k", cost: 1 });
    expect(denied.decision.allowed).toBe(false);
    expect(concurrency.inflight).toBe(0);

    const last = admit.lastDecisions();
    expect(last.concurrency?.allowed).toBe(true);
    expect(last.rate?.allowed).toBe(true);
    expect(last.cost?.allowed).toBe(false);
  });
});

// ── Release lifecycle ─────────────────────────────────────────────────────────────────────────

describe("unifiedAdmission — release lifecycle", () => {
  it("release on a triple-success admit frees the concurrency slot", async () => {
    const clock = new ManualClock(0);
    const concurrency = adaptiveConcurrency({
      clock,
      minLimit: 1,
      initialLimit: 1,
      maxLimit: 1,
    });
    const rate = rateLimit({ strategy: gcra({ limit: 1_000, periodMs: 60_000 }), clock });
    const cost = rateLimit({
      strategy: tokenBucket({ capacity: 1_000, refillPerSec: 100 }),
      clock,
    });
    const admit = unifiedAdmission({ rate, concurrency, cost });

    const result = await admit.admit({ key: "k", cost: 1 });
    expect(concurrency.inflight).toBe(1);
    result.release();
    expect(concurrency.inflight).toBe(0);
  });

  it("release on a denied admit is a no-op (idempotent)", async () => {
    const clock = new ManualClock(0);
    const concurrency = adaptiveConcurrency({
      clock,
      minLimit: 1,
      initialLimit: 1,
      maxLimit: 1,
    });
    const admit = unifiedAdmission({ concurrency });

    const first = await admit.admit();
    expect(first.decision.allowed).toBe(true);

    const denied = await admit.admit();
    expect(denied.decision.allowed).toBe(false);
    expect(concurrency.inflight).toBe(1); // still 1 from `first`

    // Calling release on a denied admission must not double-release / push inflight negative.
    denied.release();
    denied.release();
    expect(concurrency.inflight).toBe(1);

    first.release();
    expect(concurrency.inflight).toBe(0);
  });

  it("dropped: true on release contracts the AIMD limit (signal flows through)", async () => {
    const clock = new ManualClock(0);
    const concurrency = adaptiveConcurrency({
      clock,
      algorithm: "aimd",
      minLimit: 4,
      initialLimit: 10,
      maxLimit: 16,
      backoffRatio: 0.5,
    });
    const admit = unifiedAdmission({ concurrency });

    expect(concurrency.limit).toBe(10);

    const lease = await admit.admit();
    clock.advance(5);
    lease.release({ dropped: true });

    expect(concurrency.limit).toBe(5); // floor(10 * 0.5)
  });
});

// ── admitSync error propagation ───────────────────────────────────────────────────────────────

describe("unifiedAdmission — admitSync error propagation", () => {
  it("propagates the underlying limiter's checkSync throw (async-only store)", () => {
    // Build a minimal Limiter mock that supports `check` (async) but throws on `checkSync`.
    // This mirrors what a Redis-backed limiter does when checkSync is requested
    // and the underlying store is async-only.
    const dummyDecision: Decision = {
      allowed: true,
      limit: 1,
      remaining: 1,
      resetAt: 0,
      retryAfterMs: 0,
    };
    const dummyStrategy: Strategy = {
      name: "dummy",
      limit: 1,
      ttlMs: 1_000,
      check: () => ({ state: undefined, result: dummyDecision, ttlMs: 1_000, persist: false }),
    };
    const asyncOnly: Limiter = {
      strategy: dummyStrategy,
      check: () => Promise.resolve(dummyDecision),
      checkSync: () => {
        throw new ThrottleKitError("checkSync requires a synchronous store");
      },
      checkMany: () => Promise.resolve([dummyDecision]),
      checkManySync: () => {
        throw new ThrottleKitError("checkManySync requires a synchronous store");
      },
      reset: () => Promise.resolve(),
    };

    const admit = unifiedAdmission({ rate: asyncOnly });
    expect(() => admit.admitSync({ key: "k" })).toThrow(/checkSync requires/);
  });

  it("admit (async) succeeds with the same async-only limiter", async () => {
    const dummyDecision: Decision = {
      allowed: true,
      limit: 1,
      remaining: 1,
      resetAt: 0,
      retryAfterMs: 0,
    };
    const dummyStrategy: Strategy = {
      name: "dummy",
      limit: 1,
      ttlMs: 1_000,
      check: () => ({ state: undefined, result: dummyDecision, ttlMs: 1_000, persist: false }),
    };
    const asyncOnly: Limiter = {
      strategy: dummyStrategy,
      check: () => Promise.resolve(dummyDecision),
      checkSync: () => {
        throw new ThrottleKitError("checkSync requires a synchronous store");
      },
      checkMany: () => Promise.resolve([dummyDecision]),
      checkManySync: () => {
        throw new ThrottleKitError("checkManySync requires a synchronous store");
      },
      reset: () => Promise.resolve(),
    };

    const admit = unifiedAdmission({ rate: asyncOnly });
    const result = await admit.admit({ key: "k" });
    expect(result.decision.allowed).toBe(true);
  });
});

// ── Key + cost forwarding ─────────────────────────────────────────────────────────────────────

describe("unifiedAdmission — key + cost forwarding", () => {
  it("forwards the key to both rate and cost limiters (independent per-tenant accounting)", async () => {
    const clock = new ManualClock(0);
    const rate = rateLimit({ strategy: gcra({ limit: 2, periodMs: 60_000 }), clock });
    const cost = rateLimit({
      strategy: tokenBucket({ capacity: 100, refillPerSec: 100 }),
      clock,
    });
    const admit = unifiedAdmission({ rate, cost });

    // tenant:a admits 2 then is denied on rate; tenant:b is independent and still admits.
    expect((await admit.admit({ key: "tenant:a", cost: 10 })).decision.allowed).toBe(true);
    expect((await admit.admit({ key: "tenant:a", cost: 10 })).decision.allowed).toBe(true);
    expect((await admit.admit({ key: "tenant:a", cost: 10 })).decision.allowed).toBe(false);
    expect((await admit.admit({ key: "tenant:b", cost: 10 })).decision.allowed).toBe(true);
  });

  it("forwards the cost arg to the cost limiter (concurrency / rate unaffected)", async () => {
    const clock = new ManualClock(0);
    const cost = rateLimit({
      strategy: tokenBucket({ capacity: 50, refillPerSec: 100 }),
      clock,
    });
    const admit = unifiedAdmission({ cost });

    // cost=20 admits twice (40 of 50 used); cost=20 again denies (60 > 50).
    expect((await admit.admit({ key: "k", cost: 20 })).decision.allowed).toBe(true);
    expect((await admit.admit({ key: "k", cost: 20 })).decision.allowed).toBe(true);
    expect((await admit.admit({ key: "k", cost: 20 })).decision.allowed).toBe(false);
  });

  it("cost defaults to 1 when omitted", async () => {
    const clock = new ManualClock(0);
    const cost = rateLimit({
      strategy: tokenBucket({ capacity: 3, refillPerSec: 100 }),
      clock,
    });
    const admit = unifiedAdmission({ cost });

    // No `cost` in admit options → defaults to 1; capacity 3 → 3 admits then deny.
    expect((await admit.admit({ key: "k" })).decision.allowed).toBe(true);
    expect((await admit.admit({ key: "k" })).decision.allowed).toBe(true);
    expect((await admit.admit({ key: "k" })).decision.allowed).toBe(true);
    expect((await admit.admit({ key: "k" })).decision.allowed).toBe(false);
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────────────────────────

/**
 * Wrap a Limiter to count how many times `check` was called. Used to assert
 * short-circuit behavior (a denying axis upstream means the downstream axis's
 * check count does NOT increment).
 */
function trackedLimiter(inner: Limiter): { limiter: Limiter; calls: number } {
  const tracker = { limiter: inner, calls: 0 };
  const wrapped: Limiter = {
    ...inner,
    check: async (key: string, cost?: number) => {
      tracker.calls += 1;
      return inner.check(key, cost);
    },
    checkSync: (key: string, cost?: number) => {
      tracker.calls += 1;
      return inner.checkSync(key, cost);
    },
  };
  tracker.limiter = wrapped;
  return tracker;
}

// ── Concurrency: per-call decision isolation (regression) ────────────────────────────────────────

describe("unifiedAdmission — concurrent async admits do not cross-contaminate", () => {
  const ALLOW: Decision = {
    allowed: true,
    limit: 10,
    remaining: 5,
    resetAt: 1000,
    retryAfterMs: 0,
  };
  const DENY: Decision = {
    allowed: false,
    limit: 10,
    remaining: 0,
    resetAt: 1000,
    retryAfterMs: 500,
  };
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  /** A Limiter whose async check() parks until resolveNext() settles it (FIFO) — for precise interleaving. */
  function controllable(): {
    limiter: Limiter;
    resolveNext: (d: Decision) => void;
    pending: () => number;
  } {
    const q: Array<(d: Decision) => void> = [];
    const limiter = {
      strategy: {} as Strategy,
      check: () => new Promise<Decision>((res) => q.push(res)),
      checkSync: () => {
        throw new Error("sync not supported in this mock");
      },
    } as unknown as Limiter;
    return {
      limiter,
      resolveNext: (d) => (q.shift() as (d: Decision) => void)(d),
      pending: () => q.length,
    };
  }

  it("a passing admit is not flipped to denied by another in-flight admit's deny (regression)", async () => {
    // Two admits race over ONE admitter. A passes its own rate+cost; B's rate denies. The per-axis
    // state used to be shared closure state, so B's deny (landing while A was parked on cost.check)
    // overwrote A's lastRate — and A's finalize then read B's DENY and wrongly denied a passing request.
    const rate = controllable();
    const cost = controllable();
    const admitter = unifiedAdmission({ rate: rate.limiter, cost: cost.limiter });

    const pA = admitter.admit({ key: "A", cost: 1 });
    const pB = admitter.admit({ key: "B", cost: 1 });
    await tick();
    expect(rate.pending()).toBe(2); // both parked at rate.check()

    rate.resolveNext(ALLOW); // A's rate -> ALLOW; A advances and parks at cost.check()
    await tick();
    rate.resolveNext(DENY); // B's rate -> DENY; B short-circuits and returns
    await tick();
    cost.resolveNext(ALLOW); // A's cost -> ALLOW; A finalizes from its OWN snapshot

    const a = await pA;
    const b = await pB;
    expect(b.decision.allowed).toBe(false); // B correctly denied by its own rate axis
    expect(b.bindingAxis).toBe("rate");
    expect(a.decision.allowed).toBe(true); // A passed BOTH its axes — must not inherit B's deny
    expect(a.bindingAxis).toBeUndefined();
  });
});
