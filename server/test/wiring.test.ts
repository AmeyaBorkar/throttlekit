import { ManualClock } from "throttlekit";
import { describe, expect, it } from "vitest";
import { buildServiceConfig } from "../src/config.js";
import { wireMonitor } from "../src/monitor/wire.js";
import { OperationNotSupportedError, createRateLimiterServiceFromConfig } from "../src/service.js";

/**
 * Server-side wiring for the two policy kinds that aren't plain `Limiter`s: weighted-fair-escrow (served
 * by `check`, key = tenant) and the concurrency guard a unified admitter encapsulates (surfaced to the
 * dashboard). Proves they reach the service door and the telemetry hub.
 */
describe("fair-escrow over the service door (#284)", () => {
  const config = JSON.stringify({
    limiters: {
      "fair-api": { fairEscrow: { limit: 4, windowMs: 60_000, weights: { vip: 3, free: 1 } } },
    },
  });

  it("builds a fairEscrow policy into the `fairness` bucket, not limiters/meters/admitters", () => {
    const built = buildServiceConfig(config);
    expect(Object.keys(built.fairness)).toEqual(["fair-api"]);
    expect(built.limiters["fair-api"]).toBeUndefined();
    expect(built.admitters["fair-api"]).toBeUndefined();
  });

  it("routes `check` to the WFE oracle with tenant semantics — and weights the split (vip > free)", async () => {
    const clock = new ManualClock(0); // pin the window so the budget doesn't roll mid-test
    const service = createRateLimiterServiceFromConfig(config, { clock });
    expect(service.policies()).toContain("fair-api");

    let vip = 0;
    let free = 0;
    for (let i = 0; i < 8; i++) {
      if ((await service.check("fair-api", "vip")).allowed) vip++;
      if ((await service.check("fair-api", "free")).allowed) free++;
    }
    expect(vip + free).toBeLessThanOrEqual(4); // the shared budget L is respected
    expect(vip).toBeGreaterThan(0);
    expect(vip).toBeGreaterThan(free); // weight 3 vs 1
  });

  it("rejects ops a fair policy can't serve with OperationNotSupportedError (not NOT_FOUND)", async () => {
    const service = createRateLimiterServiceFromConfig(config);
    await expect(service.peek("fair-api", "vip")).rejects.toBeInstanceOf(
      OperationNotSupportedError,
    );
    await expect(service.admit("fair-api", "vip")).rejects.toBeInstanceOf(
      OperationNotSupportedError,
    );
    await expect(service.debit("fair-api", "vip")).rejects.toBeInstanceOf(
      OperationNotSupportedError,
    );
  });

  it("surfaces a fair policy's per-tenant stats to the hub for the Fairness view", async () => {
    const { service, hub } = wireMonitor(config, {}, "open", "memory");
    await service.check("fair-api", "vip");
    const wfe = hub.snapshot().stats.find((s) => s.name === "fair-api");
    expect(wfe?.kind).toBe("wfe");
    expect((wfe?.value as { tenants: unknown[] }).tenants.length).toBeGreaterThan(0);
  });

  it("rejects a spec that declares more than one kind block (fairEscrow + concurrency)", () => {
    const bad = JSON.stringify({
      limiters: { x: { fairEscrow: { limit: 4, windowMs: 1000 }, concurrency: { minLimit: 1 } } },
    });
    expect(() => buildServiceConfig(bad)).toThrow(/at most one/);
  });

  it("rejects a non-positive tenant weight at build time (not a silent fail-open at check)", () => {
    const bad = JSON.stringify({
      limiters: { "fair-api": { fairEscrow: { limit: 4, windowMs: 1000, weights: { free: 0 } } } },
    });
    expect(() => buildServiceConfig(bad)).toThrow(/weight must be a positive number/);
  });

  it("bounds the per-tenant map to maxKeys (untrusted-key growth defense)", async () => {
    const cfg = JSON.stringify({
      limiters: { "fair-api": { fairEscrow: { limit: 100, windowMs: 60_000, maxKeys: 2 } } },
    });
    const { service, hub } = wireMonitor(cfg, {}, "open", "memory");
    for (const t of ["t1", "t2", "t3"]) await service.check("fair-api", t);
    const wfe = hub.snapshot().stats.find((s) => s.name === "fair-api");
    expect((wfe?.value as { tenants: unknown[] }).tenants.length).toBeLessThanOrEqual(2);
  });
});

describe("admitter guard surfaced to the dashboard (#285)", () => {
  const config = JSON.stringify({
    limiters: { "api-conc": { concurrency: { minLimit: 4, maxLimit: 4 } } },
  });

  it("builds the encapsulated guard into the `guards` bucket alongside the admitter", () => {
    const built = buildServiceConfig(config);
    expect(Object.keys(built.admitters)).toEqual(["api-conc"]);
    expect(Object.keys(built.guards)).toEqual(["api-conc"]);
  });

  it("wireMonitor tracks the guard, and its live inflight reflects service admits", async () => {
    const { service, hub } = wireMonitor(config, {}, "open", "memory");
    const before = hub.snapshot();
    expect(before.guards.map((g) => g.name)).toContain("api-conc");
    expect(before.guards.find((g) => g.name === "api-conc")?.inflight).toBe(0);

    const a = await service.admit("api-conc", "k");
    expect(a.decision.allowed).toBe(true);
    expect(hub.snapshot().guards.find((g) => g.name === "api-conc")?.inflight).toBe(1);

    service.release(a.leaseId);
    expect(hub.snapshot().guards.find((g) => g.name === "api-conc")?.inflight).toBe(0);
  });
});
