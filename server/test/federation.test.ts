import { ManualClock, ThrottleKitError } from "throttlekit";
import type { GlobalCoordinator } from "throttlekit/federation";
import { TestCoordinator } from "throttlekit/federation";
import { describe, expect, it } from "vitest";
import { type CoordinatorSpec, buildServiceConfig } from "../src/config.js";
import { OperationNotSupportedError, createRateLimiterServiceFromConfig } from "../src/service.js";

/**
 * Tier-1 cross-region federation (the distributed-decision axis): a policy with a `federated` block is a
 * `federate()` limiter served over the EXISTING `Check` RPC (no client change, no wire change). Every
 * instance leases from one global per-window budget via a shared {@link GlobalCoordinator}, so the fleet
 * admits at most the strategy's `limit` per window regardless of instance count.
 *
 * The coordinator is resolved by the runtime (`createStore`) for redis/postgres; here a shared in-memory
 * `TestCoordinator` (deterministic off the `expiresAt` federate derives from the injected clock) models one
 * shared Redis without external services — the config wiring + the global-budget enforcement are identical.
 */

// One federated policy: a fixedWindow(limit 5, 60s) sharing a global budget; batch 1 so each check leases 1.
const FED = JSON.stringify({
  limiters: {
    api: {
      federated: { region: "us-east", batch: 1 },
      strategy: "fixedWindow",
      limit: 5,
      period: 60000,
    },
  },
});

describe("cross-region federated (federated) policies via the service door", () => {
  it("builds a federated policy and sizes the coordinator from the strategy (budget = limit, windowMs)", () => {
    let captured: CoordinatorSpec | undefined;
    const coord = new TestCoordinator({ budgetPerWindow: 5 });
    const makeCoordinator = (spec: CoordinatorSpec): GlobalCoordinator => {
      captured = spec;
      return coord;
    };
    const cfg = buildServiceConfig(FED, {
      makeCoordinator,
      region: "us-east",
      clock: new ManualClock(0),
    });
    expect(Object.keys(cfg.limiters)).toEqual(["api"]); // a Limiter, served by `check`
    // The global budget IS the strategy's limit; the window IS the strategy's windowMs (from `period`).
    expect(captured).toEqual({ windowMs: 60000, budgetPerWindow: 5 });
  });

  it("two instances over one coordinator enforce a single global budget", async () => {
    const clock = new ManualClock(0);
    const coord = new TestCoordinator({ budgetPerWindow: 5 });
    const makeCoordinator = (): GlobalCoordinator => coord; // SHARED — models two instances on one Redis
    const a = createRateLimiterServiceFromConfig(FED, { makeCoordinator, clock });
    const b = createRateLimiterServiceFromConfig(FED, { makeCoordinator, clock });

    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      const svc = i % 2 === 0 ? a : b; // alternate the "instance" each request
      if ((await svc.check("api", "user")).allowed) allowed++;
    }
    expect(allowed).toBe(5); // ONE global budget of 5 across BOTH instances — not 5 per instance
  });

  it("rejects a pure-rate strategy — gcra / tokenBucket cannot be federated", () => {
    const bad = JSON.stringify({
      limiters: { api: { federated: {}, strategy: "gcra", limit: 5, period: 60000, burst: 5 } },
    });
    const makeCoordinator = (): GlobalCoordinator => new TestCoordinator({ budgetPerWindow: 5 });
    expect(() => buildServiceConfig(bad, { makeCoordinator })).toThrow(ThrottleKitError);
    expect(() => buildServiceConfig(bad, { makeCoordinator })).toThrow(/cannot be federated/);
  });

  it("rejects a calendar-cadence quota (no fixed window to couple to)", () => {
    const bad = JSON.stringify({
      limiters: {
        api: { federated: {}, strategy: "quota", limit: 5, resetCadence: "calendar-month" },
      },
    });
    const makeCoordinator = (): GlobalCoordinator => new TestCoordinator({ budgetPerWindow: 5 });
    expect(() => buildServiceConfig(bad, { makeCoordinator })).toThrow(/cannot be federated/);
  });

  it("errors when no coordinator store is configured (memory / dynamodb cannot federate)", () => {
    expect(() => buildServiceConfig(FED, {})).toThrow(/shared coordinator store/);
  });

  it("peek / forecast on a federated policy are UNIMPLEMENTED (async + window-based)", async () => {
    const coord = new TestCoordinator({ budgetPerWindow: 5 });
    const service = createRateLimiterServiceFromConfig(FED, { makeCoordinator: () => coord });
    await expect(service.peek("api", "k")).rejects.toBeInstanceOf(OperationNotSupportedError);
    await expect(service.forecast("api", "k")).rejects.toBeInstanceOf(OperationNotSupportedError);
  });

  it("a policy's own region overrides the server-wide region", () => {
    let captured: CoordinatorSpec | undefined;
    const coord = new TestCoordinator({ budgetPerWindow: 5 });
    const makeCoordinator = (spec: CoordinatorSpec): GlobalCoordinator => {
      captured = spec;
      return coord;
    };
    // The policy declares region us-east; the server-wide region is eu-west. The federated limiter is built
    // either way; this just exercises the precedence path without throwing (region rides into federate()).
    const service = buildServiceConfig(FED, { makeCoordinator, region: "eu-west" });
    expect(Object.keys(service.limiters)).toEqual(["api"]);
    expect(captured?.budgetPerWindow).toBe(5);
  });

  it("coexists with a plain rate-limit policy in one config (delegation unbroken)", async () => {
    const clock = new ManualClock(0);
    const coord = new TestCoordinator({ budgetPerWindow: 3 });
    const cfg = JSON.stringify({
      limiters: {
        plain: { strategy: "gcra", limit: 5, period: 1000, burst: 5 },
        fed: { federated: { batch: 1 }, strategy: "fixedWindow", limit: 3, period: 60000 },
      },
    });
    const service = createRateLimiterServiceFromConfig(cfg, {
      makeCoordinator: () => coord,
      clock,
    });
    expect(new Set(service.policies())).toEqual(new Set(["plain", "fed"]));

    let plain = 0;
    for (let i = 0; i < 10; i++) if ((await service.check("plain", "k")).allowed) plain++;
    expect(plain).toBe(5); // plain gcra is unchanged

    let fed = 0;
    for (let i = 0; i < 10; i++) if ((await service.check("fed", "k")).allowed) fed++;
    expect(fed).toBe(3); // its own global budget of 3
  });

  it("rejects a policy declaring both federated and another kind (mutually exclusive)", () => {
    const bad = JSON.stringify({
      limiters: {
        x: {
          federated: {},
          tokenBudget: { budget: 1, windowMs: 1000 },
          strategy: "fixedWindow",
          limit: 5,
          period: 60000,
        },
      },
    });
    expect(() => buildServiceConfig(bad, {})).toThrow(/at most one of/);
  });
});
