import type { LimiterSpec } from "throttlekit/config";
import { describe, expect, it } from "vitest";
import type { AuditLog, AuditRecord } from "../src/capture/audit.js";
import type { CaptureCliDeps } from "../src/capture/cli.js";
import type { SegmentStore } from "../src/capture/store.js";
import type { CaptureConfig, CaptureSegment } from "../src/capture/types.js";
import { corpusFromCapture, corpusFromTraceFile } from "../src/policy/corpus.js";
import { runPolicyPlan } from "../src/policy/plan.js";
import { policySetFromServerConfig } from "../src/policy/policy-set.js";

/**
 * Policy Plans P5 (#311): the server `policy plan` CLI — "terraform plan for limits". Coverage for the three
 * pure layers (the server config → policy-set classifier, the corpus adapters, the plan/gate orchestration)
 * plus the fail-closed + audited capture-corpus path with injected fakes. Configs are JSON to sidestep the
 * core YAML parser's nested-flow-map limitation (the live server's loader shares that parser, so the CLI
 * inherits the same constraint — block-style YAML or JSON for nested blocks).
 */

/** A corpus trace's decisions are IGNORED by plan (it cold-re-decides); only key/cost/at arrivals matter. */
function trace(steps: ReadonlyArray<{ key: string; at: number; cost?: number }>) {
  return {
    version: 1 as const,
    fingerprint: {},
    redacted: false,
    truncated: false,
    dropped: 0,
    steps: steps.map((s) => ({
      key: s.key,
      cost: s.cost ?? 1,
      at: s.at,
      decision: { allowed: true, limit: 0, remaining: 0, resetAt: 0, retryAfterMs: 0 },
    })),
  };
}

describe("policySetFromServerConfig: replayability classification (PP-04 boundary)", () => {
  it("classifies a leaf-rate policy as replayable and every server axis as not-replayable", () => {
    const cfg = JSON.stringify({
      limiters: {
        api: { strategy: "fixedWindow", limit: 3, period: "1s" },
        fe: { federatedFairEscrow: { limit: 100, windowMs: 1000 } },
        cc: { concurrency: { minLimit: 4 } },
        dcc: { distributedConcurrency: { minLimit: 4 } },
        tt: { strategy: "gcra", limit: 10, period: "1s", twoTier: { batch: 5 } },
        esc: { fairEscrow: { limit: 100, windowMs: 1000 } },
        fed: { strategy: "fixedWindow", limit: 10, period: "1s", federated: {} },
        tb: { tokenBudget: { budget: 100, windowMs: 1000 } },
        fb: { fleetBudget: { budget: 100, windowMs: 1000 } },
      },
    });
    const set = policySetFromServerConfig(cfg, { label: "current" });
    expect(set.label).toBe("current");
    expect(set.policies.map((p) => p.name)).toEqual(["api"]); // only the leaf rate limiter
    const unreplayable = (set.unreplayable ?? []).map((u) => u.name).sort();
    expect(unreplayable).toEqual(["cc", "dcc", "esc", "fb", "fe", "fed", "tb", "tt"].sort());
    // Each carries an honest, axis-specific reason (never a fabricated zero).
    const reason = (name: string) => set.unreplayable?.find((u) => u.name === name)?.reason ?? "";
    expect(reason("cc")).toMatch(/concurrency/);
    expect(reason("tt")).toMatch(/two-tier/);
    expect(reason("esc")).toMatch(/fair-escrow/);
    expect(reason("fe")).toMatch(/cross-region/);
    expect(reason("tb")).toMatch(/debit/);
  });

  it("carries a malformed leaf-rate spec as unreplayable (not a throw) with the builder's reason", () => {
    const cfg = JSON.stringify({ limiters: { bad: { strategy: "nope", limit: 3, period: "1s" } } });
    const set = policySetFromServerConfig(cfg);
    expect(set.policies).toHaveLength(0);
    expect(set.unreplayable?.[0]?.name).toBe("bad");
    expect(set.unreplayable?.[0]?.reason.length).toBeGreaterThan(0);
  });

  it("treats a policy with no strategy and no known block as not-replayable", () => {
    const set = policySetFromServerConfig(JSON.stringify({ limiters: { x: { note: "huh" } } }));
    expect(set.unreplayable?.[0]).toEqual({
      name: "x",
      reason: "no leaf-rate strategy declared (not a check-replayable policy)",
    });
  });

  it("parses block-style YAML (nested blocks the core flow parser cannot do inline)", () => {
    const yaml = [
      "limiters:",
      "  api:",
      "    strategy: fixedWindow",
      "    limit: 3",
      "    period: 1s",
      "  fe:",
      "    federatedFairEscrow:",
      "      limit: 100",
      "      windowMs: 1000",
    ].join("\n");
    const set = policySetFromServerConfig(yaml);
    expect(set.policies.map((p) => p.name)).toEqual(["api"]);
    expect(set.unreplayable?.map((u) => u.name)).toEqual(["fe"]);
  });

  it("throws on a config missing a limiters map (fail-closed)", () => {
    expect(() => policySetFromServerConfig(JSON.stringify({ defaults: {} }))).toThrow(/limiters/);
    expect(() => policySetFromServerConfig("not an object")).toThrow();
  });
});

