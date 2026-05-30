/**
 * SvelteKit adapter. Builds a server `handle` hook that gates every request: on allow it forwards to
 * `resolve(event)` and copies the standards headers onto the response; on deny it returns a `429`
 * with `Retry-After`; a fail-closed store outage returns `503`. The limit key defaults to
 * SvelteKit's `event.getClientAddress()` (the platform-resolved client IP). The `RequestEvent`/
 * `Handle` shapes are modeled structurally, so a real `@sveltejs/kit` `Handle` satisfies them with no
 * dependency. See THROTTLEKIT.md §§14,15.
 *
 * Also exposes {@link sveltekitUnifiedAdmission} and {@link sveltekitAdaptiveConcurrency} (0.9.2,
 * TK-1326) that wrap the resolved Response body for release lifecycle.
 */

import type { UnifiedAdmitter, UnifiedAxis } from "../admission/unified";
import type { ConcurrencyGuard } from "../concurrency/adaptive";
import { systemClock } from "../core/clock";
import type { Clock, Decision, FailMode } from "../core/types";
import type { HeaderEmit } from "../http/headers";
import { type CommonAdapterOptions, type LimiterOrStrategy, createGate } from "./core";
import {
  defaultDenyResponse,
  defaultUnavailableResponse,
  unifiedHeadersWeb,
  wrapResponseStreamLifecycle,
} from "./lifecycle-web";

export type { CommonAdapterOptions, LimiterOrStrategy } from "./core";

/** The slice of a SvelteKit `RequestEvent` the adapter reads. */
export interface SvelteKitRequestEvent {
  request: Request;
  /** SvelteKit's platform-resolved client address (respects the adapter's trust configuration). */
  getClientAddress(): string;
}

/** SvelteKit's `resolve(event)` continuation. */
export type SvelteKitResolve = (event: SvelteKitRequestEvent) => Response | Promise<Response>;

/** The input to a SvelteKit `handle` hook. */
export interface SvelteKitHandleInput {
  event: SvelteKitRequestEvent;
  resolve: SvelteKitResolve;
}

/** A SvelteKit server `handle` hook. */
export type SvelteKitHandle = (input: SvelteKitHandleInput) => Promise<Response>;

export type SvelteKitRateLimitOptions = LimiterOrStrategy &
  CommonAdapterOptions & {
    /** Cost of a request in limiter units. A function computes it per event. Default 1. */
    cost?: number | ((event: SvelteKitRequestEvent) => number);
    /** Derive the limit key from the event. Default: `event.getClientAddress()`. */
    key?: (event: SvelteKitRequestEvent) => string;
    /** Observability hook fired on every denial. */
    onLimited?: (event: SvelteKitRequestEvent, decision: Decision) => void;
    /** Observability hook fired when the store throws (before the fail policy is applied). */
    onError?: (event: SvelteKitRequestEvent, err: unknown) => void;
    /** Custom 429 responder. When provided, it fully owns the denial response. */
    handler?: (event: SvelteKitRequestEvent, decision: Decision) => Response | Promise<Response>;
  };

/** Copy `headers` onto a clone of `res` (don't mutate the original); existing names are overwritten. */
function withHeaders(res: Response, headers: Record<string, string>): Response {
  const merged = new Headers(res.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: merged,
  });
}

/**
 * Build a SvelteKit `handle` hook that rate-limits requests.
 *
 * @example
 * ```ts
 * // src/hooks.server.ts
 * import { sveltekitRateLimit } from "throttlekit/sveltekit";
 * import { gcra } from "throttlekit";
 * export const handle = sveltekitRateLimit({ strategy: gcra({ limit: 60, periodMs: 60_000 }) });
 * ```
 */
