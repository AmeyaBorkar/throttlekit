import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { ManualClock } from "../../src/core/clock";
import { decisionTransform } from "../../src/core/transform";
import type { Decision } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";
import { twoTier } from "../../src/twotier";
import { LeaseSpender, type ReserveResult } from "../../src/twotier/lease-spender";
import type { EmittedLeaseEvent, VectorDocument } from "../../wire/vectors/vectors";

/**
 * `LeaseSpender` is the Tier-2 client-side spend of a window-coupled lease — the verbatim port of the
 * `twoTier(leased, windowCoupled)` L1 path. These tests pin (1) its unit behaviour, (2) the one-oracle
 * line: it is byte-identical to the shipped `twoTier` leased L1 over a deterministic random timeline,
 * (3) the golden lease vectors replay through a fresh spender exactly, and (4) the round-trip reduction.
 */

describe("LeaseSpender — unit behaviour", () => {
  it("serves from granted credits, decrementing remaining, then signals a refresh when out", () => {
    const s = new LeaseSpender({ limit: 5, ttlMs: 1000 });
    s.applyLease({ capacity: 3, expiresAt: 1000 });
    expect(s.spend(0, 1)).toEqual({
      needsRefresh: false,
      decision: { allowed: true, limit: 5, remaining: 2, resetAt: 1000, retryAfterMs: 0 },
    });
    expect(s.spend(0, 2)).toEqual({
      needsRefresh: false,
      decision: { allowed: true, limit: 5, remaining: 0, resetAt: 1000, retryAfterMs: 0 },
    });
    expect(s.spend(0, 1)).toEqual({ needsRefresh: true });
  });

  it("discards remaining credits once the granting window rolls (windowCoupled, the default)", () => {
    const s = new LeaseSpender({ limit: 10, ttlMs: 1000 });
    s.applyLease({ capacity: 5, expiresAt: 1000 });
    expect(s.spend(0, 2).needsRefresh).toBe(false);
    expect(s.credits).toBe(3);
    // now >= expiresAt ⇒ the 3 leftover credits are dropped, not carried.
    expect(s.spend(1000, 1)).toEqual({ needsRefresh: true });
    expect(s.credits).toBe(0);
  });

  it("carries credits across the boundary when windowCoupled is disabled (the legacy contrast)", () => {
    const s = new LeaseSpender({ limit: 10, ttlMs: 1000, windowCoupled: false });
    s.applyLease({ capacity: 5, expiresAt: 1000 });
    expect(s.spend(0, 2).needsRefresh).toBe(false); // credits 3
    const r = s.spend(2000, 1);
    expect(r).toEqual({
      needsRefresh: false,
      decision: { allowed: true, limit: 10, remaining: 2, resetAt: 1000, retryAfterMs: 0 },
    });
  });

  it("cannot serve a cost greater than the local credits (needs a larger grant first)", () => {
    const s = new LeaseSpender({ limit: 100, ttlMs: 1000 });
    s.applyLease({ capacity: 5, expiresAt: 1000 });
    expect(s.spend(0, 8)).toEqual({ needsRefresh: true }); // 8 > 5
    s.applyLease({ capacity: 10, expiresAt: 1000 }); // credits 15
    expect(s.spend(0, 8).needsRefresh).toBe(false); // remaining 7
  });

  it("accumulates partial grants (capacity may be < wants) before serving", () => {
    const s = new LeaseSpender({ limit: 100, ttlMs: 1000 });
    s.applyLease({ capacity: 3, expiresAt: 1000 }); // a partial grant
    s.applyLease({ capacity: 4, expiresAt: 1000 }); // another → credits 7
    expect(s.spend(0, 7).needsRefresh).toBe(false);
    expect(s.spend(0, 1)).toEqual({ needsRefresh: true });
  });

  it("validates cost as a positive finite number", () => {
    const s = new LeaseSpender({ limit: 5, ttlMs: 1000 });
    s.applyLease({ capacity: 5, expiresAt: 1000 });
    expect(() => s.spend(0, 0)).toThrow(/cost must be a positive finite number/);
    expect(() => s.spend(0, -1)).toThrow(/cost must be a positive finite number/);
  });

  it("reset() forgets all local credits and the window coupling", () => {
    const s = new LeaseSpender({ limit: 5, ttlMs: 1000 });
    s.applyLease({ capacity: 5, expiresAt: 1000 });
    s.reset();
    expect(s.credits).toBe(0);
    expect(s.expiresAt).toBeUndefined();
    expect(s.spend(0, 1)).toEqual({ needsRefresh: true });
  });
});