describe("corpusFromTraceFile: parse + fail-closed validation", () => {
  it("builds a corpus from a policyName → trace(s) map", () => {
    const file = JSON.stringify({
      api: trace([
        { key: "a", at: 1000 },
        { key: "a", at: 1010 },
        { key: "b", at: 1020 },
      ]),
    });
    const corpus = corpusFromTraceFile(file);
    expect(corpus.api.arrivals).toHaveLength(3);
    expect(corpus.api.arrivals[0]).toEqual({ key: "a", cost: 1, at: 1000 });
  });

  it("accepts an array of traces for one policy (folds their arrivals)", () => {
    const file = JSON.stringify({
      api: [trace([{ key: "a", at: 1 }]), trace([{ key: "b", at: 2 }])],
    });
    expect(corpusFromTraceFile(file).api.arrivals).toHaveLength(2);
  });

  it("rejects non-JSON, a non-object, and a value that is not a trace (fail-closed)", () => {
    expect(() => corpusFromTraceFile("{not json")).toThrow(/not valid JSON/);
    expect(() => corpusFromTraceFile(JSON.stringify([1, 2]))).toThrow(/must be a JSON object/);
    expect(() => corpusFromTraceFile(JSON.stringify({ api: { nope: true } }))).toThrow(
      /not a trace/,
    );
  });
});

const CURRENT = JSON.stringify({
  limiters: { api: { strategy: "fixedWindow", limit: 3, period: "1s" } },
});
const LOOSER = JSON.stringify({
  limiters: { api: { strategy: "fixedWindow", limit: 5, period: "1s" } },
});
const TIGHTER = JSON.stringify({
  limiters: { api: { strategy: "fixedWindow", limit: 1, period: "1s" } },
});
// 6 arrivals for one key inside one 1s window: under limit 3 the first 3 pass; tightening/loosening flips.
const CORPUS = corpusFromTraceFile(
  JSON.stringify({ api: trace(Array.from({ length: 6 }, (_, i) => ({ key: "t", at: 1000 + i }))) }),
);

