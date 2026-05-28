import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/core/clock";
import { MemoryStore } from "../../src/stores/memory";
import { weightedFairEscrow } from "../../src/twotier/weighted-fair-escrow";

/**
 * Happy-path coverage for the L1-only `weightedFairEscrow` (TK-1310, first commit per DR-P4-13).
 * The full T1-T4 property gate at `numRuns: 200` and the L1-vs-L2 dual-path conformance arrive in
 * TK-1311. These tests pin the streaming algorithm's guarantee+borrow semantics: every check first
 * tries the dynamic guaranteed share `gᵢ = ⌊wᵢ/W·L⌋`, then borrows from the surplus left after
 * pessimistically reserving every other active tenant's still-owed guarantee.
 *
 * Design: `research/bigger-bets/pillar4-wfe/DESIGN.md` §5 / §6.2 (+ the DR-P4-2 "Why changed" note
 * on the streaming algorithm matching exact integer guarantees per check, no quantum slack).
 */

describe("weightedFairEscrow — input validation", () => {
  it("rejects non-positive limit", () => {
    expect(() => weightedFairEscrow({ limit: 0, windowMs: 1000 })).toThrow(/limit.*positive/i);
    expect(() => weightedFairEscrow({ limit: -1, windowMs: 1000 })).toThrow(/limit.*positive/i);
  });

  it("rejects non-positive windowMs", () => {
    expect(() => weightedFairEscrow({ limit: 100, windowMs: 0 })).toThrow(/windowMs.*positive/i);
  });

  it("rejects empty tenant", () => {
    const escrow = weightedFairEscrow({ limit: 100, windowMs: 1000 });
    expect(() => escrow.checkSync("")).toThrow(/tenant.*non-empty/i);
  });

  it("rejects non-positive cost", () => {
    const escrow = weightedFairEscrow({ limit: 100, windowMs: 1000 });
    expect(() => escrow.checkSync("t", 0)).toThrow(/cost.*positive/i);
  });

  it("rejects non-positive weight from weightOf", () => {
    const escrow = weightedFairEscrow({ limit: 100, windowMs: 1000, weightOf: () => 0 });
    expect(() => escrow.checkSync("t", 1)).toThrow(/weight.*positive/i);
  });
});

describe("weightedFairEscrow — single tenant happy path", () => {
  it("admits up to the full budget when only one tenant is active", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const escrow = weightedFairEscrow({ limit: 10, windowMs: 1000, clock });

    let admitted = 0;
    for (let i = 0; i < 12; i++) {
      const d = escrow.checkSync("only", 1);
      if (d.allowed) admitted++;
    }
    expect(admitted).toBe(10); // exactly L; no over-admission, no leftover
  });

  it("reports decision fields consistently for an allow", () => {
    const now = 1_700_000_000_000;
    const windowMs = 60_000;
    // Windows are epoch-aligned, so the live window's resetAt is the next 60s boundary:
    const expectedResetAt = Math.floor(now / windowMs) * windowMs + windowMs;
    const clock = new ManualClock(now);
    const escrow = weightedFairEscrow({ limit: 100, windowMs, clock });

    const d = escrow.checkSync("t", 5);
    expect(d.allowed).toBe(true);
    expect(d.limit).toBe(100); // sole tenant ⇒ g_i = ⌊1/1·100⌋ = 100
    expect(d.remaining).toBe(95);
    expect(d.resetAt).toBe(expectedResetAt);
    expect(d.retryAfterMs).toBe(0);
  });

  it("reports decision fields consistently for a deny (budget-exhausted)", () => {
    const now = 1_700_000_000_000;
    const windowMs = 60_000;
    const expectedResetAt = Math.floor(now / windowMs) * windowMs + windowMs;
    const clock = new ManualClock(now);
    const escrow = weightedFairEscrow({ limit: 10, windowMs, clock });

    for (let i = 0; i < 10; i++) escrow.checkSync("t", 1);
    const d = escrow.checkSync("t", 1);
    expect(d.allowed).toBe(false);
    expect(d.remaining).toBe(0);
    expect(d.resetAt).toBe(expectedResetAt);
    expect(d.retryAfterMs).toBe(expectedResetAt - now);
  });
});

