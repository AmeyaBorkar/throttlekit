/**
 * Hono v4 middleware adapter. Wraps a route with a rate-limit gate: on allow it sets the
 * rate-limit headers on the context and forwards to `next()`; on deny it short-circuits with a
 * `429` JSON response carrying the same headers plus `Retry-After`. Store outages resolve via the
 * explicit fail policy (a fail-closed outage returns `503`). The limit key derives from the raw
 * Web `Request` (`c.req.raw`): `cf-connecting-ip` → `x-forwarded-for` → `"anon"`. See
 * THROTTLEKIT.md §§14,15.
 *
 * Also exposes {@link honoUnifiedAdmission} and {@link honoAdaptiveConcurrency} (0.9.2,
 * TK-1326) using the try/finally wrap pattern: `release` fires with `dropped = thrown`.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
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
import { unifiedHeadersWeb } from "./lifecycle-web";

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

// ─────────────────────────────────────────────────────────────────────────────
// unifiedAdmission + adaptiveConcurrency middleware (0.9.2 / TK-1326).
// Hono's middleware shape is `(c, next) => Promise<Response | undefined>`,
// which makes the try/finally wrap pattern natural — see DESIGN.md §6.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-axis Decision snapshot from `admitter.lastDecisions()`. */
type AxisSnapshot = Readonly<Record<UnifiedAxis, Decision | undefined>>;

/** Options for {@link honoUnifiedAdmission}. */
export type HonoUnifiedAdmissionOptions = Pick<
  CommonAdapterOptions,
  "fail" | "emit" | "policyName" | "trustProxy" | "ipv6Prefix" | "trustClientIpHeader"
> & {
  admitter: UnifiedAdmitter;
  cost?: number | ((c: Context) => number);
  key?: (c: Context) => string;
  clock?: Clock;
  /** Treat 5xx responses as `dropped: true`. Default `false` (DESIGN.md §5). */
  dropOn5xx?: boolean;
  onLimited?: (c: Context, decision: Decision, axes: AxisSnapshot) => void;
  onError?: (c: Context, err: unknown) => void;
  handler?: (c: Context, decision: Decision, axes: AxisSnapshot) => Response | Promise<Response>;
};

/**
 * Hono middleware enforcing a {@link UnifiedAdmitter}. On admit it forwards to `next()` inside
 * a try/finally; on a thrown handler, `release({ dropped: true })`; on a clean return,
 * `release({ dropped: false })` (or `true` if `dropOn5xx` and the response status is 5xx).
 *
 * @example
 * app.use("*", honoUnifiedAdmission({ admitter }));
 */
export function honoUnifiedAdmission(options: HonoUnifiedAdmissionOptions): MiddlewareHandler {
  const { admitter } = options;
  const trust = trustFrom(options);
  const keyFn =
    options.key ?? ((c: Context) => edgeClientIp(c.req.raw, trust, options.trustClientIpHeader));
  const costOpt = options.cost ?? 1;
  const fail: FailMode = options.fail ?? "open";
  const emit: HeaderEmit | false = options.emit ?? { draft: true };
  const policyName = options.policyName ?? "unified";
  const clock = options.clock ?? systemClock;
  const dropOn5xx = options.dropOn5xx ?? false;

  return async (c: Context, next: Next): Promise<Response | undefined> => {
    const key = keyFn(c);
    const cost = typeof costOpt === "function" ? costOpt(c) : costOpt;

    let decision: Decision;
    let release: (opts?: { dropped?: boolean }) => void;
    try {
      const result = await admitter.admit({ key, cost });
      decision = result.decision;
      release = result.release;
    } catch (err) {
      options.onError?.(c, err);
      if (fail === "open") {
        await next();
        return;
      }
      return c.json({ error: "admission unavailable" }, 503);
    }

    const axes = admitter.lastDecisions();
    const headers = unifiedHeadersWeb(decision, emit, policyName, clock.now());
    for (const [name, value] of headers.entries()) c.header(name, value);

    if (!decision.allowed) {
      options.onLimited?.(c, decision, axes);
      if (options.handler !== undefined) {
        return await options.handler(c, decision, axes);
      }
      return c.json({ error: "Too Many Requests", retryAfterMs: decision.retryAfterMs }, 429);
    }

    // Try/finally wrap: dropped = the handler chain threw.
    let thrown = false;
    try {
      await next();
    } catch (err) {
      thrown = true;
      throw err;
    } finally {
      const status = c.res?.status ?? 200;
      release({ dropped: thrown || (dropOn5xx && status >= 500) });
    }
    return undefined;
  };
}

/** Options for {@link honoAdaptiveConcurrency}. */
export type HonoAdaptiveConcurrencyOptions = Pick<
  CommonAdapterOptions,
  "fail" | "emit" | "policyName"
> & {
  guard: ConcurrencyGuard;
  clock?: Clock;
  dropOn5xx?: boolean;
  onLimited?: (c: Context, decision: Decision) => void;
  handler?: (c: Context, decision: Decision) => Response | Promise<Response>;
};

/** Hono middleware enforcing an adaptive {@link ConcurrencyGuard}. */
export function honoAdaptiveConcurrency(
  options: HonoAdaptiveConcurrencyOptions,
): MiddlewareHandler {
  const { guard } = options;
  const emit: HeaderEmit | false = options.emit ?? { draft: true };
  const policyName = options.policyName ?? "adaptive";
  const clock = options.clock ?? systemClock;
  const dropOn5xx = options.dropOn5xx ?? false;

  return async (c: Context, next: Next): Promise<Response | undefined> => {
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
      const headers = unifiedHeadersWeb(decision, emit, policyName, now);
      for (const [name, value] of headers.entries()) c.header(name, value);
      options.onLimited?.(c, decision);
      if (options.handler !== undefined) {
        return await options.handler(c, decision);
      }
      return c.json({ error: "Too Many Requests", retryAfterMs: decision.retryAfterMs }, 429);
    }

    const decision: Decision = {
      allowed: true,
      limit: guard.limit,
      remaining: Math.max(0, guard.limit - guard.inflight),
      resetAt: now,
      retryAfterMs: 0,
    };
    const headers = unifiedHeadersWeb(decision, emit, policyName, now);
    for (const [name, value] of headers.entries()) c.header(name, value);

    let thrown = false;
    try {
      await next();
    } catch (err) {
      thrown = true;
      throw err;
    } finally {
      const status = c.res?.status ?? 200;
      lease.release({ dropped: thrown || (dropOn5xx && status >= 500) });
    }
    return undefined;
  };
}
