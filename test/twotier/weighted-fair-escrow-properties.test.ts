import fc from "fast-check";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ManualClock } from "../../src/core/clock";
import { combineDecisions } from "../../src/core/combine";
import { RedisStore } from "../../src/redis/store";
import { MemoryStore } from "../../src/stores/memory";
import { weightedFairEscrow } from "../../src/twotier/weighted-fair-escrow";

/**
 * Property tests for `weightedFairEscrow` — proves T1 (safety), T2 (sharing-incentive),
 * T3 (work-conservation), T4 (bounded unfairness) hold under random demand patterns at
 * numRuns ≥ 200. Plus L1 ≡ L2 dual-path conformance (same demand vector → byte-equal per-tenant
 * `used`) at quantum = L (the no-cross-process-slack configuration).
 *
 * Design contract: `research/bigger-bets/pillar4-wfe/DESIGN.md` §9.
 * The pure batch algebra (`weightedMaxMin`) is independently proven at 20 000 random trials in
 * `test/gale/fair-escrow.test.ts`; this gate proves the streaming wrapper preserves the same
 * theorems for continuously-backlogged tenants under the documented streaming caveats.
 */

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

// Reasonable workload generators reusable across properties.
const limitArb = fc.integer({ min: 5, max: 200 });
const weightArb = fc.integer({ min: 1, max: 6 });
const costArb = fc.integer({ min: 1, max: 4 });