describe("LeaseSpender.spendOrRefresh — the client loop", () => {
  it("refreshes on a shortfall and serves the retried request", async () => {
    const s = new LeaseSpender({ limit: 1000, ttlMs: 60_000 });
    let reserves = 0;
    const reserve = async (): Promise<ReserveResult> => {
      reserves++;
      return { capacity: 100, expiresAt: 60_000 };
    };
    const d = await s.spendOrRefresh(0, 1, reserve);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(99);
    expect(reserves).toBe(1);
  });

  it("surfaces the server's denial verbatim (never synthesizes one)", async () => {
    const s = new LeaseSpender({ limit: 5, ttlMs: 1000 });
    const serverDeny: Decision = {
      allowed: false,
      limit: 5,
      remaining: 0,
      resetAt: 1000,
      retryAfterMs: 250,
    };
    const reserve = async (): Promise<ReserveResult> => ({ denied: serverDeny });
    const d = await s.spendOrRefresh(750, 1, reserve);
    expect(d).toEqual(serverDeny); // byte-identical to the server's authoritative decision
  });

  it("fails loudly on a zero-capacity grant that is not a denial (a reserve() contract violation)", async () => {
    const s = new LeaseSpender({ limit: 5, ttlMs: 1000 });
    const reserve = async (): Promise<ReserveResult> => ({ capacity: 0, expiresAt: 1000 });
    await expect(s.spendOrRefresh(0, 1, reserve)).rejects.toThrow(/zero-capacity grant/);
  });

  it("serves a grant whose window boundary is <= now instead of spinning to maxRounds (regression)", async () => {
    // The grant's expiresAt equals `now` (a server/store window boundary coincident with the client
    // clock, or clock skew). The old per-round re-discard dropped the fresh grant every iteration and
    // threw at maxRounds; the core twoTier leased path serves the request. Mirror the core.
    const s = new LeaseSpender({ limit: 100, ttlMs: 1000, windowCoupled: true });
    let reserves = 0;
    const reserve = async (): Promise<ReserveResult> => {
      reserves++;
      return { capacity: 10, expiresAt: 1000 };
    };
    const d = await s.spendOrRefresh(1000, 1, reserve, 8);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(9);
    expect(d.resetAt).toBe(1000);
    expect(reserves).toBe(1); // exactly one refresh, not 8 spun rounds
  });
});

