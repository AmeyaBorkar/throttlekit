import { ManualClock, MemoryStore, gcra } from "throttlekit";
import { twoTier } from "throttlekit/twotier";
import { describe, expect, it } from "vitest";
import { buildLimitersFromConfig } from "../src/config.js";
import { OperationNotSupportedError, createRateLimiterServiceFromConfig } from "../src/service.js";

/**
 * Door A: a policy may carry a `twoTier` block so the service serves it as a two-tier *leased* limiter
 * (L1-local credits drawn in batches from a shared L2). The decision is still the core's — these tests
 * pin that the service builds and serves it, that it coexists with plain rate-limit policies, and that
 * the shared L2 caps the global budget (the "many instances, one limit" promise).
 */

// A single leased policy: gcra(limit 12, burst 12) at L2, leased to L1 in batches of 4.
const LEASED = JSON.stringify({
  limiters: {
    leased: {
      strategy: "gcra",
      limit: 12,
      period: 1000,
      burst: 12,
      twoTier: { mode: "leased", batch: 4 },
    },
  },
});

describe("two-tier leased policies via the service door", () => {
  it("builds a leased policy from config and never overshoots the shared L2 budget", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore();
    const service = createRateLimiterServiceFromConfig(LEASED, { store, clock });
    expect(service.policies()).toEqual(["leased"]);

    let allowed = 0;
    for (let i = 0; i < 30; i++) {
      if ((await service.check("leased", "user")).allowed) allowed++;
    }
    // L2 gcra(limit 12, burst 12) at a frozen clock admits exactly 12; leasing in batches of 4 (12 is a
    // multiple of 4, so no stranding) draws the budget fully and never beyond it.
    expect(allowed).toBe(12);
  });

  it("coexists with a plain rate-limit policy in one config (delegation unbroken)", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore();
    const yaml = JSON.stringify({
      limiters: {
        plain: { strategy: "gcra", limit: 5, period: 1000, burst: 5 },
        leased: {
          strategy: "gcra",
          limit: 8,
          period: 1000,
          burst: 8,
          twoTier: { mode: "leased", batch: 4 },
        },
      },
    });
    const service = createRateLimiterServiceFromConfig(yaml, { store, clock });
    expect(new Set(service.policies())).toEqual(new Set(["plain", "leased"]));

    let plainAllowed = 0;
    for (let i = 0; i < 10; i++) if ((await service.check("plain", "k")).allowed) plainAllowed++;
    expect(plainAllowed).toBe(5); // plain gcra is unchanged

    let leasedAllowed = 0;
    for (let i = 0; i < 20; i++) if ((await service.check("leased", "k")).allowed) leasedAllowed++;
    expect(leasedAllowed).toBe(8); // its own L2 budget of 8
  });

  it("multiple instances over one shared L2 hold a single global budget", async () => {
    // Three two-tier limiters = three server instances pointed at one Redis (here, one MemoryStore L2),
    // all serving the same policy (so the same prefix/key). The shared L2 caps total draws at the limit.
    const clock = new ManualClock(0);
    const l2 = new MemoryStore();
    const strategy = gcra({ limit: 12, periodMs: 1000, burst: 12 });
    const nodes = [0, 1, 2].map(() =>
      twoTier({ strategy, l2, mode: "leased", lease: { batch: 4 }, clock }),
    );

    let allowed = 0;
    for (let i = 0; i < 60; i++) {
      if ((await nodes[i % nodes.length].check("hot")).allowed) allowed++;
    }
    expect(allowed).toBe(12); // no overshoot across the "fleet" — one shared limit
  });

  it("falls back to a private in-process L2 when no shared store is configured (single instance)", async () => {
    const clock = new ManualClock(0);
    const limiters = buildLimitersFromConfig(LEASED, { clock }); // no store → private memory L2
    expect(Object.keys(limiters)).toEqual(["leased"]);
    let allowed = 0;
    for (let i = 0; i < 30; i++) if ((await limiters.leased.check("k")).allowed) allowed++;
    expect(allowed).toBe(12); // still serves and respects its own budget
  });

  it("peek on a two-tier policy is UNIMPLEMENTED (it is consume-only over the wire)", async () => {
    const store = new MemoryStore();
    const service = createRateLimiterServiceFromConfig(LEASED, { store });
    await expect(service.peek("leased", "k")).rejects.toBeInstanceOf(OperationNotSupportedError);
  });
});
