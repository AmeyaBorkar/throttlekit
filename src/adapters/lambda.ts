/**
 * AWS Lambda adapter for API Gateway proxy integrations — both REST API (payload v1) and HTTP API
 * (payload v2). Wraps a proxy handler with a rate-limit gate built on {@link createEnforcer}: on
 * allow it forwards and merges the standards headers into the result; on deny it returns `429` with
 * `Retry-After`; a fail-closed store outage returns `503`. The event/result shapes are modeled
 * structurally (covering both payload versions), so the real `aws-lambda` types satisfy them with no
 * `@types/aws-lambda` dependency.
 */

import { type EnforceOptions, createEnforcer } from "./enforce";

/**
 * The slice of an API Gateway proxy event the adapter reads. Covers both payload versions: v1 (REST)
 * exposes the caller IP at `requestContext.identity.sourceIp`, v2 (HTTP API) at
 * `requestContext.http.sourceIp`. Both are populated by API Gateway, so they are trustworthy keys.
 */
export interface ApiGatewayEventLike {
  headers?: Record<string, string | undefined> | null;
  requestContext?: {
    /** REST API (payload v1). */
    identity?: { sourceIp?: string };
    /** HTTP API (payload v2). */
    http?: { sourceIp?: string };
  };
}

/** A structured Lambda proxy result (`statusCode` + optional `headers`/`body`); extra fields pass through. */
export interface LambdaResultLike {
  statusCode: number;
  headers?: Record<string, string | number | boolean>;
  body?: string;
}

/** A Lambda proxy handler `(event, context?, ...) => result`. */
export type LambdaHandler<E, R> = (event: E, ...rest: unknown[]) => R | Promise<R>;

/** Options for {@link lambdaRateLimit}. */
export type LambdaRateLimitOptions<E extends ApiGatewayEventLike> = EnforceOptions & {
  /** Cost of a request in limiter units. A function computes it per event. Default 1. */
  cost?: number | ((event: E) => number);
  /** Derive the limit key from the event. Default: the API Gateway-provided `sourceIp` (or `"anon"`). */
  key?: (event: E) => string;
};

/** The API Gateway-provided caller IP (v2 `http.sourceIp` → v1 `identity.sourceIp` → `"anon"`). */
export function sourceIpOf(event: ApiGatewayEventLike): string {
  return event.requestContext?.http?.sourceIp ?? event.requestContext?.identity?.sourceIp ?? "anon";
}

/**
 * Wrap a Lambda API Gateway proxy handler with rate limiting.
 *
 * @example
 * ```ts
 * import { lambdaRateLimit } from "throttlekit/lambda";
 * import { gcra } from "throttlekit";
 * import { RedisStore } from "throttlekit/redis";
 *
 * export const handler = lambdaRateLimit(myHandler, {
 *   strategy: gcra({ limit: 100, periodMs: 60_000 }),
 *   store: new RedisStore({ client }), // a shared store: each invocation is a cold-ish process
 * });
 * ```
 */
export function lambdaRateLimit<E extends ApiGatewayEventLike, R extends LambdaResultLike>(
  handler: LambdaHandler<E, R>,
  options: LambdaRateLimitOptions<E>,
): (event: E, ...rest: unknown[]) => Promise<LambdaResultLike> {
  const enforcer = createEnforcer(options);
  const keyFn: (event: E) => string = options.key ?? sourceIpOf;
  const costOpt = options.cost ?? 1;

  return async (event: E, ...rest: unknown[]): Promise<LambdaResultLike> => {
    const key = keyFn(event);
    const cost = typeof costOpt === "function" ? costOpt(event) : costOpt;
    const r = await enforcer.enforce(key, cost);

    if (r.allowed) {
      // fail-open store outage: no headers to add — just forward.
      if (r.outcome === "error") return handler(event, ...rest);
      const result = await handler(event, ...rest);
      // Merge the rate-limit headers onto the handler's result (they take precedence on a clash).
      return { ...result, headers: { ...result.headers, ...r.headers } };
    }

    if (r.outcome === "limited") {
      return {
        statusCode: 429,
        headers: { ...r.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Too Many Requests", retryAfterMs: r.retryAfterMs }),
      };
    }
    // fail-closed store outage.
    return {
      statusCode: 503,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "rate limiter unavailable" }),
    };
  };
}