export function sveltekitRateLimit(options: SvelteKitRateLimitOptions): SvelteKitHandle {
  const gate = createGate(options);
  const keyFn = options.key ?? ((event: SvelteKitRequestEvent) => event.getClientAddress());
  const costOpt = options.cost ?? 1;

  return async ({ event, resolve }: SvelteKitHandleInput): Promise<Response> => {
    const key = keyFn(event);
    const cost = typeof costOpt === "function" ? costOpt(event) : costOpt;

    let decision: Decision;
    try {
      decision = await gate.limiter.check(key, cost);
    } catch (err) {
      options.onError?.(event, err);
      if (gate.fail === "open") return resolve(event);
      return new Response(JSON.stringify({ error: "rate limiter unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    const headers = gate.headersFor(decision);
    if (decision.allowed) return withHeaders(await resolve(event), headers);

    options.onLimited?.(event, decision);
    if (options.handler !== undefined) {
      return withHeaders(await options.handler(event, decision), headers);
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
// unifiedAdmission + adaptiveConcurrency SvelteKit handle hooks (0.9.2 / TK-1326).
// ─────────────────────────────────────────────────────────────────────────────

/** Per-axis Decision snapshot from `admitter.lastDecisions()`. */
type AxisSnapshot = Readonly<Partial<Record<UnifiedAxis, Decision | undefined>>>;

/** Options for {@link sveltekitUnifiedAdmission}. */
export type SvelteKitUnifiedAdmissionOptions = Pick<
  CommonAdapterOptions,
  "fail" | "emit" | "policyName"
> & {
  admitter: UnifiedAdmitter;
  cost?: number | ((event: SvelteKitRequestEvent) => number);
  key?: (event: SvelteKitRequestEvent) => string;
  clock?: Clock;
  dropOn5xx?: boolean;
  onLimited?: (event: SvelteKitRequestEvent, decision: Decision, axes: AxisSnapshot) => void;
  onError?: (event: SvelteKitRequestEvent, err: unknown) => void;
  handler?: (
    event: SvelteKitRequestEvent,
    decision: Decision,
    axes: AxisSnapshot,
  ) => Response | Promise<Response>;
};

/** Build a SvelteKit `handle` hook enforcing a {@link UnifiedAdmitter}. */
export function sveltekitUnifiedAdmission(
  options: SvelteKitUnifiedAdmissionOptions,
): SvelteKitHandle {
  const { admitter } = options;
  const keyFn = options.key ?? ((event: SvelteKitRequestEvent) => event.getClientAddress());
  const costOpt = options.cost ?? 1;
  const fail: FailMode = options.fail ?? "open";
  const emit: HeaderEmit | false = options.emit ?? { draft: true };
  const policyName = options.policyName ?? "unified";
  const clock = options.clock ?? systemClock;
  const dropOn5xx = options.dropOn5xx ?? false;

  return async ({ event, resolve }: SvelteKitHandleInput): Promise<Response> => {
    const key = keyFn(event);
    const cost = typeof costOpt === "function" ? costOpt(event) : costOpt;

    let decision: Decision;
    let release: (opts?: { dropped?: boolean }) => void;
    try {
      const r = await admitter.admit({ key, cost });
      decision = r.decision;
      release = r.release;
    } catch (err) {
      options.onError?.(event, err);
      if (fail === "open") return resolve(event);
      return defaultUnavailableResponse();
    }

    const axes = admitter.lastDecisions();
    const now = clock.now();

    if (!decision.allowed) {
      options.onLimited?.(event, decision, axes);
      if (options.handler !== undefined) {
        const custom = await options.handler(event, decision, axes);
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
      response = await resolve(event);
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

/** Options for {@link sveltekitAdaptiveConcurrency}. */
export type SvelteKitAdaptiveConcurrencyOptions = Pick<
  CommonAdapterOptions,
  "fail" | "emit" | "policyName"
> & {
  guard: ConcurrencyGuard;
  clock?: Clock;
  dropOn5xx?: boolean;
  onLimited?: (event: SvelteKitRequestEvent, decision: Decision) => void;
  handler?: (event: SvelteKitRequestEvent, decision: Decision) => Response | Promise<Response>;
};

/** Build a SvelteKit `handle` hook enforcing an adaptive {@link ConcurrencyGuard}. */
export function sveltekitAdaptiveConcurrency(
  options: SvelteKitAdaptiveConcurrencyOptions,
): SvelteKitHandle {
  const { guard } = options;
  const emit: HeaderEmit | false = options.emit ?? { draft: true };
  const policyName = options.policyName ?? "adaptive";
  const clock = options.clock ?? systemClock;
  const dropOn5xx = options.dropOn5xx ?? false;

  return async ({ event, resolve }: SvelteKitHandleInput): Promise<Response> => {
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
      options.onLimited?.(event, decision);
      if (options.handler !== undefined) {
        const custom = await options.handler(event, decision);
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
      response = await resolve(event);
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