describe("weightedFairEscrow — two tenants, equal weight", () => {
  it("splits a contended budget 50/50 exactly (no quantum slack at L1)", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const escrow = weightedFairEscrow({ limit: 10, windowMs: 1000, clock });

    // Warm-up: both tenants present so the dynamic guarantee shifts from 10 (sole) to 5 (split).
    escrow.checkSync("A", 1);
    escrow.checkSync("B", 1);

    // Alternating drain — each wants 10 credits.
    let aAdmitted = 1;
    let bAdmitted = 1;
    for (let i = 0; i < 18; i++) {
      const t = i % 2 === 0 ? "A" : "B";
      const d = escrow.checkSync(t, 1);
      if (d.allowed) {
        if (t === "A") aAdmitted++;
        else bAdmitted++;
      }
    }
    expect(aAdmitted + bAdmitted).toBe(10);
    // Equal weights + equal pattern ⇒ exactly 5/5 (no quantum slack).
    expect(aAdmitted).toBe(5);
    expect(bAdmitted).toBe(5);
  });

  it("both tenants get full demand when it fits", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const escrow = weightedFairEscrow({ limit: 100, windowMs: 1000, clock });

    let aAdmitted = 0;
    let bAdmitted = 0;
    for (let i = 0; i < 10; i++) {
      if (escrow.checkSync("A", 1).allowed) aAdmitted++;
      if (escrow.checkSync("B", 1).allowed) bAdmitted++;
    }
    expect(aAdmitted).toBe(10);
    expect(bAdmitted).toBe(10);
  });
});

describe("weightedFairEscrow — two tenants, weight 4:1 (the canonical skewed contrast)", () => {
  it("admits in exactly 8:2 proportion under simultaneous overload (T2 sharing-incentive)", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const escrow = weightedFairEscrow({
      limit: 10,
      windowMs: 1000,
      weightOf: (t) => (t === "high" ? 4 : 1),
      clock,
    });

    // Warm-up: both tenants present so the dynamic g_i settles at g_high=8, g_low=2.
    escrow.checkSync("high", 1);
    escrow.checkSync("low", 1);

    let high = 1;
    let low = 1;
    for (let i = 0; i < 18; i++) {
      const t = i % 2 === 0 ? "high" : "low";
      const d = escrow.checkSync(t, 1);
      if (d.allowed) {
        if (t === "high") high++;
        else low++;
      }
    }
    expect(high + low).toBe(10);
    // Streaming WFE matches the batch ideal for continuously-backlogged tenants under simultaneous
    // arrival — both saturate exactly at g_high=8, g_low=2.
    expect(high).toBe(8);
    expect(low).toBe(2);
  });
});

describe("weightedFairEscrow — work-conservation across truly-absent tenants", () => {
  it("a single active tenant takes the entire budget (no inactive tenants to reserve for)", () => {
    // The textbook "Workload C high-priority idle" case: when high never asks, low (the only
    // active tenant) gets the entire L. This is the work-conserving win over static-share.
    const clock = new ManualClock(1_700_000_000_000);
    const escrow = weightedFairEscrow({
      limit: 10,
      windowMs: 1000,
      weightOf: (t) => (t === "high" ? 4 : 1),
      clock,
    });

    let lowAdmitted = 0;
    for (let i = 0; i < 20; i++) {
      const d = escrow.checkSync("low", 1);
      if (d.allowed) lowAdmitted++;
    }
    expect(lowAdmitted).toBe(10); // no other active tenant ⇒ low's g = L
  });

  it("a tenant that stopped after one credit still has their guarantee reserved (T2 honoured)", () => {
    // Honest streaming limitation: we cannot distinguish "stopped" from "about to ask again," so
    // once a tenant is in the active set we pessimistically reserve their guaranteed share until
    // window roll. This trades end-of-window utilisation for T2 sharing-incentive — the same vertex
    // PILLAR4-fairness.md's mechanism description sits at.
    const clock = new ManualClock(1_700_000_000_000);
    const escrow = weightedFairEscrow({
      limit: 10,
      windowMs: 1000,
      weightOf: (t) => (t === "high" ? 4 : 1),
      clock,
    });

    expect(escrow.checkSync("high", 1).allowed).toBe(true); // high used = 1; g_high = 8
    expect(escrow.checkSync("low", 1).allowed).toBe(true); // low used = 1; g_low = 2

    // Low keeps trying. Within g_low it can grow one more credit (used 1 → 2). Beyond that it
    // tries to borrow, but reserve_for_high = max(0, 8 − 1) = 7 ≥ L_remaining = 7 ⇒ borrow=0.
    let lowAdmitted = 1;
    for (let i = 0; i < 20; i++) {
      const d = escrow.checkSync("low", 1);
      if (d.allowed) lowAdmitted++;
    }
    expect(lowAdmitted).toBe(2); // warm-up 1 + one within-guarantee credit = 2
  });

  it("a low-arriving tenant gets its guaranteed share even after another tenant has consumed", () => {
    // A arrives sole, takes 2 credits (well within g_A = 10). B arrives mid-window; with both
    // active, g_A = g_B = ⌊1/2·10⌋ = 5. B can use up to g_B = 5 before borrowing kicks in. This
    // is the T2 win over the "first-grabber-takes-all" failure mode.
    const clock = new ManualClock(1_700_000_000_000);
    const escrow = weightedFairEscrow({ limit: 10, windowMs: 1000, clock });

    // A takes 2.
    expect(escrow.checkSync("A", 2).allowed).toBe(true);
    expect(escrow.stats().tenants.find((t) => t.tenant === "A")?.used).toBe(2);

    // B arrives, asks for 1. With W=2, g_B=5; cost 1 ≤ 5 ⇒ ALLOW (within guarantee).
    const d = escrow.checkSync("B", 1);
    expect(d.allowed).toBe(true);
    expect(d.limit).toBe(5); // g_B
    expect(d.remaining).toBe(4); // 5 − 1
  });
});

