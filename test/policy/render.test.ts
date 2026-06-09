import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/core/clock";
import {
  type Plan,
  corpusFromRecordings,
  plan,
  planToJSON,
  policy,
  policySet,
  renderPlan,
} from "../../src/policy";
import { recordLimiter } from "../../src/testkit/replay";

/**
 * Policy Plans P4 — the renderers. renderPlan is a pure human summary carrying the honest non-claims
 * inline; planToJSON is the machine-readable artifact (round-trips, since a Plan is plain data).
 */

const FW3 = { strategy: "fixedWindow", limit: 3, windowMs: 1000 } as const;
const FW5 = { strategy: "fixedWindow", limit: 5, windowMs: 1000 } as const;

function loosenPlan(): Plan {
  const rec = recordLimiter(FW3, { clock: new ManualClock(1000) });
  for (let i = 0; i < 6; i++) rec.limiter.checkSync("u");
  return plan(
    policySet([policy("api", FW3)], { label: "v1" }),
    policySet([policy("api", FW5)], { label: "v2" }),
    corpusFromRecordings({ api: rec }),
  );
}

describe("renderPlan()", () => {
  it("renders header, the policy line, and the summary", () => {
    const out = renderPlan(loosenPlan());
    expect(out).toContain("Policy Plan:");
    expect(out).toContain("v1");
    expect(out).toContain("v2");
    expect(out).toMatch(/api: 0 allow→deny, 2 deny→allow over 6 arrival/);
    expect(out).toContain("Summary:");
  });

  it("surfaces a not-replayable policy as 'observe live', never a fake number", () => {
    const synthetic: Plan = {
      current: { contentHash: "a".repeat(64) },
      candidate: { contentHash: "b".repeat(64) },
      corpus: { policies: 0, steps: 0, truncated: false },
      diffs: [
        {
          policy: "workers",
          state: "not-replayable",
          allowToDeny: 0,
          denyToAllow: 0,
          flippedTotal: 0,
          divergent: 0,
          steps: 0,
          affectedKeys: 0,
          topFlippedKeys: [],
          refusal: { reason: "not-replayable", message: "concurrency axis" },
        },
      ],
      summary: {
        policies: 1,
        replayable: 0,
        allowToDeny: 0,
        denyToAllow: 0,
        flippedTotal: 0,
        affectedKeys: 0,
        added: [],
        removed: [],
      },
    };
    expect(renderPlan(synthetic)).toContain("not replayable");
    expect(renderPlan(synthetic)).toContain("observe live");
  });

  it("renders a refused diff loudly (the defensive state)", () => {
    const synthetic: Plan = {
      current: { contentHash: "a".repeat(64) },
      candidate: { contentHash: "b".repeat(64) },
      corpus: { policies: 1, steps: 1, truncated: false },
      diffs: [
        {
          policy: "api",
          state: "refused",
          allowToDeny: 0,
          denyToAllow: 0,
          flippedTotal: 0,
          divergent: 0,
          steps: 0,
          affectedKeys: 0,
          topFlippedKeys: [],
          refusal: { reason: "unrebuildable-strategy", message: "leakyBucket is not replayable" },
        },
      ],
      summary: {
        policies: 1,
        replayable: 0,
        allowToDeny: 0,
        denyToAllow: 0,
        flippedTotal: 0,
        affectedKeys: 0,
        added: [],
        removed: [],
      },
    };
    expect(renderPlan(synthetic)).toContain("REFUSED");
    expect(renderPlan(synthetic)).toContain("unrebuildable-strategy");
  });
});

describe("planToJSON()", () => {
  it("round-trips (a Plan is plain serializable data)", () => {
    const p = loosenPlan();
    expect(JSON.parse(planToJSON(p))).toEqual(p);
  });
});
