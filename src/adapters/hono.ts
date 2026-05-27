/**
 * Hono v4 middleware adapter. Wraps a route with a rate-limit gate: on allow it sets the
 * rate-limit headers on the context and forwards to `next()`; on deny it short-circuits with a
 * `429` JSON response carrying the same headers plus `Retry-After`. Store outages resolve via the
 * explicit fail policy (a fail-closed outage returns `503`). The limit key derives from the raw
 * Web `Request` (`c.req.raw`): `cf-connecting-ip` → `x-forwarded-for` → `"anon"`. See
 * THROTTLEKIT.md §§14,15.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import type { Decision } from "../core/types";
import {
  type CommonAdapterOptions,
  type LimiterOrStrategy,
  createGate,
  edgeClientIp,
  trustFrom,
} from "./core";

export type { CommonAdapterOptions, LimiterOrStrategy } from "./core";

export type HonoRateLimitOptions = LimiterOrStrategy &
  CommonAdapterOptions & {
    /** Cost of a request in limiter units. A function computes it per request. Default 1. */
    cost?: number | ((c: Context) => number);
    /** Derive the limit key from the context. Default: `cf-connecting-ip` → `x-forwarded-for` → `"anon"`. */
    key?: (c: Context) => string;
    /** Observability hook fired on every denial. */
    onLimited?: (c: Context, decision: Decision) => void;
    /** Observability hook fired when the store throws (before the fail policy is applied). */
    onError?: (c: Context, err: unknown) => void;
    /** Custom 429 responder. When provided, it fully owns the denial response. */
    handler?: (c: Context, decision: Decision) => Response | Promise<Response>;
  };

/**
 * Build Hono middleware that rate-limits requests reaching the routes it guards.
 *
 * @example
 * import { Hono } from "hono";
 * import { honoRateLimit } from "throttlekit/hono";
 * import { gcra } from "throttlekit";
 *
 * const app = new Hono();
 * app.use("*", honoRateLimit({ strategy: gcra({ limit: 30, periodMs: 10_000 }) }));
 * app.get("/", (c) => c.text("ok"));
 */
export function honoRateLimit(options: HonoRateLimitOptions): MiddlewareHandler {
  const gate = createGate(options);
  const trust = trustFrom(options);
  const keyFn =
    options.key ?? ((c: Context) => edgeClientIp(c.req.raw, trust, options.trustClientIpHeader));
  const costOpt = options.cost ?? 1;

  return async (c: Context, next: Next): Promise<Response | undefined> => {
    const key = keyFn(c);
    const cost = typeof costOpt === "function" ? costOpt(c) : costOpt;

    let decision: Decision;
    try {
      decision = await gate.limiter.check(key, cost);
    } catch (err) {
      options.onError?.(c, err);
      if (gate.fail === "open") {
        await next();
        return;
      }
      return c.json({ error: "rate limiter unavailable" }, 503);
    }

    const headers = gate.headersFor(decision);

    if (decision.allowed) {
      for (const [name, value] of Object.entries(headers)) {
        c.header(name, value);
      }
      await next();
      return;
    }

    options.onLimited?.(c, decision);
    if (options.handler !== undefined) {
      const custom = await options.handler(c, decision);
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

    for (const [name, value] of Object.entries(headers)) {
      c.header(name, value);
    }
    return c.json({ error: "Too Many Requests", retryAfterMs: decision.retryAfterMs }, 429);
  };
}
