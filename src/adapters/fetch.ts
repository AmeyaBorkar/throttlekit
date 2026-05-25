/**
 * Web-standard `fetch` adapter for edge runtimes (Cloudflare Workers, Deno, Bun, Next.js edge).
 * Wraps a `(Request, ...args) => Response` handler with a rate-limit gate: on allow it forwards to
 * the handler and copies the rate-limit headers onto the returned `Response`; on deny it returns a
 * `429` with `Retry-After`. Store outages resolve via the explicit fail policy. Uses the global
 * Web `Request`/`Response`/`Headers` (Node 18+). See THROTTLEKIT.md §§14,15.
 */

import type { Decision } from "../core/types";
import {
  type CommonAdapterOptions,
  type LimiterOrStrategy,
  createGate,
  edgeClientIp,
  trustFrom,
} from "./core";

export type { CommonAdapterOptions, LimiterOrStrategy } from "./core";

/** A Web-`fetch` style handler: receives a `Request` (plus any runtime args) and returns a `Response`. */
export type FetchHandler = (request: Request, ...args: unknown[]) => Response | Promise<Response>;

/** @deprecated Use {@link LimiterOrStrategy}. Kept as an alias for source compatibility. */
export type FetchLimiterOrStrategy = LimiterOrStrategy;

export type FetchRateLimitOptions = LimiterOrStrategy &
  CommonAdapterOptions & {
    /** Cost of a request in limiter units. A function computes it per request. Default 1. */
    cost?: number | ((request: Request) => number);
    /** Derive the limit key from a request. Default: `cf-connecting-ip` → `x-forwarded-for` → `"anon"`. */
    key?: (request: Request) => string;
    /** Observability hook fired on every denial. */
    onLimited?: (request: Request, decision: Decision) => void;
    /** Observability hook fired when the store throws (before the fail policy is applied). */
    onError?: (request: Request, err: unknown) => void;
    /** Custom 429 responder. When provided, it fully owns the denial response. */
    handler?: (request: Request, decision: Decision) => Response | Promise<Response>;
  };

/**
 * Wrap a `fetch` handler with rate limiting.
 *
 * @example
 * export default { fetch: withRateLimit(handler, { strategy: gcra({ limit: 30, periodMs: 10_000 }) }) };
 */
export function withRateLimit(
  handler: FetchHandler,
  options: FetchRateLimitOptions,
): (request: Request, ...args: unknown[]) => Promise<Response> {
  const gate = createGate(options);
  const trust = trustFrom(options);
  const keyFn = options.key ?? ((request: Request) => edgeClientIp(request, trust));
  const costOpt = options.cost ?? 1;

  return async (request: Request, ...args: unknown[]): Promise<Response> => {
    const key = keyFn(request);
    const cost = typeof costOpt === "function" ? costOpt(request) : costOpt;

    let decision: Decision;
    try {
      decision = await gate.limiter.check(key, cost);
    } catch (err) {
      options.onError?.(request, err);
      if (gate.fail === "open") {
        return handler(request, ...args);
      }
      return new Response(JSON.stringify({ error: "rate limiter unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    const headers = gate.headersFor(decision);

    if (decision.allowed) {
      const res = await handler(request, ...args);
      // Copy the rate-limit headers onto a clone of the handler's response (don't mutate shared state).
      const merged = new Headers(res.headers);
      for (const [name, value] of Object.entries(headers)) {
        merged.set(name, value);
      }
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: merged,
      });
    }

    options.onLimited?.(request, decision);
    if (options.handler !== undefined) {
      const custom = await options.handler(request, decision);
      const merged = new Headers(custom.headers);
      for (const [name, value] of Object.entries(headers)) {
        if (!merged.has(name)) merged.set(name, value);
      }
      return new Response(custom.body, {
        status: custom.status,
        statusText: custom.statusText,
        headers: merged,
      });
    }

    const denyHeaders = new Headers(headers);
    denyHeaders.set("Content-Type", "application/json");
    return new Response(
      JSON.stringify({ error: "Too Many Requests", retryAfterMs: decision.retryAfterMs }),
      { status: 429, headers: denyHeaders },
    );
  };
}