// ─────────────────────────────────────────────────────────────────────────────────────────────
// T1 SAFETY — Σ used across all tenants never exceeds L at any point.
// This is the load-bearing property: it must hold for *any* sequence of (tenant, cost) calls,
// random or adversarial, regardless of weights or window position.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("T1 safety — Σ used ≤ L always", () => {
  it("L1 mode: invariant holds across 200 random timelines", () => {
    fc.assert(
      fc.property(
        limitArb,
        fc.dictionary(fc.constantFrom("A", "B", "C", "D"), weightArb, {
          minKeys: 1,
          maxKeys: 4,
        }),
        fc.array(fc.tuple(fc.constantFrom("A", "B", "C", "D"), costArb), {
          minLength: 1,
          maxLength: 40,
        }),
        (L, weights, calls) => {
          const clock = new ManualClock(1_700_000_000_000);
          const escrow = weightedFairEscrow({
            limit: L,
            windowMs: 60_000,
            weightOf: (t) => weights[t] ?? 1,
            clock,
          });
          for (const [tenant, cost] of calls) {
            escrow.checkSync(tenant, cost);
            const total = sum(escrow.stats().tenants.map((t) => t.used));
            if (total > L) return false;
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// T2 SHARING-INCENTIVE — every backlogged tenant gets at least its dynamic guaranteed share gᵢ.
// Streaming caveat: hold the active set fixed (all tenants arrive in a warm-up round) and have
// each tenant continuously demand until denied; under that pattern T2 holds tightly.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("T2 sharing-incentive — backlogged tenants get ≥ gᵢ", () => {
  it("L1 mode: every continuously-backlogged tenant reaches gᵢ", () => {
    fc.assert(
      fc.property(
        // Bigger L so g_i ≥ 1 even for low-weight tenants.
        fc.integer({ min: 20, max: 200 }),
        // 2–4 tenants with weights 1..6.
        fc.array(weightArb, { minLength: 2, maxLength: 4 }),
        (L, weights) => {
          const clock = new ManualClock(1_700_000_000_000);
          const tenants = weights.map((_, i) => `t${i}`);
          const wmap = Object.fromEntries(tenants.map((t, i) => [t, weights[i] as number]));
          const W = weights.reduce((a, b) => a + b, 0);
          const expectedG = weights.map((w) => Math.floor(((w as number) / W) * L));

          const escrow = weightedFairEscrow({
            limit: L,
            windowMs: 60_000,
            weightOf: (t) => wmap[t] ?? 1,
            clock,
          });

          // Warm-up: every tenant arrives, takes 1 credit each.
          for (const t of tenants) escrow.checkSync(t, 1);
          // Then alternate round-robin until every check returns deny twice in a row for any tenant.
          // This simulates "continuously backlogged" — each tenant keeps asking.
          const MAX_ROUNDS = 5 * L + tenants.length;
          for (let r = 0; r < MAX_ROUNDS; r++) {
            for (const t of tenants) escrow.checkSync(t, 1);
          }

          // T2: each tenant's used ≥ min(L, gᵢ). All tenants are backlogged so each should reach gᵢ.
          for (let i = 0; i < tenants.length; i++) {
            const entry = escrow.stats().tenants.find((e) => e.tenant === tenants[i]);
            const used = entry?.used ?? 0;
            if (used < (expectedG[i] as number)) return false;
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// T3 WORK-CONSERVATION — at end of window with continuously-backlogged tenants, Σ used = L.
// (Streaming caveat: no idle tenants in the active set; everyone keeps asking.)
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("T3 work-conservation — full L utilised under saturation", () => {
  it("L1 mode: under continuous backlog, Σ used reaches L", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10, max: 100 }),
        fc.array(weightArb, { minLength: 2, maxLength: 4 }),
        (L, weights) => {
          const clock = new ManualClock(1_700_000_000_000);
          const tenants = weights.map((_, i) => `t${i}`);
          const wmap = Object.fromEntries(tenants.map((t, i) => [t, weights[i] as number]));
          const escrow = weightedFairEscrow({
            limit: L,
            windowMs: 60_000,
            weightOf: (t) => wmap[t] ?? 1,
            clock,
          });

          // Warm-up: all tenants arrive.
          for (const t of tenants) escrow.checkSync(t, 1);
          // Saturating round-robin.
          const MAX_ROUNDS = 5 * L + tenants.length;
          for (let r = 0; r < MAX_ROUNDS; r++) {
            for (const t of tenants) escrow.checkSync(t, 1);
          }

          const total = sum(escrow.stats().tenants.map((t) => t.used));
          return total === L;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// T4 BOUNDED UNFAIRNESS — for continuously-backlogged tenants, |aᵢ/wᵢ − aⱼ/wⱼ| ≤ slack.
// L1 mode is quantum-free → slack = 1/min(wᵢ, wⱼ) (from the floor() in g_i, since each tenant
// gets at least ⌊wᵢ/W·L⌋ and at most one extra credit from rounding).
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("T4 bounded unfairness — DRR-style fairness bound", () => {
  it("L1 mode: |aᵢ/wᵢ − aⱼ/wⱼ| ≤ 2/w_min (DRR with quantum = call cost = 1)", () => {
    // The DRR bound is `q·(1/w_i + 1/w_j)` per Shreedhar-Varghese (SIGCOMM'95). For our streaming
    // L1 algorithm with per-call borrow capped at the call's `cost`, the effective quantum is 1
    // when all calls use cost=1. The max pairwise spread is at most `1/w_i + 1/w_j` for any pair,
    // bounded conservatively by `2/w_min`.
    fc.assert(
      fc.property(
        fc.integer({ min: 20, max: 100 }),
        fc.array(weightArb, { minLength: 2, maxLength: 4 }),
        (L, weights) => {
          const clock = new ManualClock(1_700_000_000_000);
          const tenants = weights.map((_, i) => `t${i}`);
          const wmap = Object.fromEntries(tenants.map((t, i) => [t, weights[i] as number]));
          const escrow = weightedFairEscrow({
            limit: L,
            windowMs: 60_000,
            weightOf: (t) => wmap[t] ?? 1,
            clock,
          });

          for (const t of tenants) escrow.checkSync(t, 1);
          for (let r = 0; r < 5 * L + tenants.length; r++) {
            for (const t of tenants) escrow.checkSync(t, 1);
          }

          const norms = tenants
            .map((t) => {
              const entry = escrow.stats().tenants.find((e) => e.tenant === t);
              const used = entry?.used ?? 0;
              const w = wmap[t] as number;
              return used / w;
            })
            .filter((n) => Number.isFinite(n));
          const spread = Math.max(...norms) - Math.min(...norms);
          const wMin = Math.min(...weights);
          const bound = 2 / wMin;
          return spread <= bound + 1e-9;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// L1 ≡ L2 DUAL-PATH CONFORMANCE — with quantum = L, the L2 path leases the whole budget in one
// shot and runs the identical algorithm; per-tenant `used` must match exactly.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("dual-path conformance — L1 ≡ L2 with quantum = L (MemoryStore)", () => {
  it("same demand vector → byte-equal per-tenant `used` (200 timelines)", async () => {
    await fc.assert(
      fc.asyncProperty(
        limitArb,
        fc.dictionary(fc.constantFrom("A", "B", "C", "D"), weightArb, {
          minKeys: 1,
          maxKeys: 4,
        }),
        fc.array(fc.tuple(fc.constantFrom("A", "B", "C", "D"), costArb), {
          minLength: 1,
          maxLength: 30,
        }),
        async (L, weights, calls) => {
          const clock = new ManualClock(1_700_000_000_000);
          const store = new MemoryStore({ clock, sweepIntervalMs: 0 });

          const l1 = weightedFairEscrow({
            limit: L,
            windowMs: 60_000,
            weightOf: (t) => weights[t] ?? 1,
            clock,
          });
          const l2 = weightedFairEscrow({
            limit: L,
            windowMs: 60_000,
            weightOf: (t) => weights[t] ?? 1,
            l2: store,
            quantum: L, // no cross-process slack — single lease grabs everything
            l2Key: `test:wfe:dual:${L}`,
            clock,
          });

          for (const [tenant, cost] of calls) {
            const r1 = l1.checkSync(tenant, cost);
            const r2 = await l2.check(tenant, cost);
            // Sanity: at least the allowed bit must agree (full Decision equality may differ on
            // `limit` because L2 reports leased-pool-derived ceilings while L1 reports L-derived
            // ceilings; what we conform on is the *allocation outcome*, i.e. `allowed`).
            if (r1.allowed !== r2.allowed) return false;
          }

          // Per-tenant used vectors must match exactly.
          const u1 = new Map(l1.stats().tenants.map((t) => [t.tenant, t.used]));
          const u2 = new Map(l2.stats().tenants.map((t) => [t.tenant, t.used]));
          if (u1.size !== u2.size) return false;
          for (const [k, v] of u1) {
            if (u2.get(k) !== v) return false;
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// L2 MULTI-PROCESS T1 (property) — two WFE instances sharing one store; Σ used never exceeds L.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("L2 multi-process T1 invariant", () => {
  it("two processes sharing a store never collectively exceed L", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 10, max: 60 }),
        fc.array(fc.tuple(fc.boolean(), fc.constantFrom("A", "B", "C"), costArb), {
          minLength: 1,
          maxLength: 30,
        }),
        async (L, calls) => {
          const clock = new ManualClock(1_700_000_000_000);
          const store = new MemoryStore({ clock, sweepIntervalMs: 0 });
          const key = `test:wfe:multi:${L}`;

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

          for (const [useA, tenant, cost] of calls) {
            const proc = useA ? procA : procB;
            await proc.check(tenant, cost);
            const totalA = procA.stats().totalUsed;
            const totalB = procB.stats().totalUsed;
            if (totalA + totalB > L) return false;
          }
          return true;
        },
      ),
      { numRuns: 100 }, // 100 here vs 200 elsewhere because each timeline does 30 async leases
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// COMPOSITION — WFE returns a Decision compatible with `combineDecisions` (the unifiedAdmission
// algebra). The WFE-binds-the-decision case is detectable via `bindingAxisOf` when wired into
// unifiedAdmission's cost axis (the 0.10.x widening per DR-P4-4; not in 0.9.1).
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("composition with combineDecisions", () => {
  it("combineDecisions of an ALLOW rate with a WFE allow yields ALLOW with min-fields", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const escrow = weightedFairEscrow({ limit: 100, windowMs: 60_000, clock });
    const cost = escrow.checkSync("t", 5);
    const rate = {
      allowed: true,
      limit: 50,
      remaining: 45,
      resetAt: cost.resetAt,
      retryAfterMs: 0,
    };
    const combined = combineDecisions(rate, cost);
    expect(combined.allowed).toBe(true);
    expect(combined.limit).toBe(Math.min(rate.limit, cost.limit));
    expect(combined.remaining).toBe(Math.min(rate.remaining, cost.remaining));
  });

  it("a WFE deny dominates a rate allow under combineDecisions", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const escrow = weightedFairEscrow({ limit: 5, windowMs: 60_000, clock });
    // Drain WFE.
    for (let i = 0; i < 5; i++) escrow.checkSync("t", 1);
    const cost = escrow.checkSync("t", 1);
    expect(cost.allowed).toBe(false);

    const rate = {
      allowed: true,
      limit: 100,
      remaining: 99,
      resetAt: cost.resetAt,
      retryAfterMs: 0,
    };
    const combined = combineDecisions(rate, cost);
    expect(combined.allowed).toBe(false);
    expect(combined.retryAfterMs).toBe(cost.retryAfterMs); // max(0, cost) = cost
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// REDIS-GATED DUAL-PATH — same conformance against a real Redis. Dedicated DB 7 per DR-P4-12.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const url = process.env.THROTTLEKIT_TEST_REDIS;
const dRedis = url ? describe : describe.skip;

dRedis("dual-path conformance — L1 ≡ L2 with quantum = L (RedisStore, DB 7)", () => {
  let client: Redis;

  beforeAll(async () => {
    // DB 7 is SHARED with test/redis/node-redis.test.ts (17 Redis-backed test files, only 16 logical
    // DBs — exactly one pair must co-tenant). Safe because neither file does a DB-global FLUSHDB:
    // this suite's L2 keys are unique per fast-check attempt (see `key` below) and node-redis
    // namespaces under a per-run token. Do NOT add a flushdb() here — it would wipe node-redis's
    // in-flight keys (and vice-versa) and reintroduce the cross-file flake fixed on 2026-05-30.
    client = new Redis(url as string, { db: 7 });
  });

  afterAll(async () => {
    await client?.quit();
  });

  it("L1 ≡ Redis-L2 with quantum = L (50 timelines)", async () => {
    await fc.assert(
      fc.asyncProperty(
        limitArb,
        fc.dictionary(fc.constantFrom("A", "B", "C", "D"), weightArb, {
          minKeys: 1,
          maxKeys: 4,
        }),
        fc.array(fc.tuple(fc.constantFrom("A", "B", "C", "D"), costArb), {
          minLength: 1,
          maxLength: 20,
        }),
        async (L, weights, calls) => {
          const clock = new ManualClock(1_700_000_000_000);
          const l1 = weightedFairEscrow({
            limit: L,
            windowMs: 60_000,
            weightOf: (t) => weights[t] ?? 1,
            clock,
          });
          // Unique L2 key per attempt so a parallel attempt's state can't bleed in. Counter-suffix
          // matches the fast-check shrink-trace pattern used in lua-property.test.ts.
          const key = `dual-redis:${L}:${Date.now()}:${Math.random()}`;
          const l2 = weightedFairEscrow({
            limit: L,
            windowMs: 60_000,
            weightOf: (t) => weights[t] ?? 1,
            l2: new RedisStore({ client, useServerTime: false }),
            quantum: L,
            l2Key: key,
            clock,
          });

          for (const [tenant, cost] of calls) {
            const r1 = l1.checkSync(tenant, cost);
            const r2 = await l2.check(tenant, cost);
            if (r1.allowed !== r2.allowed) return false;
          }
          const u1 = new Map(l1.stats().tenants.map((t) => [t.tenant, t.used]));
          const u2 = new Map(l2.stats().tenants.map((t) => [t.tenant, t.used]));
          if (u1.size !== u2.size) return false;
          for (const [k, v] of u1) if (u2.get(k) !== v) return false;
          return true;
        },
      ),
      { numRuns: 50 }, // Redis round-trips are slow; 50 here vs 200 for MemoryStore
    );
  }, 60_000);
});
