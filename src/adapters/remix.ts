/**
 * Remix / React Router adapter. Exposes a guard you call at the top of a `loader`/`action`: under the
 * limit it resolves to the standards headers (attach them via `json(data, { headers })`); over the
 * limit it **throws** a `429` `Response` (Remix renders thrown Responses); a fail-closed store outage
 * throws `503`. The key derives from the Web `Request` — `cf-connecting-ip`/trusted `x-forwarded-for`
 * → `"anon"` (audit TK-S01) — overridable. See THROTTLEKIT.md §§14,15.
 *
 * Also exposes {@link remixUnifiedAdmission} and {@link remixAdaptiveConcurrency} (0.9.2,
 * TK-1326) — HOC-style wrappers around a loader/action returning a Response.
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

export type RemixRateLimitOptions = LimiterOrStrategy &
  CommonAdapterOptions & {
    /** Cost of a request in limiter units. A function computes it per request. Default 1. */
    cost?: number | ((request: Request) => number);
    /** Derive the limit key from the request. Default: edge client IP (see {@link edgeClientIp}). */
    key?: (request: Request) => string;
    /** Observability hook fired on every denial, before the `Response` is thrown. */
    onLimited?: (request: Request, decision: Decision) => void;
    /** Observability hook fired when the store throws (before the fail policy is applied). */
    onError?: (request: Request, err: unknown) => void;
    /** Custom denial responder; its `Response` is thrown instead of the default 429. */
    handler?: (request: Request, decision: Decision) => Response | Promise<Response>;
  };

/** A Remix guard: resolves to headers to attach on allow; throws a `Response` on deny. */
export type RemixRateLimitGuard = (request: Request) => Promise<Record<string, string>>;

/**
 * Build a Remix loader/action rate-limit guard.
 *
 * @example
 * ```ts
 * const rateLimit = remixRateLimit({ strategy: gcra({ limit: 60, periodMs: 60_000 }) });
 * export async function loader({ request }: LoaderFunctionArgs) {
 *   const headers = await rateLimit(request); // throws a 429 Response when over the limit
 *   return json(await getData(), { headers });
 * }
 * ```
 */
export function remixRateLimit(options: RemixRateLimitOptions): RemixRateLimitGuard {
  const gate = createGate(options);
  const trust = trustFrom(options);
  const keyFn =
    options.key ??
    ((request: Request) => edgeClientIp(request, trust, options.trustClientIpHeader));
  const costOpt = options.cost ?? 1;

  return async (request: Request): Promise<Record<string, string>> => {
    const key = keyFn(request);
    const cost = typeof costOpt === "function" ? costOpt(request) : costOpt;

    let decision: Decision;
    try {
      decision = await gate.limiter.check(key, cost);
    } catch (err) {
      options.onError?.(request, err);
      if (gate.fail === "open") return {};
      throw new Response(JSON.stringify({ error: "rate limiter unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    const headers = gate.headersFor(decision);
    if (decision.allowed) return headers;

    options.onLimited?.(request, decision);
    if (options.handler !== undefined) throw await options.handler(request, decision);
    const denyHeaders = new Headers(headers);
    denyHeaders.set("Content-Type", "application/json");
    throw new Response(
      JSON.stringify({ error: "Too Many Requests", retryAfterMs: decision.retryAfterMs }),
      { status: 429, headers: denyHeaders },
    );
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// unifiedAdmission + adaptiveConcurrency HOC wrap (0.9.2 / TK-1326).
// ─────────────────────────────────────────────────────────────────────────────

/** Per-axis Decision snapshot. */
type AxisSnapshot = Readonly<Record<UnifiedAxis, Decision | undefined>>;

/** A Remix-style loader/action — receives `{request, ...}` and returns a Response. */
export type RemixLoaderHandler = (args: { request: Request; [k: string]: unknown }) =>
  | Response
  | Promise<Response>;

/** Options for {@link remixUnifiedAdmission}. */
export type RemixUnifiedAdmissionOptions = Pick<
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
};

/**
 * Wrap a Remix loader/action with a {@link UnifiedAdmitter}. The release fires when the
 * Response body completes / errors / is cancelled.
 *
 * @example
 * export const loader = remixUnifiedAdmission(async ({ request }) => json(await getData()), { admitter });
 */
export function remixUnifiedAdmission(
  handler: RemixLoaderHandler,
  options: RemixUnifiedAdmissionOptions,
): RemixLoaderHandler {
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

  return async (args): Promise<Response> => {
    const { request } = args;
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
      if (fail === "open") return handler(args);
      return defaultUnavailableResponse();
    }

    const axes = admitter.lastDecisions();
    const now = clock.now();

    if (!decision.allowed) {
      options.onLimited?.(request, decision, axes);
      return defaultDenyResponse(decision, emit, policyName, now);
    }

    let response: Response;
    try {
      response = await handler(args);
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

/** Options for {@link remixAdaptiveConcurrency}. */
export type RemixAdaptiveConcurrencyOptions = Pick<
  CommonAdapterOptions,
  "fail" | "emit" | "policyName"
> & {
  guard: ConcurrencyGuard;
  clock?: Clock;
  dropOn5xx?: boolean;
  onLimited?: (request: Request, decision: Decision) => void;
};

/** Wrap a Remix loader/action with an adaptive {@link ConcurrencyGuard}. */
export function remixAdaptiveConcurrency(
  handler: RemixLoaderHandler,
  options: RemixAdaptiveConcurrencyOptions,
): RemixLoaderHandler {
  const { guard } = options;
  const emit: HeaderEmit | false = options.emit ?? { draft: true };
  const policyName = options.policyName ?? "adaptive";
  const clock = options.clock ?? systemClock;
  const dropOn5xx = options.dropOn5xx ?? false;

  return async (args): Promise<Response> => {
    const { request } = args;
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
      response = await handler(args);
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
