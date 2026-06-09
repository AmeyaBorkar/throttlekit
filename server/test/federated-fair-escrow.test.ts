import { ManualClock, ThrottleKitError } from "throttlekit";
import type { AsyncRegionFairPool } from "throttlekit/twotier";
import { testRegionFairPool } from "throttlekit/twotier";
import { describe, expect, it } from "vitest";
import { type RegionFairPoolSpec, buildServiceConfig } from "../src/config.js";
import {
  OperationNotSupportedError,
  type RateLimiterService,
  createRateLimiterService,
} from "../src/service.js";

/**
 * Tier-1 cross-region fair escrow (the 4th-of-4 distributed feature, P4): a policy with a
 * `federatedFairEscrow` block is the core's `federatedWeightedFairEscrow` over a store-backed region pool,
 * served over the EXISTING `Check` RPC (key = tenant; no client change, no wire change). A shared pool
 * reserves each region a weighted-max-min slice of one GLOBAL budget `L`, so N region instances admit a
 * total ≤ `L` — never `Σ Lᵢ`.
 *
 * The pool is resolved by the runtime (`createStore`) as a `RedisRegionFairPool` for redis; here an in-process
 * `testRegionFairPool` (the core's async pool, byte-identical to the Redis Lua) models one shared backend
 * deterministically off the injected clock — no Redis required. Sharing ONE pool instance across two
 * "instances" models two server processes coordinating through one store key.
 */

const L = 12;
const WINDOW = 10_000;
const T0 = WINDOW * 100; // window-aligned, non-zero base

/** A `federatedFairEscrow` policy "fe" over the global budget `L`, with optional per-tenant weights. */
const FE = (weights?: Record<string, number>): string =>
  JSON.stringify({
    limiters: {
      fe: {
        federatedFairEscrow: { limit: L, windowMs: WINDOW, ...(weights ? { weights } : {}) },
      },
    },
  });

/** One "server instance": a service whose `fe` policy draws from `pool`, identified by `region`. */
function instance(
  region: string,
  pool: AsyncRegionFairPool,
  clock: ManualClock,
  config = FE(),
): { service: RateLimiterService; fairness: ReturnType<typeof buildServiceConfig>["fairness"] } {
  const sc = buildServiceConfig(config, { makeRegionFairPool: () => pool, region, clock });
  const service = createRateLimiterService({
    limiters: sc.limiters,
    fairLimiters: sc.fairness,
    clock,
  });
  return { service, fairness: sc.fairness };
}

/** Drive `tenant` against the `fe` policy (cost 1) until denied; return how many were admitted. */
async function admitUntilFull(
  service: RateLimiterService,
  tenant: string,
  cap = 100,
): Promise<number> {
  let allowed = 0;
  for (let i = 0; i < cap; i++) if ((await service.check("fe", tenant)).allowed) allowed++;
  return allowed;
}

/**
 * Drive several `(service, tenant)` arms ROUND-ROBIN for `rounds` rounds; return each arm's admitted count.
 * Interleaving keeps every party concurrently active when the streaming fair-share is recomputed — which is
 * what exercises the *weighted split*. (Draining one arm fully before the next instead measures greedy
 * work-conservation: the first backlogged party legitimately takes the idle budget before a later one shows
 * up, the documented streaming-vs-batch T3 trade-off — so a sequential drive is the wrong tool for fairness.)
 */
async function admitInterleaved(
  rounds: number,
  ...arms: Array<{ service: RateLimiterService; tenant: string }>
): Promise<number[]> {
  const counts = arms.map(() => 0);
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < arms.length; i++) {
      if ((await arms[i].service.check("fe", arms[i].tenant)).allowed) counts[i]++;
    }
  }
  return counts;
}

