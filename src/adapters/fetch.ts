/**
 * Web-standard `fetch` adapter for edge runtimes (Cloudflare Workers, Deno, Bun, Next.js edge).
 * Wraps a `(Request, ...args) => Response` handler with a rate-limit gate: on allow it forwards to
 * the handler and copies the rate-limit headers onto the returned `Response`; on deny it returns a
 * `429` with `Retry-After`. Store outages resolve via the explicit fail policy. Uses the global
 * Web `Request`/`Response`/`Headers` (Node 18+). See THROTTLEKIT.md §§14,15.
 *
 * Also exposes {@link withUnifiedAdmission} and {@link withAdaptiveConcurrency} (0.9.2, TK-1326)
 * that wire `release()` by wrapping the returned `Response.body` ReadableStream — completion
 * (`done`), errors, and consumer cancellation each map to a single release call with the right
 * `dropped` value. See `research/bigger-bets/middleware-integration/DESIGN.md` §6.
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
  const keyFn =
    options.key ??
    ((request: Request) => edgeClientIp(request, trust, options.trustClientIpHeader));
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

// ─────────────────────────────────────────────────────────────────────────────
// unifiedAdmission + adaptiveConcurrency wrap (0.9.2 / TK-1326).
// ─────────────────────────────────────────────────────────────────────────────

/** Per-axis Decision snapshot from `admitter.lastDecisions()`. */
type AxisSnapshot = Readonly<Record<UnifiedAxis, Decision | undefined>>;

/** Options for {@link withUnifiedAdmission}. */
export type WithUnifiedAdmissionOptions = Pick<
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
 * Wrap a fetch handler with a {@link UnifiedAdmitter}. On admit it forwards to the handler,
 * then wraps `Response.body` so the release fires when the body stream completes / errors /
 * is cancelled.
 *
 * @example
 * export default {
 *   fetch: withUnifiedAdmission(myHandler, { admitter }),
 * };
 */
export function withUnifiedAdmission(
  handler: FetchHandler,
  options: WithUnifiedAdmissionOptions,
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
      const result = await admitter.admit({ key, cost });
      decision = result.decision;
      release = result.release;
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

    // Admitted. Call the inner handler; wrap its Response.body for lifecycle.
    let response: Response;
    try {
      response = await handler(request, ...args);
    } catch (err) {
      // Handler threw before producing a Response. Release as dropped.
      release({ dropped: true });
      throw err;
    }

    // Merge our admission headers onto the response.
    const merged = new Headers(response.headers);
    for (const [n, v] of unifiedHeadersWeb(decision, emit, policyName, now).entries()) {
      merged.set(n, v);
    }
    const wrapped = wrapResponseStreamLifecycle(
      new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: merged,
      }),
      release,
      dropOn5xx,
    );
    return wrapped;
  };
}

/** Options for {@link withAdaptiveConcurrency}. */
export type WithAdaptiveConcurrencyOptions = Pick<
  CommonAdapterOptions,
  "fail" | "emit" | "policyName"
> & {
  guard: ConcurrencyGuard;
  clock?: Clock;
  dropOn5xx?: boolean;
  onLimited?: (request: Request, decision: Decision) => void;
  handler?: (request: Request, decision: Decision) => Response | Promise<Response>;
};

/**
 * Wrap a fetch handler with an adaptive {@link ConcurrencyGuard}. The release is wired to the
 * Response body stream lifecycle.
 */
export function withAdaptiveConcurrency(
  handler: FetchHandler,
  options: WithAdaptiveConcurrencyOptions,
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
