import { ManualClock } from "throttlekit";
import { describe, expect, it } from "vitest";
import {
  OperationNotSupportedError,
  PolicyNotFoundError,
  createRateLimiterServiceFromConfig,
} from "../src/service.js";
import { decisionFields, tokenBudgetSuites } from "./_vectors.js";

/**
 * Door B (cost axis): a policy with a `tokenBudget` block is served as a windowed token-budget meter via
 * the `debit` op. The service keeps one meter per key, and the decision is the core's `tokenBudget`
 * primitive — so it must reproduce the committed tokenBudget golden vectors field-for-field.
 */
describe("token-budget (cost-axis) policies via the service door", () => {
  it("replays every committed tokenBudget suite identically through debit", async () => {
    expect(tokenBudgetSuites.length).toBeGreaterThan(0); // guard against a vacuous pass

    for (const suite of tokenBudgetSuites) {
      const clock = new ManualClock(0);
      const config = JSON.stringify({
        limiters: {
          [suite.name]: {
            tokenBudget: { budget: suite.options.budget, windowMs: suite.options.windowMs },
          },
        },
      });
      const service = createRateLimiterServiceFromConfig(config, { clock });

      for (const op of suite.ops) {
        clock.set(op.now);
        const d = await service.debit(suite.name, "k", op.tokens);
        expect(decisionFields(d), `${suite.name} @ now=${op.now} tokens=${op.tokens}`).toEqual(
          op.expect,
        );
      }
    }
  });

  it("keeps an independent budget per key", async () => {
    const clock = new ManualClock(0);
    const config = JSON.stringify({
      limiters: { llm: { tokenBudget: { budget: 2, windowMs: 1000 } } },
    });
    const service = createRateLimiterServiceFromConfig(config, { clock });

    expect((await service.debit("llm", "alice", 1)).allowed).toBe(true);
    expect((await service.debit("llm", "alice", 1)).allowed).toBe(true);
    expect((await service.debit("llm", "alice", 1)).allowed).toBe(false); // alice spent her 2
    expect((await service.debit("llm", "bob", 1)).allowed).toBe(true); // bob's budget is untouched
  });

  it("separates the limiter and meter surfaces (check↔debit are not interchangeable)", async () => {
    const config = JSON.stringify({
      limiters: {
        llm: { tokenBudget: { budget: 100, windowMs: 1000 } },
        api: { strategy: "gcra", limit: 5, period: 1000, burst: 5 },
      },
    });
    const service = createRateLimiterServiceFromConfig(config, {});
    expect(new Set(service.policies())).toEqual(new Set(["llm", "api"]));

    // a token-budget meter does not serve the consuming/introspection ops
    await expect(service.check("llm", "k")).rejects.toBeInstanceOf(OperationNotSupportedError);
    await expect(service.peek("llm", "k")).rejects.toBeInstanceOf(OperationNotSupportedError);
    // a rate limiter does not serve debit
    await expect(service.debit("api", "k", 1)).rejects.toBeInstanceOf(OperationNotSupportedError);
    // an unknown policy is still NOT_FOUND on the debit path
    await expect(service.debit("nope", "k", 1)).rejects.toBeInstanceOf(PolicyNotFoundError);
  });
});
