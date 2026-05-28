/**
 * Next.js middleware adapter — dependency-free. `NextRequest` extends the Web `Request` and
 * `NextResponse` extends the Web `Response`, so this binds to the Web standards and never imports
 * `"next"`. Call the limiter at the top of your middleware: on allow it hands back the rate-limit
 * headers for you to copy onto `NextResponse.next()`; on deny (or a fail-closed store outage) it
 * hands back a ready `Response` (the `429`/`503`) for you to return directly. The limit key derives
 * from the request: `cf-connecting-ip` → `x-forwarded-for` → `"anon"`. See THROTTLEKIT.md §§14,15.
 *
 * Also exposes {@link nextUnifiedAdmission} and {@link nextAdaptiveConcurrency} (0.9.2, TK-1326)
 * — HOC-style wrappers around a route handler that wire Response body lifecycle to release.
 */

import type { UnifiedAdmitter, UnifiedAxis } from "../admission/unified";
import type { ConcurrencyGuard } from "../concurrency/adaptive";
import { systemClock } from "../core/clock";
import type { Clock, Decision, FailMode } from "../core/types";
import type { HeaderEmit } from "../http/headers";
import {
  type CommonAdapterOptions,
  type LimiterOrStrategy,
  createGate,
  edgeClientIp,
  trustFrom,
} from "./core";
import {
  defaultDenyResponse,
  defaultUnavailableResponse,
  unifiedHeadersWeb,
  wrapResponseStreamLifecycle,
} from "./lifecycle-web";

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
 * import { nextRateLimit } from "throttlekit/next";
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
  const keyFn =
    options.key ??
    ((request: Request) => edgeClientIp(request, trust, options.trustClientIpHeader));
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

// ─────────────────────────────────────────────────────────────────────────────
// unifiedAdmission + adaptiveConcurrency HOC wrap (0.9.2 / TK-1326).
// Wrap a Next.js route handler (middleware or App Router) with admission +
// Response body lifecycle. Both `pages/api` (Node) and middleware/route
// handlers (Web Request) return Response shapes.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-axis Decision snapshot from `admitter.lastDecisions()`. */
type AxisSnapshot = Readonly<Record<UnifiedAxis, Decision | undefined>>;

/** A Next-style handler: `(Request, ...args) => Response`. */
export type NextHandler = (request: Request, ...args: unknown[]) => Response | Promise<Response>;

/** Options for {@link nextUnifiedAdmission}. */
export type NextUnifiedAdmissionOptions = Pick<
  CommonAdapterOptions,
  "fail" | "emit" | "policyName" | "trustProxy" | "ipv6Prefix" | "trustClientIpHeader"
> & {
  admitter: UnifiedAdmitter;
  cost?: number | ((request: Request) => number);
  key?: (request: Request) => string;
  clock?: Clock;
  dropOn5xx?: boolean;
  onLimited?: (request: Request, decision: Decision, axes: AxisSnapshot) => void;
  onError?: (request: Request, err: unknown) => void;
  handler?: (
    request: Request,
    decision: Decision,
    axes: AxisSnapshot,
  ) => Response | Promise<Response>;
};

/**
 * Wrap a Next.js handler with a {@link UnifiedAdmitter}. Use in App Router route handlers
 * or in `middleware.ts`. On admit it wraps `Response.body` for lifecycle release.
 */
