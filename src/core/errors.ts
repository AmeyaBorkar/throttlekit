import type { Decision } from "./types";

/** Base class for all errors thrown by ThrottleKit. */
export class ThrottleKitError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ThrottleKitError";
  }
}

/**
 * The backing store could not be reached or returned an error. The adapter's `fail` policy
 * decides whether this resolves to allow (`"open"`) or deny (`"closed"`).
 */
export class StoreUnavailableError extends ThrottleKitError {
  constructor(message = "rate-limit store is unavailable", options?: ErrorOptions) {
    super(message, options);
    this.name = "StoreUnavailableError";
  }
}

/**
 * Thrown by a placeholder code path that has been declared but not yet
 * implemented. Used during incremental rollout (e.g. the `FederatedStore`
 * skeleton in TK-902 throws this from `apply()` until TK-903/904 land the
 * real behavior). Catching this specifically lets tests and integrators
 * distinguish "this is a known stub" from a generic ThrottleKitError.
 */
export class NotImplementedError extends ThrottleKitError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NotImplementedError";
  }
}

/**
 * Convenience error for callers that prefer throwing over inspecting a {@link Decision}.
 * Carries the denying decision and its `retryAfterMs`.
 */
export class RateLimitExceededError extends ThrottleKitError {
  readonly retryAfterMs: number;
  readonly decision: Decision;

  constructor(decision: Decision, message?: string) {
    super(message ?? `rate limit exceeded; retry after ${decision.retryAfterMs}ms`);
    this.name = "RateLimitExceededError";
    this.retryAfterMs = decision.retryAfterMs;
    this.decision = decision;
  }
}
