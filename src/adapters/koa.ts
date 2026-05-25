/**
 * Koa v3 adapter. Wraps a {@link Limiter} (prebuilt or constructed inline) as Koa `Middleware`
 * that derives a proxy-correct client-IP key by default, enforces the limit, emits standards
 * headers, and responds `429` with `Retry-After` on a denial — with explicit fail-open/closed
 * behavior when the store is unreachable. Mirrors the Express adapter's control flow, adapted to
 * Koa's single `ctx`. See THROTTLEKIT.md §§14,15.
 */

import type { Context, Middleware } from "koa";
import type { Decision } from "../core/types";
import {
  type CommonAdapterOptions,
  type LimiterOrStrategy,
  createGate,
  nodeClientIp,
  trustFrom,
} from "./core";

export type { CommonAdapterOptions, LimiterOrStrategy } from "./core";

export type KoaRateLimitOptions = LimiterOrStrategy &
  CommonAdapterOptions & {
    /** Cost of a request in limiter units. A function computes it per request. Default 1. */
    cost?: number | ((ctx: Context) => number);
    /** Derive the limit key from the context. Default: proxy-correct, aggregated client IP. */
    key?: (ctx: Context) => string;
    /** Observability hook fired on every denial, before the response is written. */
    onLimited?: (ctx: Context, decision: Decision) => void;
    /** Observability hook fired when the store throws (before the fail policy is applied). */
    onError?: (ctx: Context, err: unknown) => void;
    /**
     * Custom 429 responder. When provided, it fully owns the denial response (set `ctx.status` /
     * `ctx.body` yourself). The standards headers are already applied before it runs.
     */
    handler?: (ctx: Context, decision: Decision) => void;
  };

/**
 * Create a Koa middleware enforcing a rate limit. The default client-IP key reads
 * `ctx.req` (the Node `IncomingMessage`), so it is correct independent of Koa's `app.proxy`
 * setting; headers are applied with `ctx.set`.
 *
 * @example
 * app.use(koaRateLimit({ strategy: gcra({ limit: 100, periodMs: 60_000 }) }));
 */
export function koaRateLimit(options: KoaRateLimitOptions): Middleware {
  const gate = createGate(options);
  const trust = trustFrom(options);
  const keyFn = options.key ?? ((ctx: Context) => nodeClientIp(ctx.req, trust));
  const costOpt = options.cost ?? 1;

  const setHeaders = (ctx: Context, decision: Decision): void => {
    for (const [name, value] of Object.entries(gate.headersFor(decision))) {
      ctx.set(name, value);
    }
  };

  return async (ctx: Context, next: () => Promise<unknown>): Promise<void> => {
    const key = keyFn(ctx);
    const cost = typeof costOpt === "function" ? costOpt(ctx) : costOpt;

    let decision: Decision;
    try {
      decision = await gate.limiter.check(key, cost);
    } catch (err) {
      options.onError?.(ctx, err);
      if (gate.fail === "open") {
        await next();
        return;
      }
      ctx.status = 503;
      ctx.body = { error: "rate limiter unavailable" };
      return;
    }

    setHeaders(ctx, decision);

    if (decision.allowed) {
      await next();
      return;
    }

    options.onLimited?.(ctx, decision);
    if (options.handler !== undefined) {
      options.handler(ctx, decision);
      return;
    }
    ctx.status = 429;
    ctx.body = { error: "Too Many Requests", retryAfterMs: decision.retryAfterMs };
  };
}
