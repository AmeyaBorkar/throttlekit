import { ManualClock, TestConcurrencyCoordinator, ThrottleKitError } from "throttlekit";
import type { ConcurrencyCoordinator, DistributedConcurrencyGuard } from "throttlekit";
import { afterEach, describe, expect, it } from "vitest";
import { type ConcurrencyCoordinatorSpec, buildServiceConfig } from "../src/config.js";
import {
  OperationNotSupportedError,
  type RateLimiterService,
  createRateLimiterService,
} from "../src/service.js";

/**
 * Tier-1 distributed concurrency (the GALE concurrency axis, fleet-coordinated): a policy with a
 * `distributedConcurrency` block is a `distributedAdaptiveConcurrency` guard served over the EXISTING
 * `Admit` RPC (no client change, no wire change). Each instance heartbeats its local limit to a shared
 * {@link ConcurrencyCoordinator}, which folds the fleet's views into one `L_global` and hands each node its
 * share — so N instances admit under ONE global in-flight ceiling, not `Σ Lᵢ`.
 *
 * The coordinator is resolved by the runtime (`createStore`) for redis/postgres; here a shared in-memory
 * `TestConcurrencyCoordinator` (deterministic off the injected clock) models one shared backend without
 * external services. `heartbeatMs` is parked far in the future so the only heartbeats are the ones the test
 * drives explicitly (no background timer races); each built guard is `close()`d in `afterEach`.
 */

// A pinned-local-limit distributed concurrency policy: minLimit === maxLimit === `limit` makes each node's
// locally-inferred ceiling deterministic; the huge heartbeat parks the background timer.
const PINNED = (limit: number): string =>
  JSON.stringify({
    limiters: {
      cc: { distributedConcurrency: { minLimit: limit, maxLimit: limit, heartbeatMs: 3_600_000 } },
    },
  });

const toClose: DistributedConcurrencyGuard[] = [];
afterEach(async () => {
  // Stop the heartbeat timers + leave the fleet so nothing leaks across tests (idempotent + never-throw).
  await Promise.all(toClose.splice(0).map((g) => g.close()));
});

/** Build one "server instance" (service + its guard) over a shared coordinator + clock, with a node id. */
function instance(
  nodeId: string,
  coord: ConcurrencyCoordinator,
  clock: ManualClock,
  config = PINNED(8),
): { service: RateLimiterService; guard: DistributedConcurrencyGuard } {
  const sc = buildServiceConfig(config, {
    makeConcurrencyCoordinator: () => coord,
    nodeId,
    clock,
  });
  const guard = sc.guards.cc as DistributedConcurrencyGuard;
  toClose.push(guard);
  const service = createRateLimiterService({
    limiters: sc.limiters,
    admitters: sc.admitters,
    guards: sc.guards,
    clock,
  });
  return { service, guard };
}

/** Admit `key` against `cc` up to 20 times; return how many were allowed (admits hold their slots). */
async function admitUntilFull(service: RateLimiterService, key: string): Promise<number> {
  let allowed = 0;
  for (let i = 0; i < 20; i++) if ((await service.admit("cc", key)).decision.allowed) allowed++;
  return allowed;
}

