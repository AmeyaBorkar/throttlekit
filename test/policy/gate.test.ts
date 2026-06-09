import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/core/clock";
import {
  PlanRejectedError,
  assertPlanAcceptable,
  corpusFromRecordings,
  plan,
  policy,
  policySet,
} from "../../src/policy";
import { recordLimiter } from "../../src/testkit/replay";

/**
 * Policy Plans P4 — the CI gate. assertPlanAcceptable fails loud (PlanRejectedError, with every violation)
 * when a plan breaches its blast-radius budget, and passes silently within budget — the adaptive
 * promote-or-hold lever.
 */

const FW3 = { strategy: "fixedWindow", limit: 3, windowMs: 1000 } as const;
const FW5 = { strategy: "fixedWindow", limit: 5, windowMs: 1000 } as const;

function loosenPlan(unreplayable?: { name: string; reason: string }[]) {
  const rec = recordLimiter(FW3, { clock: new ManualClock(1000) });
  for (let i = 0; i < 6; i++) rec.limiter.checkSync("u"); // baseline [A,A,A,D,D,D]
  const opts = unreplayable !== undefined ? { unreplayable } : {};
  return plan(
    policySet([policy("api", FW3)], opts),
    policySet([policy("api", FW5)], opts),
    corpusFromRecordings({ api: rec }),
  ); // denyToAllow = 2
}

describe("assertPlanAcceptable()", () => {
  it("passes when within budget", () => {
    expect(() => assertPlanAcceptable(loosenPlan(), { maxDenyToAllow: 5 })).not.toThrow();
  });

  it("throws PlanRejectedError with the violation when over budget", () => {
    try {
      assertPlanAcceptable(loosenPlan(), { maxDenyToAllow: 1 });
      throw new Error("expected PlanRejectedError");
    } catch (e) {
      expect(e).toBeInstanceOf(PlanRejectedError);
      expect((e as PlanRejectedError).violations.join(" ")).toMatch(/deny→allow 2 exceeds max 1/);
    }
  });

  it("requireAllReplayable flags a not-replayable policy", () => {
    const p = loosenPlan([{ name: "workers", reason: "concurrency axis" }]);
    expect(() => assertPlanAcceptable(p, { requireAllReplayable: true })).toThrow(
      PlanRejectedError,
    );
  });

  it("requireAllReplayable passes when every policy replayed", () => {
    expect(() => assertPlanAcceptable(loosenPlan(), { requireAllReplayable: true })).not.toThrow();
  });
});