describe("weightedFairEscrow — window rollover", () => {
  it("resets at the window boundary; Δ = 0 across boundary", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const escrow = weightedFairEscrow({ limit: 10, windowMs: 1000, clock });

    for (let i = 0; i < 10; i++) expect(escrow.checkSync("t", 1).allowed).toBe(true);
    expect(escrow.checkSync("t", 1).allowed).toBe(false);

    clock.advance(1001);

    let admitted = 0;
    for (let i = 0; i < 10; i++) {
      if (escrow.checkSync("t", 1).allowed) admitted++;
    }
    expect(admitted).toBe(10);
  });

  it("cross-window credits do NOT carry forward (window-coupled by construction)", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const escrow = weightedFairEscrow({ limit: 10, windowMs: 1000, clock });

    for (let i = 0; i < 5; i++) escrow.checkSync("t", 1);
    expect(escrow.stats().tenants[0]?.used).toBe(5);

    clock.advance(1001);

    const d = escrow.checkSync("t", 1);
    expect(d.allowed).toBe(true);
    expect(escrow.stats().tenants[0]?.used).toBe(1); // fresh window
  });
});

describe("weightedFairEscrow — reset", () => {
  it("reset() with no arg clears the whole window", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const escrow = weightedFairEscrow({ limit: 10, windowMs: 1000, clock });

    escrow.checkSync("A", 5);
    escrow.checkSync("B", 3);
    expect(escrow.stats().totalUsed).toBe(8);

    escrow.reset();
    expect(escrow.stats().totalUsed).toBe(0);
    expect(escrow.stats().tenants).toHaveLength(0);
    expect(escrow.stats().pool).toBe(10);
  });

  it("reset(tenant) frees that tenant's used credits back to the pool", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const escrow = weightedFairEscrow({ limit: 10, windowMs: 1000, clock });

    escrow.checkSync("A", 1);
    escrow.checkSync("B", 1);
    // After both checks: A.used = 1, B.used = 1, pool = L − totalUsed = 10 − 2 = 8.
    const poolBefore = escrow.stats().pool;
    expect(poolBefore).toBe(8);

    escrow.reset("A");
    const poolAfter = escrow.stats().pool;
    // A is gone; pool = L − B.used = 10 − 1 = 9.
    expect(poolAfter).toBe(poolBefore + 1);
    expect(escrow.stats().tenants.find((t) => t.tenant === "A")).toBeUndefined();
  });
});

describe("weightedFairEscrow — stats introspection", () => {
  it("snapshot is a copy — mutating it does not affect the live state", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const escrow = weightedFairEscrow({ limit: 10, windowMs: 1000, clock });

    escrow.checkSync("A", 3);
    const snap = escrow.stats();
    const snapTenants = snap.tenants as Array<{
      tenant: string;
      weight: number;
      used: number;
    }>;
    snapTenants.push({ tenant: "fake", weight: 99, used: 0 });
    expect(escrow.stats().tenants).toHaveLength(1);
    expect(escrow.stats().tenants[0]?.tenant).toBe("A");
  });
});

