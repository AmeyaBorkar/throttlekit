/**
 * Koa v3 adapter. Wraps a {@link Limiter} (prebuilt or constructed inline) as Koa `Middleware`
 * that derives a proxy-correct client-IP key by default, enforces the limit, emits standards
 * headers, and responds `429` with `Retry-After` on a denial — with explicit fail-open/closed
 * behavior when the store is unreachable. Mirrors the Express adapter's control flow, adapted to
 * Koa's single `ctx`. See THROTTLEKIT.md §§14,15.
 *
 * Also exposes {@link koaUnifiedAdmission} and {@link koaAdaptiveConcurrency} (0.9.2, TK-1325)
 * that wire `release()` to `ctx.res.on("finish")` + `ctx.res.on("close")`.
 */

import type { Context, Middleware } from "koa";
import type { UnifiedAdmitter, UnifiedAxis } from "../admission/unified";
import type { ConcurrencyGuard } from "../concurrency/adaptive";
import { systemClock } from "../core/clock";
import type { Clock, Decision, FailMode } from "../core/types";
import type { HeaderEmit } from "../http/headers";
import {
  type CommonAdapterOptions,
  type LimiterOrStrategy,
  createGate,
  nodeClientIp,
  trustFrom,
} from "./core";
import { type LifecycleResponseLike, unifiedHeadersFor, wireResponseLifecycle } from "./lifecycle";

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

// ─────────────────────────────────────────────────────────────────────────────
// unifiedAdmission + adaptiveConcurrency middleware (0.9.2 / TK-1325).
// ─────────────────────────────────────────────────────────────────────────────

/** Per-axis Decision snapshot from `admitter.lastDecisions()`. */
type AxisSnapshot = Readonly<Record<UnifiedAxis, Decision | undefined>>;

/** Options for {@link koaUnifiedAdmission}. */
export type KoaUnifiedAdmissionOptions = Pick<
  CommonAdapterOptions,
  "fail" | "emit" | "policyName" | "trustProxy" | "ipv6Prefix"
> & {
  /** The unified admitter to enforce. */
  admitter: UnifiedAdmitter;
  /** Cost passed to the cost axis. Defaults to 1. */
  cost?: number | ((ctx: Context) => number);
  /** Key passed to the rate/cost axes. Default: client IP. */
  key?: (ctx: Context) => string;
  /** Clock used for header delta math. */
  clock?: Clock;
  /** Treat 5xx as `dropped: true`. Default false. */
  dropOn5xx?: boolean;
  /** Fired on every denial. */
  onLimited?: (ctx: Context, decision: Decision, axes: AxisSnapshot) => void;
  /** Fired when `admit()` throws. */
  onError?: (ctx: Context, err: unknown) => void;
  /** Custom 429 responder. */
  handler?: (ctx: Context, decision: Decision, axes: AxisSnapshot) => void;
};

/**
 * Koa middleware enforcing a {@link UnifiedAdmitter}. On admit it wires `release()` to
 * `ctx.res` (the Node response). The middleware does NOT `await next()` itself for the
 * lifecycle — the response events fire from Node's stream, so the `await next()` pattern
 * would double-fire. See `research/bigger-bets/middleware-integration/DESIGN.md` §4.
 */
export function koaUnifiedAdmission(options: KoaUnifiedAdmissionOptions): Middleware {
  const { admitter } = options;
  const trust = trustFrom(options);
  const keyFn = options.key ?? ((ctx: Context) => nodeClientIp(ctx.req, trust));
  const costOpt = options.cost ?? 1;
  const fail: FailMode = options.fail ?? "open";
  const emit: HeaderEmit | false = options.emit ?? { draft: true };
  const policyName = options.policyName ?? "unified";
  const clock = options.clock ?? systemClock;
  const dropOn5xx = options.dropOn5xx ?? false;

  return async (ctx: Context, next: () => Promise<unknown>): Promise<void> => {
    const key = keyFn(ctx);
    const cost = typeof costOpt === "function" ? costOpt(ctx) : costOpt;

    let decision: Decision;
    let release: (opts?: { dropped?: boolean }) => void;
    try {
      const result = await admitter.admit({ key, cost });
      decision = result.decision;
      release = result.release;
    } catch (err) {
      options.onError?.(ctx, err);
      if (fail === "open") {
        await next();
        return;
      }
      ctx.status = 503;
      ctx.body = { error: "admission unavailable" };
      return;
    }

    const axes = admitter.lastDecisions();
    const headers = unifiedHeadersFor(decision, emit, policyName, clock.now());
    for (const [name, value] of Object.entries(headers)) {
      ctx.set(name, value);
    }

    if (!decision.allowed) {
      options.onLimited?.(ctx, decision, axes);
      if (options.handler !== undefined) {
        options.handler(ctx, decision, axes);
        return;
      }
      ctx.status = 429;
      ctx.body = { error: "Too Many Requests", retryAfterMs: decision.retryAfterMs };
      return;
    }

    wireResponseLifecycle(ctx.res as unknown as LifecycleResponseLike, release, dropOn5xx);
    await next();
  };
}

/** Options for {@link koaAdaptiveConcurrency}. */
export type KoaAdaptiveConcurrencyOptions = Pick<
  CommonAdapterOptions,
  "fail" | "emit" | "policyName"
> & {
  /** The concurrency guard to enforce. */
  guard: ConcurrencyGuard;
  /** Clock used for header delta math. */
  clock?: Clock;
  /** Treat 5xx as `dropped: true`. Default false. */
  dropOn5xx?: boolean;
  /** Fired on every denial. */
  onLimited?: (ctx: Context, decision: Decision) => void;
  /** Custom 429 responder. */
  handler?: (ctx: Context, decision: Decision) => void;
};

/**
 * Koa middleware enforcing an adaptive {@link ConcurrencyGuard}. Wires release to ctx.res
 * lifecycle so completions/aborts feed the controller.
 */
export function koaAdaptiveConcurrency(options: KoaAdaptiveConcurrencyOptions): Middleware {
  const { guard } = options;
  const emit: HeaderEmit | false = options.emit ?? { draft: true };
  const policyName = options.policyName ?? "adaptive";
  const clock = options.clock ?? systemClock;
  const dropOn5xx = options.dropOn5xx ?? false;

  return async (ctx: Context, next: () => Promise<unknown>): Promise<void> => {
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
      const headers = unifiedHeadersFor(decision, emit, policyName, now);
      for (const [name, value] of Object.entries(headers)) {
        ctx.set(name, value);
      }
      options.onLimited?.(ctx, decision);
      if (options.handler !== undefined) {
        options.handler(ctx, decision);
        return;
      }
      ctx.status = 429;
      ctx.body = { error: "Too Many Requests", retryAfterMs: decision.retryAfterMs };
      return;
    }

    const decision: Decision = {
      allowed: true,
      limit: guard.limit,
      remaining: Math.max(0, guard.limit - guard.inflight),
      resetAt: now,
      retryAfterMs: 0,
    };
    const headers = unifiedHeadersFor(decision, emit, policyName, now);
    for (const [name, value] of Object.entries(headers)) {
      ctx.set(name, value);
    }
    wireResponseLifecycle(ctx.res as unknown as LifecycleResponseLike, lease.release, dropOn5xx);
    await next();
  };
}
