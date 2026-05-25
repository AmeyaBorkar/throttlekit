import { describe, expect, it } from "vitest";
import {
  RateLimitExceededError,
  StoreUnavailableError,
  ThrottleKitError,
} from "../../src/core/errors";
import type { Decision } from "../../src/core/types";

describe("errors", () => {
  it("RateLimitExceededError carries retryAfterMs and the denying decision", () => {
    const decision: Decision = {
      allowed: false,
      limit: 10,
      remaining: 0,
      resetAt: 1000,
      retryAfterMs: 250,
    };
    const e = new RateLimitExceededError(decision);
    expect(e).toBeInstanceOf(ThrottleKitError);
    expect(e).toBeInstanceOf(Error);
    expect(e.retryAfterMs).toBe(250);
    expect(e.decision).toBe(decision);
    expect(e.name).toBe("RateLimitExceededError");
    expect(e.message).toContain("250");
  });

  it("StoreUnavailableError preserves its cause", () => {
    const cause = new Error("ECONNREFUSED");
    const e = new StoreUnavailableError("redis down", { cause });
    expect(e).toBeInstanceOf(ThrottleKitError);
    expect(e.cause).toBe(cause);
    expect(e.name).toBe("StoreUnavailableError");
  });
});
