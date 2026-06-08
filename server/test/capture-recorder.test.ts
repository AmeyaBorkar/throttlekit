import type { Decision } from "throttlekit";
import { describe, expect, it } from "vitest";
import { projectToReplayTrace } from "../src/capture/projection.js";
import { createCaptureRecorder } from "../src/capture/recorder.js";
import type { CaptureConfig, RetentionConfig, TenantRule } from "../src/capture/types.js";

/**
 * #289 Replay P3 (Phase B) — P3.2: the in-memory capture recorder + the leaf-rate → ReplayTrace
 * projection. The recorder is the control-path-safe sink: O(1), redact-at-capture, bounded two ways
 * (ring depth + maxScopes FIFO), counts-only when no tenant rule is configured (fail-closed), and a
 * leaf-rate segment projects to the documented `ReplayTrace` JSON (stamped `clock:"system"` ⇒ replay
 * refuses it until the deterministic-capture follow-on).
 */

const dec = (allowed: boolean, remaining = 0): Decision => ({
  allowed,
  limit: 3,
  remaining,
  resetAt: 2000,
  retryAfterMs: allowed ? 0 : 500,
});

const clock = { now: () => 1000 };
const tenantByPrefix: TenantRule = (_policy, key) => {
  const i = key.indexOf(":");
  return i === -1 ? key : key.slice(0, i);
};

function scopedConfig(retention?: Partial<RetentionConfig>): CaptureConfig {
  return {
    enabled: true,
    redaction: { mode: "hmac", secret: "k" },
    retention: { ttlMs: 1000, maxScopes: 100, ringSize: 100, ...retention },
    tenantOf: tenantByPrefix,
  };
}

describe("#289 P3.2 — capture recorder", () => {
  it("a disabled config yields an inert no-op recorder", () => {
    const r = createCaptureRecorder({
      enabled: false,
      redaction: { mode: "drop" },
      retention: { ttlMs: 1, maxScopes: 1, ringSize: 1 },
    });
    expect(r.enabled).toBe(false);
    r.register("p", { policyKind: "rate" });
    r.record({ policy: "p", key: "k", cost: 1, decision: dec(true) });
    expect(r.segments()).toEqual([]);
    expect(r.counts()).toEqual([]);
  });

  it("counts-only (no tenant rule) tallies allow/deny and stores NO per-key rows", () => {
    const r = createCaptureRecorder(
      {
        enabled: true,
        redaction: { mode: "hmac", secret: "k" },
        retention: scopedConfig().retention,
      },
      { clock },
    );
    expect(r.countsOnly).toBe(true);
    r.register("p", { policyKind: "rate" });
    r.record({ policy: "p", key: "u1", cost: 1, decision: dec(true) });
    r.record({ policy: "p", key: "u2", cost: 1, decision: dec(false) });
    r.record({ policy: "p", key: "u3", cost: 1, decision: dec(false) });
    expect(r.segments()).toEqual([]); // no per-key rows (PII) without a tenant rule
    expect(r.counts()).toEqual([{ policy: "p", allowed: 1, denied: 2 }]);
  });

  it("tenant-scoped records redacted events into per-(scope,policy) rings", () => {
    const r = createCaptureRecorder(scopedConfig(), { clock });
    expect(r.countsOnly).toBe(false);
    r.register("api", { policyKind: "rate" });
    r.record({ policy: "api", key: "acme:u1", cost: 1, decision: dec(true, 2) });
    r.record({ policy: "api", key: "acme:u2", cost: 2, decision: dec(false) });
    r.record({ policy: "api", key: "beta:u1", cost: 1, decision: dec(true, 2) });

    const segs = r.segments();
    const acme = segs.find((s) => s.scope === "acme");
    expect(acme?.policy).toBe("api");
    expect(acme?.count).toBe(2);
    expect(acme?.events[0]?.keyRef).not.toBe("acme:u1"); // redacted, not the raw key
    expect(acme?.events[0]?.keyRef).toMatch(/^[0-9a-f]{64}$/); // full hmac digest
    expect(acme?.events[1]?.cost).toBe(2);
    expect(acme?.clock).toBe("system");
    expect(segs.find((s) => s.scope === "beta")?.count).toBe(1);
  });

  it("a ring tail-stops at ringSize and counts drops (keeps the cold-start prefix)", () => {
    const r = createCaptureRecorder(scopedConfig({ ringSize: 2 }), { clock });
    r.register("p", { policyKind: "rate" });
    for (let i = 0; i < 5; i++)
      r.record({ policy: "p", key: `acme:u${i}`, cost: 1, decision: dec(true) });
    const seg = r.segments()[0];
    expect(seg?.count).toBe(2); // prefix kept
    expect(seg?.dropped).toBe(3);
  });

  it("evicts the oldest scope past maxScopes (FIFO)", () => {
    const r = createCaptureRecorder(scopedConfig({ maxScopes: 2 }), { clock });
    r.register("p", { policyKind: "rate" });
    r.record({ policy: "p", key: "a:1", cost: 1, decision: dec(true) });
    r.record({ policy: "p", key: "b:1", cost: 1, decision: dec(true) });
    r.record({ policy: "p", key: "c:1", cost: 1, decision: dec(true) }); // new scope ⇒ evict "a"
    expect(
      r
        .segments()
        .map((s) => s.scope)
        .sort(),
    ).toEqual(["b", "c"]);
  });

  it("excludes a key whose tenant rule returns undefined (never lumped), but still tallies it", () => {
    const tenantOf: TenantRule = (_p, key) => (key.startsWith("ok:") ? "t" : undefined);
    const r = createCaptureRecorder({ ...scopedConfig(), tenantOf }, { clock });
    r.register("p", { policyKind: "rate" });
    r.record({ policy: "p", key: "ok:1", cost: 1, decision: dec(true) });
    r.record({ policy: "p", key: "no-tenant", cost: 1, decision: dec(true) });
    const segs = r.segments();
    expect(segs).toHaveLength(1);
    expect(segs[0]?.count).toBe(1); // the untenanted key is excluded from per-key rows
    expect(r.counts()).toEqual([{ policy: "p", allowed: 2, denied: 0 }]); // but the policy tally sees both
  });

  it("drain returns segments and clears rings; tallies + registrations persist", () => {
    const r = createCaptureRecorder(scopedConfig(), { clock });
    r.register("p", { policyKind: "rate" });
    r.record({ policy: "p", key: "a:1", cost: 1, decision: dec(true) });
    const drained = r.drain();
    expect(drained).toHaveLength(1);
    expect(r.segments()).toEqual([]); // rings cleared
    expect(r.counts()[0]?.allowed).toBe(1); // tally persists across a flush
  });
});

