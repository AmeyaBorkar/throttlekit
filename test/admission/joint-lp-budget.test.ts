import { describe, expect, it } from "vitest";
import { unifiedAdmission } from "../../src/admission/unified";
import { tokenBucket } from "../../src/algorithms/token-bucket";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";

/**
 * The defining guarantee of joint-LP: a request the bid-price filter rejects must
 * NOT consume the rate/cost budget. The whole point of the policy is to *preserve*
 * a binding budget for high-value requests — so a filtered low-value request that
 * still drained the budget would invert the feature. This pins that the bid-price
 * gate runs BEFORE the rate/cost limiters debit (they debit on a successful check
 * with no rollback), across both `admit` and `admitSync`.
 *
 * Regression test for the 0.11.1 ordering bug (filter ran after the cost debit, so
 * filtered requests drained the budget) — caught by `examples/joint-lp-admission.ts`.
 */

/** A non-refilling token budget of `capacity` (clock frozen ⇒ pure fixed budget). */
function costBudget(capacity: number) {
  return rateLimit({
    strategy: tokenBucket({ capacity, refillPerSec: 1 }),
    clock: new ManualClock(0),
  });
}

describe("joint-LP — a filtered request preserves the budget (does not debit)", () => {
  it("admitSync: a policy-denied request leaves the full cost budget for the next high-value one", () => {
    const admit = unifiedAdmission({
      cost: costBudget(1_000),
      policy: "joint-lp",
      jointLp: { duals: { rate: 0, cost: 1 } }, // bid = 1·cost
    });
    // Filtered: value 1 < bid = 1·1000 = 1000.
    const filtered = admit.admitSync({ cost: 1_000, value: 1 });
    expect(filtered.policyDenied).toBe(true);
    expect(filtered.decision.allowed).toBe(false);
    // The budget MUST be intact: a high-value request needing the FULL 1000 tokens
    // still clears. If the filtered request had debited, this would deny on cost.
    const highValue = admit.admitSync({ cost: 1_000, value: 5_000 });
    expect(highValue.decision.allowed).toBe(true);
    expect(highValue.policyDenied).toBeFalsy();
  });

  it("admit (async): same — a filtered request does not consume the budget", async () => {
    const admit = unifiedAdmission({
      cost: costBudget(1_000),
      policy: "joint-lp",
      jointLp: { duals: { rate: 0, cost: 1 } },
    });
    expect((await admit.admit({ cost: 1_000, value: 1 })).policyDenied).toBe(true);
    expect((await admit.admit({ cost: 1_000, value: 5_000 })).decision.allowed).toBe(true);
  });

  it("end-to-end: filtered low-value calls don't starve high-value ones (the example scenario)", () => {
    // Budget 50k tokens. duals {0, 0.01}: small (100 tok, v1) clears (1 ≥ 1), large
    // (10k tok, v50) is filtered (50 < 100). Adversarial order: 6 large, then 600 small.
    const admit = unifiedAdmission({
      cost: costBudget(50_000),
      policy: "joint-lp",
      jointLp: { duals: { rate: 0, cost: 0.01 } },
    });
    let revenue = 0;
    let smallAdmitted = 0;
    for (let i = 0; i < 6; i++) {
      const r = admit.admitSync({ cost: 10_000, value: 50 });
      expect(r.policyDenied).toBe(true); // every large is filtered
      expect(r.decision.allowed).toBe(false);
    }
    for (let i = 0; i < 600; i++) {
      const r = admit.admitSync({ cost: 100, value: 1 });
      if (r.decision.allowed) {
        revenue += 1;
        smallAdmitted += 1;
      }
    }
    // The 6 filtered larges must NOT have drained the 50k budget: 500 small fit (500·100).
    expect(smallAdmitted).toBe(500);
    expect(revenue).toBe(500);
  });

  it("a marginal admitter on the same stream is starved by the larges (contrast)", () => {
    // Same stream, NO policy: marginal-AND greedily admits 5 large (50k), then denies
    // all 600 small — revenue 250. This is exactly what joint-LP fixes (→ 500 above).
    const admit = unifiedAdmission({ cost: costBudget(50_000) });
    let revenue = 0;
    for (let i = 0; i < 6; i++) {
      if (admit.admitSync({ cost: 10_000 }).decision.allowed) revenue += 50;
    }
    for (let i = 0; i < 600; i++) {
      if (admit.admitSync({ cost: 100 }).decision.allowed) revenue += 1;
    }
    expect(revenue).toBe(250); // 5 large, no small
  });
});
