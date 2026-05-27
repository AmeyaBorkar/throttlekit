/**
 * Elysia adapter. Builds an `onBeforeHandle` hook that gates the routes it guards: it sets the
 * standards headers on the context, then either lets the handler run (returns `undefined`) or
 * short-circuits with a `429` body and `set.status`; a fail-closed store outage short-circuits with
 * `503`. The key derives from the Web `Request` — `cf-connecting-ip`/trusted `x-forwarded-for` →
 * `"anon"` (audit TK-S01) — overridable. The context shape is modeled structurally, so a real Elysia
 * context satisfies it with no dependency. See THROTTLEKIT.md §§14,15.
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

/** The slice of an Elysia context the adapter reads/writes: the request and the mutable response `set`. */
export interface ElysiaContextLike {
  request: Request;
  set: {
    status?: number | string;
    headers: Record<string, string>;
  };
}

/** An Elysia `onBeforeHandle` hook: returns `undefined` to proceed, or a value to short-circuit. */
export type ElysiaRateLimitHook = (ctx: ElysiaContextLike) => unknown;

export type ElysiaRateLimitOptions = LimiterOrStrategy &
  CommonAdapterOptions & {
    /** Cost of a request in limiter units. A function computes it per context. Default 1. */
    cost?: number | ((ctx: ElysiaContextLike) => number);
    /** Derive the limit key from the context. Default: edge client IP (see {@link edgeClientIp}). */
    key?: (ctx: ElysiaContextLike) => string;
    /** Observability hook fired on every denial. */
    onLimited?: (ctx: ElysiaContextLike, decision: Decision) => void;
    /** Observability hook fired when the store throws (before the fail policy is applied). */
    onError?: (ctx: ElysiaContextLike, err: unknown) => void;
    /** Custom denial responder; its return value becomes the short-circuit response body. */
    handler?: (ctx: ElysiaContextLike, decision: Decision) => unknown;
  };

/**
 * Build an Elysia `onBeforeHandle` hook that rate-limits requests.
 *
 * @example
 * ```ts
 * import { Elysia } from "elysia";
 * import { elysiaRateLimit } from "throttlekit/elysia";
 * import { gcra } from "throttlekit";
 * new Elysia()
 *   .onBeforeHandle(elysiaRateLimit({ strategy: gcra({ limit: 30, periodMs: 10_000 }) }))
 *   .get("/", () => "ok");
 * ```
 */
export function elysiaRateLimit(options: ElysiaRateLimitOptions): ElysiaRateLimitHook {
  const gate = createGate(options);
  const trust = trustFrom(options);
  const keyFn =
    options.key ??
    ((ctx: ElysiaContextLike) => edgeClientIp(ctx.request, trust, options.trustClientIpHeader));
  const costOpt = options.cost ?? 1;

  return async (ctx: ElysiaContextLike): Promise<unknown> => {
    const key = keyFn(ctx);
    const cost = typeof costOpt === "function" ? costOpt(ctx) : costOpt;

    let decision: Decision;
    try {
      decision = await gate.limiter.check(key, cost);
    } catch (err) {
      options.onError?.(ctx, err);
      if (gate.fail === "open") return undefined; // let the handler run
      ctx.set.status = 503;
      return { error: "rate limiter unavailable" };
    }

    for (const [name, value] of Object.entries(gate.headersFor(decision))) {
      ctx.set.headers[name] = value;
    }
    if (decision.allowed) return undefined; // proceed to the handler

    options.onLimited?.(ctx, decision);
    if (options.handler !== undefined) {
      ctx.set.status = 429;
      return options.handler(ctx, decision);
    }
    ctx.set.status = 429;
    return { error: "Too Many Requests", retryAfterMs: decision.retryAfterMs };
  };
}
