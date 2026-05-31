import { ManualClock, gcra, rateLimit } from "throttlekit";
import type { Store, Strategy } from "throttlekit";
import { describe, expect, it } from "vitest";
import {
  OperationNotSupportedError,
  PolicyNotFoundError,
  createRateLimiterService,
} from "../src/service.js";
import { buildStrategy, decisionFields, rateLimitSuites } from "./_vectors.js";

/**
 * Service-core conformance, in-process (no gRPC). The server consumes the committed golden vectors as a
 * polyglot port would, and must reproduce every rateLimit suite's decisions field-for-field.
 * `grpc.test.ts` then proves the same holds over the wire.
 */
describe("RateLimiter service core ≡ golden vectors", () => {
  it("replays every committed rateLimit suite identically", async () => {
    const clock = new ManualClock(0);
    const limiters = Object.fromEntries(
      rateLimitSuites.map((s) => [
        s.name,
        rateLimit({ strategy: buildStrategy(s.strategy), clock }),
      ]),
    );
    const service = createRateLimiterService({ limiters });
    expect(service.policies()).toEqual(rateLimitSuites.map((s) => s.name));

    for (const suite of rateLimitSuites) {
      for (const op of suite.ops) {
        clock.set(op.now);
        const d = await service.check(suite.name, suite.key, op.cost);
        expect(decisionFields(d), `${suite.name} @ now=${op.now} cost=${op.cost}`).toEqual(
          op.expect,
        );
      }
    }
  });

  it("rejects an unknown policy with PolicyNotFoundError", async () => {
    const service = createRateLimiterService({
      limiters: { api: rateLimit({ strategy: gcra({ limit: 10, periodMs: 1000 }) }) },
    });
    await expect(service.check("nope", "k")).rejects.toBeInstanceOf(PolicyNotFoundError);
  });

  it("resolves a store outage by the fail mode (open admits, closed denies)", async () => {
    const throwing: Store = {
      apply: async () => {
        throw new Error("store down");
      },
      reset: async () => {},
    };
    const open = createRateLimiterService({
      limiters: {
        api: rateLimit({
          strategy: gcra({ limit: 10, periodMs: 1000, burst: 5 }),
          store: throwing,
        }),
      },
      fail: "open",
    });
    const a = await open.check("api", "k");
    expect(a.allowed).toBe(true);
    expect(a.limit).toBe(5);

    const closed = createRateLimiterService({
      limiters: {
        api: rateLimit({
          strategy: gcra({ limit: 10, periodMs: 1000, burst: 5 }),
          store: throwing,
        }),
      },
      fail: "closed",
    });
    expect((await closed.check("api", "k")).allowed).toBe(false);
  });

  it("peek is non-consuming; a strategy without peek rejects with OperationNotSupportedError", async () => {
    const service = createRateLimiterService({
      limiters: { api: rateLimit({ strategy: gcra({ limit: 10, periodMs: 1000, burst: 5 }) }) },
    });
    const before = await service.peek("api", "k");
    const after = await service.peek("api", "k");
    expect(before.remaining).toBe(after.remaining);

    const noPeek: Strategy = {
      name: "noPeek",
      limit: 1,
      ttlMs: 1000,
      check: (state, now, cost) => ({
        state: ((state as number | undefined) ?? 0) + cost,
        result: { allowed: true, limit: 1, remaining: 0, resetAt: now + 1000, retryAfterMs: 0 },
        ttlMs: 1000,
        persist: true,
      }),
    };
    const svc = createRateLimiterService({ limiters: { np: rateLimit({ strategy: noPeek }) } });
    await expect(svc.peek("np", "k")).rejects.toBeInstanceOf(OperationNotSupportedError);
  });
});
