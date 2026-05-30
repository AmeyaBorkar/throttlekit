import type { Decision } from "./types";

/**
 * Stable, machine-readable discriminant carried by every {@link ThrottleKitError}. Prefer it over
 * `instanceof` when robustness matters across realms or a dependency tree that bundled ThrottleKit
 * twice (`instanceof` fails across two copies of the class; the `code` string does not). Frozen at
 * 1.0 — the value set grows only additively.
 */
export type ThrottleKitErrorCode =
  | "throttlekit_error"
  | "store_unavailable"
  | "not_implemented"
  | "rate_limit_exceeded"
  | "queue_full"
  | "config_invalid";

/** Base class for all errors thrown by ThrottleKit. */
export class ThrottleKitError extends Error {
  /** Machine-readable discriminant — see {@link ThrottleKitErrorCode}. Robust to cross-realm `instanceof`. */
  readonly code: ThrottleKitErrorCode;

  constructor(message: string, options?: ErrorOptions & { code?: ThrottleKitErrorCode }) {
    super(message, options);
    this.name = "ThrottleKitError";
    this.code = options?.code ?? "throttlekit_error";
  }
}

/**
 * The backing store could not be reached or returned an error. The adapter's `fail` policy
 * decides whether this resolves to allow (`"open"`) or deny (`"closed"`).
 */
export class StoreUnavailableError extends ThrottleKitError {
  constructor(message = "rate-limit store is unavailable", options?: ErrorOptions) {
    super(message, { ...options, code: "store_unavailable" });
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
    super(message, { ...options, code: "not_implemented" });
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
    super(message ?? `rate limit exceeded; retry after ${decision.retryAfterMs}ms`, {
      code: "rate_limit_exceeded",
    });
    this.name = "RateLimitExceededError";
    this.retryAfterMs = decision.retryAfterMs;
    this.decision = decision;
  }
}