describe("#289 P3.2 — leaf-rate → ReplayTrace projection", () => {
  it("projects a leaf-rate segment to ReplayTrace JSON (clock system, redacted spec, sha1 Lua)", () => {
    const r = createCaptureRecorder(scopedConfig(), { clock });
    r.register("api", {
      policyKind: "rate",
      spec: { strategy: "fixedWindow", limit: 3, windowMs: 1000, prefix: "api-tenant" },
      strategy: { name: "fixedWindow", limit: 3, windowMs: 1000, ttlMs: 1000 },
      luaScript: "return 1",
    });
    r.record({ policy: "api", key: "acme:u1", cost: 1, decision: dec(true, 2), at: 1500 });

    const seg = r.segments()[0];
    const trace = projectToReplayTrace(seg as NonNullable<typeof seg>);
    expect(trace?.version).toBe(1);
    expect(trace?.fingerprint.clock).toBe("system"); // ⇒ P1 refuses replay (forensic)
    expect(trace?.fingerprint.axis).toBe("rate");
    expect(trace?.fingerprint.policy).toBeNull();
    expect(trace?.fingerprint.strategy).toEqual({
      name: "fixedWindow",
      limit: 3,
      windowMs: 1000,
      ttlMs: 1000,
    });
    expect(trace?.fingerprint.luaSha1).toMatch(/^[0-9a-f]{40}$/); // sha1("return 1")
    expect(trace?.fingerprint.spec.prefix).not.toBe("api-tenant"); // redacted at registration
    expect(trace?.steps).toHaveLength(1);
    expect(trace?.steps[0]?.at).toBe(1500);
    expect(trace?.steps[0]?.key).toBe(seg?.events[0]?.keyRef);
    expect(trace?.truncated).toBe(false);
  });

  it("a non-leaf segment (admitter/meter/fair) is forensic-only ⇒ null projection", () => {
    const r = createCaptureRecorder(scopedConfig(), { clock });
    r.register("conc", { policyKind: "admitter" });
    r.record({ policy: "conc", key: "acme:x", cost: 1, decision: dec(true) });
    const seg = r.segments()[0];
    expect(seg?.policyKind).toBe("admitter");
    expect(projectToReplayTrace(seg as NonNullable<typeof seg>)).toBeNull();
  });

  it("register sets luaSha1 null when a strategy is given without Lua", () => {
    const r = createCaptureRecorder(scopedConfig(), { clock });
    r.register("p", {
      policyKind: "rate",
      spec: { strategy: "gcra", limit: 5, periodMs: 1000 },
      strategy: { name: "gcra", limit: 5, ttlMs: 1000 },
    });
    r.record({ policy: "p", key: "a:1", cost: 1, decision: dec(true) });
    expect(r.segments()[0]?.luaSha1).toBeNull();
  });

  it("a dropped tail makes the projected trace truncated (replay-refused downstream)", () => {
    const r = createCaptureRecorder(scopedConfig({ ringSize: 1 }), { clock });
    r.register("p", {
      policyKind: "rate",
      spec: { strategy: "fixedWindow", limit: 3, windowMs: 1000 },
      strategy: { name: "fixedWindow", limit: 3, windowMs: 1000, ttlMs: 1000 },
    });
    r.record({ policy: "p", key: "a:1", cost: 1, decision: dec(true) });
    r.record({ policy: "p", key: "a:2", cost: 1, decision: dec(true) }); // dropped (ringSize 1)
    const trace = projectToReplayTrace(
      r.segments()[0] as NonNullable<ReturnType<typeof r.segments>[0]>,
    );
    expect(trace?.truncated).toBe(true);
    expect(trace?.dropped).toBe(1);
  });
});