describe("distributed concurrency (distributedConcurrency) policies via the service door", () => {
  it("builds a distributed guard and sizes the coordinator factory from the block (aggregate/prefix)", () => {
    let captured: ConcurrencyCoordinatorSpec | undefined;
    const coord = new TestConcurrencyCoordinator();
    const sc = buildServiceConfig(
      JSON.stringify({
        limiters: {
          cc: {
            distributedConcurrency: {
              minLimit: 4,
              maxLimit: 4,
              heartbeatMs: 3_600_000,
              aggregate: "min",
              prefix: "tk:test",
            },
          },
        },
      }),
      {
        makeConcurrencyCoordinator: (spec) => {
          captured = spec;
          return coord;
        },
        nodeId: "n1",
      },
    );
    expect(Object.keys(sc.admitters)).toEqual(["cc"]); // an admitter, served by `admit`
    const guard = sc.guards.cc as DistributedConcurrencyGuard;
    toClose.push(guard);
    // It is the DISTRIBUTED guard (heartbeat + close), not the in-process one.
    expect(typeof guard.heartbeat).toBe("function");
    expect(typeof guard.close).toBe("function");
    // The coordinator knobs (aggregate/prefix) flow to the factory; the tuning fields ride into `local`.
    expect(captured).toEqual({ aggregate: "min", prefix: "tk:test" });
  });

  it("two instances over one coordinator hold ONE global ceiling (not Σ per-instance)", async () => {
    const clock = new ManualClock(0);
    const coord = new TestConcurrencyCoordinator({ aggregate: "min", clock });
    const a = instance("node-a", coord, clock);
    const b = instance("node-b", coord, clock);
    // Register both + settle the split: aggregate(min) of {8,8} = 8, equal-split across 2 nodes → 4 each.
    // Two rounds so each node re-syncs its share after the other has registered.
    await a.guard.heartbeat();
    await b.guard.heartbeat();
    await a.guard.heartbeat();
    await b.guard.heartbeat();

    const aAllowed = await admitUntilFull(a.service, "ka");
    const bAllowed = await admitUntilFull(b.service, "kb");
    // ONE global ceiling of 8 across BOTH instances — never 8 per instance (= 16 uncoordinated).
    expect(aAllowed + bAllowed).toBeLessThanOrEqual(8);
    expect(aAllowed + bAllowed).toBeLessThan(16);
    // …and coordination granted (most of) the budget, not near-zero — each node admits its share.
    expect(aAllowed).toBeGreaterThan(0);
    expect(bAllowed).toBeGreaterThan(0);
    expect(aAllowed + bAllowed).toBeGreaterThanOrEqual(6);
  });

  it("a single instance admits up to its full local limit (alone in the fleet)", async () => {
    const clock = new ManualClock(0);
    const coord = new TestConcurrencyCoordinator({ clock });
    const a = instance("solo", coord, clock, PINNED(4));
    await a.guard.heartbeat(); // alone → lGlobal = 4, share = 4
    expect(await admitUntilFull(a.service, "k")).toBe(4);
  });

  it("service.close() leaves the fleet gracefully and is idempotent", async () => {
    const clock = new ManualClock(0);
    const coord = new TestConcurrencyCoordinator({ clock });
    const a = instance("node-a", coord, clock, PINNED(4));
    await a.guard.heartbeat();
    expect(coord.peek("cc").shares["node-a"]).toBeGreaterThan(0); // registered in the fleet
    await a.service.close?.();
    expect(coord.peek("cc").shares["node-a"]).toBeUndefined(); // left the fleet (share reclaimed)
    await a.service.close?.(); // idempotent — a second close must not throw
  });

  it("errors when no coordinator store is configured (memory / dynamodb cannot coordinate)", () => {
    expect(() => buildServiceConfig(PINNED(4), { nodeId: "n1" })).toThrow(ThrottleKitError);
    expect(() => buildServiceConfig(PINNED(4), { nodeId: "n1" })).toThrow(
      /shared coordinator store/,
    );
  });

  it("errors when no node id is configured (a collision would corrupt the fleet aggregate)", () => {
    const make = (): ConcurrencyCoordinator => new TestConcurrencyCoordinator();
    expect(() => buildServiceConfig(PINNED(4), { makeConcurrencyCoordinator: make })).toThrow(
      /node id/,
    );
  });

  it("check / debit on a distributedConcurrency policy are UNIMPLEMENTED (it is an admitter)", async () => {
    const { service } = instance("n1", new TestConcurrencyCoordinator(), new ManualClock(0));
    await expect(service.check("cc", "k")).rejects.toBeInstanceOf(OperationNotSupportedError);
    await expect(service.debit("cc", "k")).rejects.toBeInstanceOf(OperationNotSupportedError);
  });

  it("coexists with a plain rate-limit policy in one config (delegation unbroken)", async () => {
    const clock = new ManualClock(0);
    const coord = new TestConcurrencyCoordinator({ clock });
    const cfg = JSON.stringify({
      limiters: {
        plain: { strategy: "gcra", limit: 5, period: 1000, burst: 5 },
        cc: { distributedConcurrency: { minLimit: 4, maxLimit: 4, heartbeatMs: 3_600_000 } },
      },
    });
    const sc = buildServiceConfig(cfg, {
      makeConcurrencyCoordinator: () => coord,
      nodeId: "n1",
      clock,
    });
    const guard = sc.guards.cc as DistributedConcurrencyGuard;
    toClose.push(guard);
    const service = createRateLimiterService({
      limiters: sc.limiters,
      admitters: sc.admitters,
      guards: sc.guards,
      clock,
    });
    expect(new Set(service.policies())).toEqual(new Set(["plain", "cc"]));

    let plain = 0;
    for (let i = 0; i < 10; i++) if ((await service.check("plain", "k")).allowed) plain++;
    expect(plain).toBe(5); // plain gcra is unchanged

    await guard.heartbeat();
    expect(await admitUntilFull(service, "k")).toBe(4); // its own coordinated ceiling
  });

  it("rejects a policy declaring both distributedConcurrency and another kind (mutually exclusive)", () => {
    const bad = JSON.stringify({
      limiters: { x: { distributedConcurrency: { minLimit: 1 }, concurrency: { minLimit: 1 } } },
    });
    expect(() => buildServiceConfig(bad, {})).toThrow(/at most one of/);
  });
});