describe("weightedFairEscrow — async check parity with checkSync", () => {
  it("check() resolves to the same Decision as checkSync()", async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const escrow = weightedFairEscrow({ limit: 10, windowMs: 1000, clock });

    const a = await escrow.check("t", 3);
    expect(a.allowed).toBe(true);
    expect(a.remaining).toBe(7);

    const b = escrow.checkSync("t", 3);
    expect(b.allowed).toBe(true);
    expect(b.remaining).toBe(4);
  });
});

describe("weightedFairEscrow — bounded tenant set (l1.maxKeys)", () => {
  it("evicts the oldest tenant when at the cap", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const escrow = weightedFairEscrow({
      limit: 100,
      windowMs: 1000,
      l1: { maxKeys: 2 },
      clock,
    });

    escrow.checkSync("A", 1);
    escrow.checkSync("B", 1);
    expect(
      escrow
        .stats()
        .tenants.map((t) => t.tenant)
        .sort(),
    ).toEqual(["A", "B"]);

    // C arrives — A is evicted (FIFO).
    escrow.checkSync("C", 1);
    const names = escrow
      .stats()
      .tenants.map((t) => t.tenant)
      .sort();
    expect(names).toEqual(["B", "C"]);
  });
});

describe("weightedFairEscrow — T1 safety invariant (the load-bearing property)", () => {
  it("sum of used across all tenants never exceeds L, no matter the sequence", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const L = 17;
    const escrow = weightedFairEscrow({
      limit: L,
      windowMs: 60_000,
      weightOf: (t) => (t === "x" ? 3 : t === "y" ? 2 : 1),
      clock,
    });

    const tenants = ["x", "y", "z", "w"];
    let calls = 0;
    while (calls < 1000) {
      const t = tenants[calls % tenants.length] as string;
      escrow.checkSync(t, 1 + (calls % 3));
      const total = escrow.stats().tenants.reduce((s, te) => s + te.used, 0);
      expect(total).toBeLessThanOrEqual(L);
      calls++;
      if (calls % 100 === 0) clock.advance(60_001);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// L2 multi-process path (DESIGN.md §6.3 / DR-P4-5). The shared budget lives in a `Store`;
// each WFE instance leases `quantum` credits at a time from a fixedWindow strategy against the
// same `l2Key`. MemoryStore acts as a process-local stand-in; the full Redis-gated conformance
// + property gate arrives in TK-1311.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("weightedFairEscrow — L2 input validation", () => {
  it("requires quantum when l2 is set", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = new MemoryStore({ clock, sweepIntervalMs: 0 });
    expect(() =>
      weightedFairEscrow({
        limit: 100,
        windowMs: 1000,
        l2: store,
        clock,
      }),
    ).toThrow(/quantum.*required.*l2/i);
  });

  it("rejects non-positive or non-integer quantum", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = new MemoryStore({ clock, sweepIntervalMs: 0 });
    expect(() =>
      weightedFairEscrow({ limit: 100, windowMs: 1000, l2: store, quantum: 0, clock }),
    ).toThrow(/quantum.*positive/i);
    expect(() =>
      weightedFairEscrow({ limit: 100, windowMs: 1000, l2: store, quantum: 1.5, clock }),
    ).toThrow(/quantum.*integer/i);
  });

  it("checkSync throws when l2 is set (lease is async)", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = new MemoryStore({ clock, sweepIntervalMs: 0 });
    const escrow = weightedFairEscrow({
      limit: 100,
      windowMs: 1000,
      l2: store,
      quantum: 10,
      clock,
    });
    expect(() => escrow.checkSync("t", 1)).toThrow(/checkSync.*unavailable.*l2/i);
  });
});