export function nextUnifiedAdmission(
  handler: NextHandler,
  options: NextUnifiedAdmissionOptions,
): (request: Request, ...args: unknown[]) => Promise<Response> {
  const { admitter } = options;
  const trust = trustFrom(options);
  const keyFn =
    options.key ??
    ((request: Request) => edgeClientIp(request, trust, options.trustClientIpHeader));
  const costOpt = options.cost ?? 1;
  const fail: FailMode = options.fail ?? "open";
  const emit: HeaderEmit | false = options.emit ?? { draft: true };
  const policyName = options.policyName ?? "unified";
  const clock = options.clock ?? systemClock;
  const dropOn5xx = options.dropOn5xx ?? false;

  return async (request: Request, ...args: unknown[]): Promise<Response> => {
    const key = keyFn(request);
    const cost = typeof costOpt === "function" ? costOpt(request) : costOpt;

    let decision: Decision;
    let release: (opts?: { dropped?: boolean }) => void;
    try {
      const r = await admitter.admit({ key, cost });
      decision = r.decision;
      release = r.release;
    } catch (err) {
      options.onError?.(request, err);
      if (fail === "open") return handler(request, ...args);
      return defaultUnavailableResponse();
    }

    const axes = admitter.lastDecisions();
    const now = clock.now();

    if (!decision.allowed) {
      options.onLimited?.(request, decision, axes);
      if (options.handler !== undefined) {
        const custom = await options.handler(request, decision, axes);
        const merged = new Headers(custom.headers);
        for (const [n, v] of unifiedHeadersWeb(decision, emit, policyName, now).entries()) {
          if (!merged.has(n)) merged.set(n, v);
        }
        return new Response(custom.body, {
          status: custom.status,
          statusText: custom.statusText,
          headers: merged,
        });
      }
      return defaultDenyResponse(decision, emit, policyName, now);
    }

    let response: Response;
    try {
      response = await handler(request, ...args);
    } catch (err) {
      release({ dropped: true });
      throw err;
    }
    const merged = new Headers(response.headers);
    for (const [n, v] of unifiedHeadersWeb(decision, emit, policyName, now).entries()) {
      merged.set(n, v);
    }
    return wrapResponseStreamLifecycle(
      new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: merged,
      }),
      release,
      dropOn5xx,
    );
  };
}

/** Options for {@link nextAdaptiveConcurrency}. */
export type NextAdaptiveConcurrencyOptions = Pick<
  CommonAdapterOptions,
  "fail" | "emit" | "policyName"
> & {
  guard: ConcurrencyGuard;
  clock?: Clock;
  dropOn5xx?: boolean;
  onLimited?: (request: Request, decision: Decision) => void;
  handler?: (request: Request, decision: Decision) => Response | Promise<Response>;
};

/** Wrap a Next.js handler with an adaptive {@link ConcurrencyGuard}. */
export function nextAdaptiveConcurrency(
  handler: NextHandler,
  options: NextAdaptiveConcurrencyOptions,
): (request: Request, ...args: unknown[]) => Promise<Response> {
  const { guard } = options;
  const emit: HeaderEmit | false = options.emit ?? { draft: true };
  const policyName = options.policyName ?? "adaptive";
  const clock = options.clock ?? systemClock;
  const dropOn5xx = options.dropOn5xx ?? false;

  return async (request: Request, ...args: unknown[]): Promise<Response> => {
    const lease = guard.acquire();
    const now = clock.now();

    if (!lease.ok) {
      const lastRtt = guard.stats().lastRtt;
      const decision: Decision = {
        allowed: false,
        limit: guard.limit,
        remaining: 0,
        resetAt: now,
        retryAfterMs: Math.max(1, Math.round(lastRtt || 1)),
      };
      options.onLimited?.(request, decision);
      if (options.handler !== undefined) {
        const custom = await options.handler(request, decision);
        const merged = new Headers(custom.headers);
        for (const [n, v] of unifiedHeadersWeb(decision, emit, policyName, now).entries()) {
          if (!merged.has(n)) merged.set(n, v);
        }
        return new Response(custom.body, {
          status: custom.status,
          statusText: custom.statusText,
          headers: merged,
        });
      }
      return defaultDenyResponse(decision, emit, policyName, now);
    }

    const decision: Decision = {
      allowed: true,
      limit: guard.limit,
      remaining: Math.max(0, guard.limit - guard.inflight),
      resetAt: now,
      retryAfterMs: 0,
    };
    let response: Response;
    try {
      response = await handler(request, ...args);
    } catch (err) {
      lease.release({ dropped: true });
      throw err;
    }
    const merged = new Headers(response.headers);
    for (const [n, v] of unifiedHeadersWeb(decision, emit, policyName, now).entries()) {
      merged.set(n, v);
    }
    return wrapResponseStreamLifecycle(
      new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: merged,
      }),
      lease.release,
      dropOn5xx,
    );
  };
}