describe("cross-region fair escrow (federatedFairEscrow) policies via the service door", () => {
  it("builds a fairness policy served by `check` (not a limiter / meter / admitter)", async () => {
    const clock = new ManualClock(T0);
    const pool = testRegionFairPool({ limit: L, windowMs: WINDOW, clock });
    const { service, fairness } = instance("us", pool, clock);
    expect(Object.keys(fairness)).toEqual(["fe"]); // a fairness entry, served by `check`
    expect(service.policies()).toEqual(["fe"]);
    // It serves over `check` (key = tenant)…
    expect((await service.check("fe", "tenant-a")).allowed).toBe(true);
    // …and rejects the meter/admitter ops, exactly like the L1 fairEscrow.
    await expect(service.debit("fe", "tenant-a")).rejects.toBeInstanceOf(
      OperationNotSupportedError,
    );
    await expect(service.admit("fe", "tenant-a")).rejects.toBeInstanceOf(
      OperationNotSupportedError,
    );
  });

  it("sizes the region-pool factory from the block (limit / windowMs / key / prefix)", () => {
    let captured: RegionFairPoolSpec | undefined;
    const pool = testRegionFairPool({ limit: L, windowMs: WINDOW, clock: new ManualClock(T0) });
    buildServiceConfig(
      JSON.stringify({
        limiters: {
          fe: {
            federatedFairEscrow: {
              limit: L,
              windowMs: WINDOW,
              key: "shared-budget",
              prefix: "tk:test",
            },
          },
        },
      }),
      {
        makeRegionFairPool: (spec) => {
          captured = spec;
          return pool;
        },
        region: "us",
      },
    );
    expect(captured?.limit).toBe(L);
    expect(captured?.windowMs).toBe(WINDOW);
    expect(captured?.key).toBe("shared-budget");
    expect(captured?.prefix).toBe("tk:test");
  });

  it("defaults the pool key to the policy name (so same-config instances coordinate automatically)", () => {
    let key: string | undefined;
    buildServiceConfig(FE(), {
      makeRegionFairPool: (spec) => {
        key = spec.key;
        return testRegionFairPool({ limit: L, windowMs: WINDOW });
      },
      region: "us",
    });
    expect(key).toBe("fe"); // the policy name
  });

  it("HERO: two regions over ONE shared pool admit ≤ L globally and split it ~evenly", async () => {
    const clock = new ManualClock(T0);
    const pool = testRegionFairPool({ limit: L, windowMs: WINDOW, clock });
    const us = instance("us", pool, clock);
    const eu = instance("eu", pool, clock);
    // Both regions are backlogged and active concurrently ⇒ the shared pool splits L weighted-max-min
    // across the two equal-weight regions → ~6 each, Σ ≤ L.
    const [usAllowed, euAllowed] = await admitInterleaved(
      20,
      { service: us.service, tenant: "u" },
      { service: eu.service, tenant: "e" },
    );
    expect(usAllowed + euAllowed).toBeLessThanOrEqual(L); // the global safety bound (the whole point)
    expect(usAllowed).toBeGreaterThan(0); // neither region starved
    expect(euAllowed).toBeGreaterThan(0);
    expect(Math.abs(usAllowed - euAllowed)).toBeLessThanOrEqual(2); // ~even split (6/6)
    expect(usAllowed + euAllowed).toBeGreaterThanOrEqual(L - 1); // work-conserving: ~all of L used
  });

  it("the global bound Σ ≤ L holds even under adversarial ordering (one region drains first)", async () => {
    const clock = new ManualClock(T0);
    const pool = testRegionFairPool({ limit: L, windowMs: WINDOW, clock });
    const us = instance("us", pool, clock);
    const eu = instance("eu", pool, clock);
    // us drains greedily while alone (legitimately taking the whole idle budget); eu then gets only what's
    // left. The split is unfair under this ordering — but the SAFETY bound never breaks: Σ ≤ L.
    const usAllowed = await admitUntilFull(us.service, "u");
    const euAllowed = await admitUntilFull(eu.service, "e");
    expect(usAllowed + euAllowed).toBeLessThanOrEqual(L);
    expect(usAllowed).toBeGreaterThan(0);
  });

  it("CONTRAST: two regions over SEPARATE pools each grant L (the uncoordinated ~2·L over-admit)", async () => {
    const clock = new ManualClock(T0);
    // No shared store ⇒ each instance has its own pool; each region believes it owns the whole budget.
    const us = instance("us", testRegionFairPool({ limit: L, windowMs: WINDOW, clock }), clock);
    const eu = instance("eu", testRegionFairPool({ limit: L, windowMs: WINDOW, clock }), clock);
    const [usAllowed, euAllowed] = await admitInterleaved(
      20,
      { service: us.service, tenant: "u" },
      { service: eu.service, tenant: "e" },
    );
    // Uncoordinated: each region admits up to L → Σ = 2·L. This is exactly what the shared pool prevents.
    expect(usAllowed).toBe(L);
    expect(euAllowed).toBe(L);
    expect(usAllowed + euAllowed).toBe(2 * L);
  });

  it("splits the global budget fairly by region weight (Σ active tenant weights)", async () => {
    const clock = new ManualClock(T0);
    const pool = testRegionFairPool({ limit: L, windowMs: WINDOW, clock });
    // Region "big" runs one weight-3 tenant; region "small" one weight-1 tenant → region weights 3:1.
    const weights = { big: 3, small: 1 };
    const bigInst = instance("big-region", pool, clock, FE(weights));
    const smallInst = instance("small-region", pool, clock, FE(weights));
    const [big, small] = await admitInterleaved(
      20,
      { service: bigInst.service, tenant: "big" },
      { service: smallInst.service, tenant: "small" },
    );
    expect(big + small).toBeLessThanOrEqual(L); // safety holds regardless of weights
    expect(big).toBeGreaterThanOrEqual(2 * small); // ~3:1 weighted split (big ≈ 9, small ≈ 3)
    expect(small).toBeGreaterThan(0); // the light region keeps its guaranteed slice
  });

  it("a single region alone splits the whole global budget across its own tenants", async () => {
    const clock = new ManualClock(T0);
    const pool = testRegionFairPool({ limit: L, windowMs: WINDOW, clock });
    const solo = instance("solo", pool, clock);
    // One region, two equal-weight tenants concurrently backlogged → they split the region's full L slice.
    const [a, b] = await admitInterleaved(
      20,
      { service: solo.service, tenant: "a" },
      { service: solo.service, tenant: "b" },
    );
    expect(a + b).toBe(L); // alone in the fleet → the region's slice is the full L
    expect(Math.abs(a - b)).toBeLessThanOrEqual(2); // ~even split (6/6)
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
  });

  it("exposes adapted L1-shaped stats() (effectiveLimit = the region's granted slice; Cost Room intact)", async () => {
    const clock = new ManualClock(T0);
    const pool = testRegionFairPool({ limit: L, windowMs: WINDOW, clock });
    const { service, fairness } = instance("us", pool, clock);
    await admitUntilFull(service, "a");
    const s = fairness.fe.stats();
    // The federated limiter is adapted to the WeightedFairEscrowLimiter shape the monitor/Cost Room read.
    expect(s.limit).toBe(L); // the global budget (constant)
    expect(s.effectiveLimit).toBeGreaterThan(0); // = regionBudget: this region's granted slice
    expect(s.effectiveLimit).toBeLessThanOrEqual(L);
    expect(s.pool).toBe(Math.max(0, s.effectiveLimit - s.totalUsed));
    expect(s.tenants.map((t) => t.tenant)).toContain("a"); // per-tenant roster for the Fairness view
    expect(s.totalUsed).toBeGreaterThan(0);
  });

  it("the policy's own `region` overrides the server-wide region", () => {
    const seen: string[] = [];
    const pool: AsyncRegionFairPool = {
      isAsync: true,
      limit: L,
      windowMs: WINDOW,
      clock: new ManualClock(T0),
      grant: (region) => {
        seen.push(region);
        return Promise.resolve(L);
      },
      release: () => Promise.resolve(),
      stats: () => Promise.resolve({ windowStart: T0, limit: L, totalGranted: 0, regions: [] }),
    };
    const cfg = JSON.stringify({
      limiters: {
        fe: { federatedFairEscrow: { limit: L, windowMs: WINDOW, region: "policy-region" } },
      },
    });
    const sc = buildServiceConfig(cfg, { makeRegionFairPool: () => pool, region: "server-region" });
    return sc.fairness.fe.check("t").then(() => {
      expect(seen).toContain("policy-region"); // the block's region wins over the --region default
      expect(seen).not.toContain("server-region");
    });
  });

  it("errors clearly when no region-pool store is configured (memory / postgres / dynamodb)", () => {
    expect(() => buildServiceConfig(FE(), { region: "us" })).toThrow(ThrottleKitError);
    expect(() => buildServiceConfig(FE(), { region: "us" })).toThrow(/region-fair-pool store/);
    // The message points at the single-instance alternative.
    expect(() => buildServiceConfig(FE(), { region: "us" })).toThrow(/fairEscrow/);
  });

  it("validates per-tenant weights up front (a config bug must not be swallowed by the fail mode)", () => {
    const bad = JSON.stringify({
      limiters: {
        fe: { federatedFairEscrow: { limit: L, windowMs: WINDOW, weights: { t: 0 } } },
      },
    });
    expect(() =>
      buildServiceConfig(bad, {
        makeRegionFairPool: () => testRegionFairPool({ limit: L, windowMs: WINDOW }),
        region: "us",
      }),
    ).toThrow(/federatedFairEscrow\.weights\[t\]/);
  });

  it("requires limit and windowMs", () => {
    const bad = JSON.stringify({ limiters: { fe: { federatedFairEscrow: { limit: L } } } });
    expect(() =>
      buildServiceConfig(bad, {
        makeRegionFairPool: () => testRegionFairPool({ limit: L, windowMs: WINDOW }),
        region: "us",
      }),
    ).toThrow(/both `limit` and `windowMs` are required/);
  });

  it("wires a Cost Room by default and honours the per-policy opt-out + bound validation", () => {
    const make = () => testRegionFairPool({ limit: L, windowMs: WINDOW });
    // Default-on: a costRooms entry for the policy, enabled, carrying the window.
    const on = buildServiceConfig(FE(), { makeRegionFairPool: make, region: "us" });
    expect(on.costRooms.fe.enabled).toBe(true);
    expect(on.costRooms.fe.windowMs).toBe(WINDOW);
    // Opt-out.
    const off = buildServiceConfig(
      JSON.stringify({
        limiters: {
          fe: { federatedFairEscrow: { limit: L, windowMs: WINDOW, costRoom: false } },
        },
      }),
      { makeRegionFairPool: make, region: "us" },
    );
    expect(off.costRooms.fe.enabled).toBe(false);
    // A bad Cost Room bound fails fast, labelled to the right block.
    const bad = JSON.stringify({
      limiters: {
        fe: { federatedFairEscrow: { limit: L, windowMs: WINDOW, costRoomMaxKeys: -1 } },
      },
    });
    expect(() => buildServiceConfig(bad, { makeRegionFairPool: make, region: "us" })).toThrow(
      /federatedFairEscrow\.costRoomMaxKeys/,
    );
  });

  it("rejects a policy declaring federatedFairEscrow and another kind (mutually exclusive)", () => {
    const bad = JSON.stringify({
      limiters: {
        x: {
          federatedFairEscrow: { limit: L, windowMs: WINDOW },
          fairEscrow: { limit: L, windowMs: WINDOW },
        },
      },
    });
    expect(() => buildServiceConfig(bad, {})).toThrow(/at most one of/);
  });

  it("coexists with a plain rate-limit policy in one config (delegation unbroken)", async () => {
    const clock = new ManualClock(T0);
    const pool = testRegionFairPool({ limit: L, windowMs: WINDOW, clock });
    const cfg = JSON.stringify({
      limiters: {
        plain: { strategy: "gcra", limit: 5, period: 1000, burst: 5 },
        fe: { federatedFairEscrow: { limit: L, windowMs: WINDOW } },
      },
    });
    const sc = buildServiceConfig(cfg, { makeRegionFairPool: () => pool, region: "us", clock });
    const service = createRateLimiterService({
      limiters: sc.limiters,
      fairLimiters: sc.fairness,
      clock,
    });
    expect(new Set(service.policies())).toEqual(new Set(["plain", "fe"]));
    let plain = 0;
    for (let i = 0; i < 10; i++) if ((await service.check("plain", "k")).allowed) plain++;
    expect(plain).toBe(5); // plain gcra is unchanged
    expect(await admitUntilFull(service, "a")).toBeGreaterThan(0); // the fair policy serves too
  });
});
