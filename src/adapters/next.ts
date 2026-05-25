/**
 * Next.js middleware adapter — dependency-free. `NextRequest` extends the Web `Request` and
 * `NextResponse` extends the Web `Response`, so this binds to the Web standards and never imports
 * `"next"`. Call the limiter at the top of your middleware: on allow it hands back the rate-limit
 * headers for you to copy onto `NextResponse.next()`; on deny (or a fail-closed store outage) it
 * hands back a ready `Response` (the `429`/`503`) for you to return directly. The limit key derives
 * from the request: `cf-connecting-ip` → `x-forwarded-for` → `"anon"`. See THROTTLEKIT.md §§14,15.
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

export type NextRateLimitOptions = LimiterOrStrategy &
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
 * The result of one rate-limit check, telling the caller what to do next.
 *
 * - `{ limited: false; headers }` — allow the request; apply `headers` to `NextResponse.next()`.
 *   On a fail-open store outage this is `{ limited: false; headers: {} }` (nothing to copy).
 * - `{ limited: true; response }` — return `response` directly; it is the `429` (or, on a
 *   fail-closed store outage, the `503`) Web `Response` with the rate-limit headers attached.
 */
export type NextRateLimitResult =
  | { limited: false; headers: Record<string, string> }
  | { limited: true; response: Response };

/**
 * Build a rate limiter for Next.js middleware. The returned function takes the request and returns
 * a {@link NextRateLimitResult} you branch on.
 *
 * @example
 * // middleware.ts
 * import { NextResponse, type NextRequest } from "next/server";
 * import { nextRateLimit } from "throttlekit/adapters/next";
 * import { gcra } from "throttlekit";
 *
 * const limit = nextRateLimit({ strategy: gcra({ limit: 30, periodMs: 10_000 }) });
 *
 * export async function middleware(req: NextRequest) {
 *   const r = await limit(req);
 *   if (r.limited) return r.response;
 *   const res = NextResponse.next();
 *   for (const [k, v] of Object.entries(r.headers)) res.headers.set(k, v);
 *   return res;
 * }
 */
export function nextRateLimit(
  options: NextRateLimitOptions,
): (request: Request) => Promise<NextRateLimitResult> {
  const gate = createGate(options);
  const trust = trustFrom(options);
  const keyFn = options.key ?? ((request: Request) => edgeClientIp(request, trust));
  const costOpt = options.cost ?? 1;

  return async (request: Request): Promise<NextRateLimitResult> => {
    const key = keyFn(request);
    const cost = typeof costOpt === "function" ? costOpt(request) : costOpt;

    let decision: Decision;
    try {
      decision = await gate.limiter.check(key, cost);
    } catch (err) {
      options.onError?.(request, err);
      if (gate.fail === "open") {
        return { limited: false, headers: {} };
      }
      return {
        limited: true,
        response: new Response(JSON.stringify({ error: "rate limiter unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      };
    }

    const headers = gate.headersFor(decision);

    if (decision.allowed) {
      return { limited: false, headers };
    }

    options.onLimited?.(request, decision);
    if (options.handler !== undefined) {
      const custom = await options.handler(request, decision);
      const merged = new Headers(custom.headers);
      for (const [name, value] of Object.entries(headers)) {
        if (!merged.has(name)) merged.set(name, value);
      }
      return {
        limited: true,
        response: new Response(custom.body, {
          status: custom.status,
          statusText: custom.statusText,
          headers: merged,
        }),
      };
    }

    const denyHeaders = new Headers(headers);
    denyHeaders.set("Content-Type", "application/json");
    return {
      limited: true,
      response: new Response(
        JSON.stringify({ error: "Too Many Requests", retryAfterMs: decision.retryAfterMs }),
        { status: 429, headers: denyHeaders },
      ),
    };
  };
}
