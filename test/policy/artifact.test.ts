import { describe, expect, it } from "vitest";
import { ThrottleKitError } from "../../src/core/errors";
import {
  parsePolicySet,
  policy,
  policySet,
  policySetFromConfig,
  serializePolicySet,
} from "../../src/policy";

/**
 * Policy Plans P1 — the content-addressed Policy / PolicySet artifact. Built on `buildStrategy` (which
 * validates the spec eagerly) + the replay `ReplayFingerprint`. The crown properties: the hash is stable
 * and order-independent, serialize→parse round-trips (re-deriving the fingerprint), and a tampered
 * artifact is refused loudly.
 */

const FW3 = { strategy: "fixedWindow", limit: 3, windowMs: 1000 } as const;
const FW5 = { strategy: "fixedWindow", limit: 5, windowMs: 1000 } as const;

describe("policy()", () => {
  it("builds a policy with a manual-clock, rate-axis fingerprint", () => {
    const p = policy("api", FW3);
    expect(p.name).toBe("api");
    expect(p.spec).toEqual(FW3);
    expect(p.fingerprint.clock).toBe("manual");
    expect(p.fingerprint.axis).toBe("rate");
    expect(p.fingerprint.policy).toBeNull();
  });

  it("validates the spec eagerly (an incomplete spec throws at construction)", () => {
    expect(() => policy("bad", { strategy: "gcra" } as never)).toThrow(ThrottleKitError);
  });
});

describe("policySet()", () => {
  it("hashes content stably and order-independently", () => {
    const a = policy("api", FW3);
    const b = policy("uploads", FW5);
    expect(policySet([a, b]).contentHash).toBe(policySet([b, a]).contentHash);
  });

  it("changes the hash when a spec changes", () => {
    const lo = policySet([policy("api", FW3)]);
    const hi = policySet([policy("api", FW5)]);
    expect(lo.contentHash).not.toBe(hi.contentHash);
  });

  it("refuses duplicate policy names", () => {
    expect(() => policySet([policy("api", FW3), policy("api", FW5)])).toThrow(ThrottleKitError);
  });

  it("refuses a name shared by policies[] and unreplayable[] (ambiguous; regression)", () => {
    // Such a name would yield two plan() diff rows and double-count the PlanSummary (and falsely trip
    // the fail-closed all-replayable gate).
    expect(() =>
      policySet([policy("api", FW3)], {
        unreplayable: [{ name: "api", reason: "concurrency axis" }],
      }),
    ).toThrow(/both policies and unreplayable/);
  });

  it("includes the unreplayable list in the hash", () => {
    const plain = policySet([policy("api", FW3)]);
    const withU = policySet([policy("api", FW3)], {
      unreplayable: [{ name: "workers", reason: "concurrency axis" }],
    });
    expect(plain.contentHash).not.toBe(withU.contentHash);
  });
});

describe("serialize / parse", () => {
  it("round-trips, re-deriving the fingerprint and preserving the hash", () => {
    const set = policySet([policy("api", FW3), policy("uploads", FW5)], { label: "v1" });
    const back = parsePolicySet(serializePolicySet(set));
    expect(back.contentHash).toBe(set.contentHash);
    expect(back.label).toBe("v1");
    expect(back.policies.map((p) => p.name).sort()).toEqual(["api", "uploads"]);
    expect(back.policies[0]?.fingerprint.clock).toBe("manual");
  });

  it("refuses a tampered artifact (spec mutated, stored hash stale)", () => {
    const set = policySet([policy("api", FW3)]);
    const obj = JSON.parse(serializePolicySet(set));
    obj.policies[0].spec.limit = 999; // tamper, but keep the old contentHash
    expect(() => parsePolicySet(JSON.stringify(obj))).toThrow(/contentHash mismatch/);
  });

  it("refuses an incompatible format version", () => {
    const set = policySet([policy("api", FW3)]);
    const obj = JSON.parse(serializePolicySet(set));
    obj.v = 999;
    expect(() => parsePolicySet(JSON.stringify(obj))).toThrow(/unsupported format version/);
  });
});

describe("policySetFromConfig()", () => {
  it("reads a throttlekit/config YAML limiters map into policies", () => {
    const set = policySetFromConfig(
      ["version: 1", "limiters:", "  api: { strategy: gcra, limit: 100, period: 1m }"].join("\n"),
    );
    expect(set.policies).toHaveLength(1);
    expect(set.policies[0]?.name).toBe("api");
    expect(set.policies[0]?.spec.strategy).toBe("gcra");
  });
});