describe("weightedFairEscrow — L2 single-process correctness", () => {
  it("single process with L2 backing behaves identically to L1 for admit/deny outcomes", async () => {
    // Same demand vector, same weights, same L → admit/deny pattern matches L1-only.
    const clock = new ManualClock(1_700_000_000_000);
    const store = new MemoryStore({ clock, sweepIntervalMs: 0 });
    const escrow = weightedFairEscrow({
      limit: 10,
      windowMs: 1000,
      weightOf: (t) => (t === "high" ? 4 : 1),
      l2: store,
      quantum: 10,
      clock,
    });

    // Warm-up parity with the L1 test.
    expect((await escrow.check("high", 1)).allowed).toBe(true);
    expect((await escrow.check("low", 1)).allowed).toBe(true);

    let high = 1;
    let low = 1;
    for (let i = 0; i < 18; i++) {
      const t = i % 2 === 0 ? "high" : "low";
      const d = await escrow.check(t, 1);
      if (d.allowed) {
        if (t === "high") high++;
        else low++;
      }
    }
    expect(high).toBe(8);
    expect(low).toBe(2);
  });

  it("leases lazily — checks don't lease until the local pool runs short", async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = new MemoryStore({ clock, sweepIntervalMs: 0 });
    const escrow = weightedFairEscrow({
      limit: 1000,
      windowMs: 1000,
      l2: store,
      quantum: 100,
      clock,
    });

    // First check needs at least 1 credit; quantum=100 ⇒ leases 100 in one shot.
    await escrow.check("t", 1);
    expect(escrow.stats().effectiveLimit).toBe(100);

    // Subsequent within-quantum checks don't trigger more leases.
    for (let i = 0; i < 50; i++) await escrow.check("t", 1);
    expect(escrow.stats().effectiveLimit).toBe(100);
    expect(escrow.stats().totalUsed).toBe(51);

    // Crossing the quantum boundary triggers a second lease.
    for (let i = 0; i < 50; i++) await escrow.check("t", 1);
    expect(escrow.stats().effectiveLimit).toBeGreaterThanOrEqual(200);
    expect(escrow.stats().totalUsed).toBe(101);
  });

  it("propagates L2 lease denial when the shared budget is exhausted", async () => {
    // Two WFE instances sharing the same store + key — simulates two processes.
    const clock = new ManualClock(1_700_000_000_000);
    const store = new MemoryStore({ clock, sweepIntervalMs: 0 });
    const key = "test:wfe:shared";
    const a = weightedFairEscrow({
      limit: 100,
      windowMs: 1000,
      l2: store,
      quantum: 100,
      l2Key: key,
      clock,
    });
    const b = weightedFairEscrow({
      limit: 100,
      windowMs: 1000,
      l2: store,
      quantum: 50,
      l2Key: key,
      clock,
    });

    // A leases the whole 100 in one shot.
    await a.check("ta", 1);
    expect(a.stats().effectiveLimit).toBe(100);

    // B tries to lease — store has 0 remaining; lease denied; check denied.
    const d = await b.check("tb", 1);
    expect(d.allowed).toBe(false);
    expect(b.stats().effectiveLimit).toBe(0); // no successful lease
  });
});

describe("weightedFairEscrow — L2 two-process T1 invariant", () => {
  it("Σ used across both processes never exceeds L (the multi-process safety bound)", async () => {
    // Two WFE instances sharing one store. Drive 200 random calls and assert global Σ used ≤ L
    // at every step. The atomic fixedWindow inside the store is what bounds this — the in-process
    // accounting could lie, but the shared counter cannot.
    const clock = new ManualClock(1_700_000_000_000);
    const store = new MemoryStore({ clock, sweepIntervalMs: 0 });
    const L = 50;
    const key = "test:wfe:t1-shared";

    const procA = weightedFairEscrow({
      limit: L,
      windowMs: 60_000,
      l2: store,
      quantum: 5,
      l2Key: key,
      clock,
    });
    const procB = weightedFairEscrow({
      limit: L,
      windowMs: 60_000,
      l2: store,
      quantum: 5,
      l2Key: key,
      clock,
    });

    for (let i = 0; i < 200; i++) {
      const proc = i % 2 === 0 ? procA : procB;
      const tenant = i % 3 === 0 ? "x" : i % 3 === 1 ? "y" : "z";
      await proc.check(tenant, 1);

      const totalA = procA.stats().totalUsed;
      const totalB = procB.stats().totalUsed;
      expect(totalA + totalB).toBeLessThanOrEqual(L);
    }
  });
});

describe("weightedFairEscrow — L2 stats", () => {
  it("effectiveLimit reflects the lazy lease accumulation", async () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = new MemoryStore({ clock, sweepIntervalMs: 0 });
    const escrow = weightedFairEscrow({
      limit: 100,
      windowMs: 1000,
      l2: store,
      quantum: 10,
      clock,
    });

    expect(escrow.stats().effectiveLimit).toBe(0); // no lease yet

    await escrow.check("t", 1);
    expect(escrow.stats().effectiveLimit).toBe(10); // first lease

    await escrow.check("t", 11); // crosses quantum boundary, needs 2nd lease
    expect(escrow.stats().effectiveLimit).toBeGreaterThanOrEqual(20);
  });
});
