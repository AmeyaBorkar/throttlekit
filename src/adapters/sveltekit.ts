/**
 * SvelteKit adapter. Builds a server `handle` hook that gates every request: on allow it forwards to
 * `resolve(event)` and copies the standards headers onto the response; on deny it returns a `429`
 * with `Retry-After`; a fail-closed store outage returns `503`. The limit key defaults to
 * SvelteKit's `event.getClientAddress()` (the platform-resolved client IP). The `RequestEvent`/
 * `Handle` shapes are modeled structurally, so a real `@sveltejs/kit` `Handle` satisfies them with no
 * dependency. See THROTTLEKIT.md §§14,15.
 */

import type { Decision } from "../core/types";
import { type CommonAdapterOptions, type LimiterOrStrategy, createGate } from "./core";

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