describe("LeaseSpender — one-oracle equivalence with twoTier(leased, windowCoupled)", () => {
  it("is byte-identical to the shipped twoTier L1 spend over a deterministic random timeline", async () => {
    // A deterministic (seeded LCG) timeline that crosses several window boundaries and the global-budget
    // exhaustion, with mixed costs — the divergence-prone transitions for a leased spend.
    let seed = 0x12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const timeline: Array<[number, number]> = [];
    let t = 0;
    for (let i = 0; i < 80; i++) {
      t += Math.floor(rnd() * 130); // 0..129ms steps → ~5s span over 80 ops (crosses many windows)
      timeline.push([t, 1 + Math.floor(rnd() * 3)]); // cost 1..3
    }

    const LIMIT = 20;
    const WINDOW = 1000;
    const BATCH = 5; // batch <= limit so the first lease can be admitted

    // The shipped oracle: twoTier leased over a real fixedWindow L2.
    const clockA = new ManualClock(0);
    const l2a = new MemoryStore({ sweepIntervalMs: 0, clock: clockA });
    const limiterA = twoTier({
      strategy: fixedWindow({ limit: LIMIT, windowMs: WINDOW }),
      l2: l2a,
      mode: "leased",
      lease: { batch: BATCH, windowCoupled: true },
      clock: clockA,
    });

    // The port: a LeaseSpender whose refresh leases from an identical, independent fixedWindow L2 exactly
    // as twoTier does (lease max(batch, cost); add the granted batch; surface an L2 denial verbatim).
    const clockB = new ManualClock(0);
    const l2b = new MemoryStore({ sweepIntervalMs: 0, clock: clockB });
    const stratB = fixedWindow({ limit: LIMIT, windowMs: WINDOW });
    const spender = new LeaseSpender({ limit: LIMIT, ttlMs: stratB.ttlMs, windowCoupled: true });
    const reserve = async (wants: number): Promise<ReserveResult> => {
      const amt = Math.max(BATCH, wants);
      const d = await l2b.apply("k", decisionTransform(stratB, clockB.now(), amt));
      return d.allowed ? { capacity: amt, expiresAt: d.resetAt } : { denied: d };
    };

    for (const [tt, cost] of timeline) {
      clockA.set(tt);
      clockB.set(tt);
      const da = await limiterA.check("k", cost);
      const db = await spender.spendOrRefresh(tt, cost, reserve);
      expect(db).toEqual(da);
    }
  });
});

describe("LeaseSpender — golden lease-vector conformance", () => {
  const doc = JSON.parse(
    readFileSync(join(__dirname, "../../wire/vectors/golden-vectors.json"), "utf8"),
  ) as VectorDocument;
  const leaseSuites = doc.suites.filter(
    (s): s is Extract<VectorDocument["suites"][number], { primitive: "lease" }> =>
      s.primitive === "lease",
  );

  it("ships lease suites in the committed contract", () => {
    expect(leaseSuites.length).toBeGreaterThanOrEqual(6);
  });

  for (const suite of leaseSuites) {
    it(`replays "${suite.name}" through a fresh LeaseSpender byte-for-byte`, () => {
      const s = new LeaseSpender({
        limit: suite.limit,
        ttlMs: suite.ttlMs,
        windowCoupled: suite.windowCoupled,
      });
      for (const ev of suite.events as EmittedLeaseEvent[]) {
        if (ev.op === "grant") {
          s.applyLease({ capacity: ev.capacity, expiresAt: ev.expiresAt });
          continue;
        }
        const r = s.spend(ev.now, ev.cost);
        const got = r.needsRefresh
          ? { needsRefresh: true }
          : {
              needsRefresh: false,
              decision: {
                allowed: r.decision.allowed,
                limit: r.decision.limit,
                remaining: r.decision.remaining,
                resetAt: r.decision.resetAt,
                retryAfterMs: r.decision.retryAfterMs,
              },
            };
        expect(got).toEqual(ev.expect);
      }
    });
  }
});

describe("LeaseSpender — round-trip reduction (the Tier-2 win)", () => {
  it("makes one Reserve per batch instead of one round trip per request", async () => {
    const BATCH = 100;
    const N = 1000;
    let reserves = 0;
    const s = new LeaseSpender({ limit: 1_000_000, ttlMs: 60_000 });
    const reserve = async (): Promise<ReserveResult> => {
      reserves++;
      return { capacity: BATCH, expiresAt: 60_000 };
    };
    for (let i = 0; i < N; i++) {
      const d = await s.spendOrRefresh(0, 1, reserve);
      expect(d.allowed).toBe(true);
    }
    // Tier-1 would be N round trips; Tier-2 is N / batch — a batch-fold reduction.
    expect(reserves).toBe(N / BATCH);
  });
});