describe("runPolicyPlan: diff + render + gate", () => {
  it("a looser candidate shows deny→allow flips and is ok with no budget", () => {
    const r = runPolicyPlan({ currentConfig: CURRENT, candidateConfig: LOOSER, corpus: CORPUS });
    expect(r.ok).toBe(true);
    expect(r.plan?.summary.denyToAllow).toBe(2); // limit 3→5 admits 2 more of the 6
    expect(r.plan?.summary.allowToDeny).toBe(0);
    expect(r.rendered).toMatch(/2 newly ALLOWED/);
  });

  it("a tighter candidate shows allow→deny flips (the tightening blast radius)", () => {
    const r = runPolicyPlan({ currentConfig: CURRENT, candidateConfig: TIGHTER, corpus: CORPUS });
    expect(r.ok).toBe(true);
    expect(r.plan?.summary.allowToDeny).toBe(2); // limit 3→1 now denies 2 that were allowed
    expect(r.plan?.summary.denyToAllow).toBe(0);
  });

  it("the gate rejects (ok:false + violations) when the blast radius exceeds the budget", () => {
    const r = runPolicyPlan({
      currentConfig: CURRENT,
      candidateConfig: TIGHTER,
      corpus: CORPUS,
      budget: { maxAllowToDeny: 0 },
    });
    expect(r.ok).toBe(false);
    expect(r.rejected?.[0]).toMatch(/allow→deny 2 exceeds max 0/);
    expect(r.rendered).toBeDefined(); // the plan is still rendered so the operator sees WHY
  });

  it("the gate passes (ok:true) when the change stays within budget", () => {
    const r = runPolicyPlan({
      currentConfig: CURRENT,
      candidateConfig: TIGHTER,
      corpus: CORPUS,
      budget: { maxAllowToDeny: 5, maxFlippedTotal: 5 },
    });
    expect(r.ok).toBe(true);
    expect(r.rejected).toBeUndefined();
  });

  it("requireAllReplayable fails when the config has a non-replayable axis", () => {
    const withEscrow = JSON.stringify({
      limiters: {
        api: { strategy: "fixedWindow", limit: 3, period: "1s" },
        esc: { fairEscrow: { limit: 100, windowMs: 1000 } },
      },
    });
    const r = runPolicyPlan({
      currentConfig: withEscrow,
      candidateConfig: withEscrow,
      corpus: CORPUS,
      budget: { requireAllReplayable: true },
    });
    expect(r.ok).toBe(false);
    expect(r.rejected?.join(" ")).toMatch(/not replayable/);
  });

  it("emits the machine-readable JSON artifact when json is set", () => {
    const r = runPolicyPlan({
      currentConfig: CURRENT,
      candidateConfig: LOOSER,
      corpus: CORPUS,
      json: true,
    });
    expect(r.ok).toBe(true);
    const parsed = JSON.parse(r.rendered ?? "");
    expect(parsed.summary.denyToAllow).toBe(2);
    expect(parsed.diffs[0].policy).toBe("api");
  });

  it("fail-closed on a bad config (ok:false + error, no plan)", () => {
    const r = runPolicyPlan({
      currentConfig: "not an object",
      candidateConfig: CURRENT,
      corpus: CORPUS,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
    expect(r.plan).toBeUndefined();
  });
});

// ---- corpusFromCapture: the fail-closed + audited capture-store path, with injected fakes ----

function leafSegment(policy: string, scope: string, n: number): CaptureSegment {
  return {
    policy,
    policyKind: "rate",
    scope,
    createdAt: 1000,
    redactionMode: "hmac",
    clock: "system",
    count: n,
    dropped: 0,
    spec: { strategy: "fixedWindow", limit: 3 } as unknown as LimiterSpec,
    strategy: { name: "fixedWindow", limit: 3, ttlMs: 0 },
    luaSha1: null,
    events: Array.from({ length: n }, (_, i) => ({
      keyRef: `k${i % 2}`,
      cost: 1,
      at: 1000 + i * 10,
      decision: { allowed: true, limit: 3, remaining: 2, resetAt: 2000, retryAfterMs: 0 },
    })),
  };
}

function admitterSegment(policy: string): CaptureSegment {
  return {
    policy,
    policyKind: "admitter",
    scope: "s",
    createdAt: 1000,
    redactionMode: "hmac",
    clock: "system",
    count: 1,
    dropped: 0,
    events: [
      {
        keyRef: "k",
        cost: 1,
        at: 1000,
        decision: { allowed: true, limit: 0, remaining: 0, resetAt: 0, retryAfterMs: 0 },
      },
    ],
  };
}

function fakeDeps(segments: Record<string, CaptureSegment>): {
  deps: CaptureCliDeps;
  audit: AuditRecord[];
} {
  const audit: AuditRecord[] = [];
  const store: SegmentStore = {
    list: async () => Object.entries(segments).map(([id, s]) => ({ id, createdAt: s.createdAt })),
    read: async (id: string) => {
      const s = segments[id];
      if (s === undefined) throw new Error(`no segment ${id}`);
      return s;
    },
    sweep: async () => 0,
  } as unknown as SegmentStore;
  const auditLog: AuditLog = {
    append: async (r: AuditRecord) => void audit.push(r),
  } as unknown as AuditLog;
  const config = { auth: { operatorSecret: "secret" } } as unknown as CaptureConfig;
  return { deps: { config, store, audit: auditLog }, audit };
}

describe("corpusFromCapture: fail-closed + audited, leaf-rate only", () => {
  it("builds a corpus from leaf-rate segments and reports non-leaf skips (authorized)", async () => {
    const { deps, audit } = fakeDeps({
      "seg-1": leafSegment("api", "tenant-a", 4),
      "seg-2": leafSegment("api", "tenant-b", 2),
      "seg-3": admitterSegment("cc"),
    });
    const res = await corpusFromCapture(deps, { credential: "secret", principal: "alice" });
    expect(res.ok).toBe(true);
    expect(res.corpus?.api.arrivals).toHaveLength(6); // 4 + 2 leaf-rate events folded
    expect(res.sources).toEqual([{ policy: "api", segments: 2 }]);
    expect(res.skipped).toEqual([{ id: "seg-3", policy: "cc", reason: "not-leaf-rate" }]);
    // Every read was audited (one list + one export per leaf-rate segment).
    expect(audit.some((r) => r.action === "list")).toBe(true);
    expect(audit.filter((r) => r.action === "export")).toHaveLength(2);
  });

  it("is fail-closed: an invalid credential yields no corpus and (almost) no reads", async () => {
    const { deps } = fakeDeps({ "seg-1": leafSegment("api", "t", 2) });
    const res = await corpusFromCapture(deps, { credential: "wrong" });
    expect(res.ok).toBe(false);
    expect(res.corpus).toBeUndefined();
    expect(res.error).toMatch(/unauthorized/);
  });

  it("is fail-closed when no credential is supplied", async () => {
    const { deps } = fakeDeps({ "seg-1": leafSegment("api", "t", 2) });
    const res = await corpusFromCapture(deps, {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/credential is required/);
  });
});
