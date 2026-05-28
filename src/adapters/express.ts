/**
 * Express adapter. Wraps a {@link Limiter} (prebuilt or constructed inline) as a `RequestHandler`
 * that derives a proxy-correct client-IP key by default, enforces the limit, emits standards
 * headers, and responds `429` with `Retry-After` on a denial — with explicit fail-open/closed
 * behavior when the store is unreachable. See THROTTLEKIT.md §§14,15.
 *
 * Also exposes {@link expressUnifiedAdmission} and {@link expressAdaptiveConcurrency} (0.9.2,
 * TK-1325) that wire the `release()` lifecycle to `res.on("finish")` + `res.on("close")` using
 * the first-fire-wins pattern. See `research/bigger-bets/middleware-integration/DESIGN.md`.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
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

export type ExpressRateLimitOptions = LimiterOrStrategy &
  CommonAdapterOptions & {
    /** Cost of a request in limiter units. A function computes it per request. Default 1. */
    cost?: number | ((req: Request) => number);
    /** Derive the limit key from a request. Default: proxy-correct, aggregated client IP. */
    key?: (req: Request) => string;
    /** Observability hook fired on every denial, before the response is written. */
    onLimited?: (req: Request, res: Response, decision: Decision) => void;
    /** Observability hook fired when the store throws (before the fail policy is applied). */
    onError?: (req: Request, res: Response, err: unknown) => void;
    /** Custom 429 responder. When provided, it fully owns the denial response. */
    handler?: (req: Request, res: Response, decision: Decision) => void;
  };

/**
 * Create an Express middleware enforcing a rate limit.
 *
 * @example
 * app.use(expressRateLimit({ strategy: gcra({ limit: 100, periodMs: 60_000 }) }));
 */
export function expressRateLimit(options: ExpressRateLimitOptions): RequestHandler {
  const gate = createGate(options);
  const trust = trustFrom(options);
  const keyFn = options.key ?? ((req: Request) => nodeClientIp(req, trust));
  const costOpt = options.cost ?? 1;

  const setHeaders = (res: Response, decision: Decision): void => {
    for (const [name, value] of Object.entries(gate.headersFor(decision))) {
      res.setHeader(name, value);
    }
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyFn(req);
    const cost = typeof costOpt === "function" ? costOpt(req) : costOpt;

    void (async (): Promise<void> => {
      let decision: Decision;
      try {
        decision = await gate.limiter.check(key, cost);
      } catch (err) {
        options.onError?.(req, res, err);
        if (gate.fail === "open") {
          next();
          return;
        }
        res.status(503);
        if (typeof res.json === "function") {
          res.json({ error: "rate limiter unavailable" });
        } else {
          res.end();
        }
        return;
      }

      setHeaders(res, decision);

      if (decision.allowed) {
        next();
        return;
      }

      options.onLimited?.(req, res, decision);
      if (options.handler !== undefined) {
        options.handler(req, res, decision);
        return;
      }
      res.status(429);
      if (typeof res.json === "function") {
        res.json({ error: "Too Many Requests", retryAfterMs: decision.retryAfterMs });
      } else {
        res.end("Too Many Requests");
      }
    })();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// unifiedAdmission + adaptiveConcurrency middleware (0.9.2 / TK-1325).
// Both wire `release()` to the response lifecycle using the first-fire-wins
// pattern from research/bigger-bets/middleware-integration/DESIGN.md §6.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-axis Decision snapshot from `admitter.lastDecisions()`. */
type AxisSnapshot = Readonly<Record<UnifiedAxis, Decision | undefined>>;

/** Options for {@link expressUnifiedAdmission}. */
export type ExpressUnifiedAdmissionOptions = Pick<
  CommonAdapterOptions,
  "fail" | "emit" | "policyName" | "trustProxy" | "ipv6Prefix"
> & {
  /** The unified admitter to enforce. Build it once with `unifiedAdmission({...})` and pass it in. */
  admitter: UnifiedAdmitter;
  /** Cost passed to the cost axis. Defaults to 1. */
  cost?: number | ((req: Request) => number);
  /** Key passed to the rate/cost axes (concurrency is keyless). Defaults to the proxy-correct client IP. */
  key?: (req: Request) => string;
  /** Clock used for header delta math. Default {@link systemClock}. */
  clock?: Clock;
  /**
   * Treat 5xx responses as `dropped: true` for the adaptive controller. Default `false`
   * (a returned 5xx is application policy; the lifecycle nominally completed). See DESIGN.md §5.
   */
  dropOn5xx?: boolean;
  /** Fired on every denial, with the combined Decision and per-axis snapshot. */
  onLimited?: (req: Request, res: Response, decision: Decision, axes: AxisSnapshot) => void;
  /** Fired when `admit()` throws (before the fail policy is applied). */
  onError?: (req: Request, res: Response, err: unknown) => void;
  /** Custom 429 responder; when provided it fully owns the denial response. */
  handler?: (req: Request, res: Response, decision: Decision, axes: AxisSnapshot) => void;
};

/**
 * Express middleware enforcing a {@link UnifiedAdmitter} — rate + adaptive concurrency + cost
 * in one call. On admit it wires `release()` to the response lifecycle (D-M-3 + §6 of the design):
 * `finish` first ⇒ `dropped: false`, `close` first (client hangup / handler throw without error
 * middleware) ⇒ `dropped: true`. On deny it short-circuits with 429; no slot is held.
 *
 * @example
 * const admitter = unifiedAdmission({ rate, concurrency, cost });
 * app.use(expressUnifiedAdmission({ admitter, dropOn5xx: false }));
 */
export function expressUnifiedAdmission(options: ExpressUnifiedAdmissionOptions): RequestHandler {
  const { admitter } = options;
  const trust = trustFrom(options);
  const keyFn = options.key ?? ((req: Request) => nodeClientIp(req, trust));
  const costOpt = options.cost ?? 1;
  const fail: FailMode = options.fail ?? "open";
  const emit: HeaderEmit | false = options.emit ?? { draft: true };
  const policyName = options.policyName ?? "unified";
  const clock = options.clock ?? systemClock;
  const dropOn5xx = options.dropOn5xx ?? false;

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyFn(req);
    const cost = typeof costOpt === "function" ? costOpt(req) : costOpt;

    void (async (): Promise<void> => {
      let decision: Decision;
      let release: (opts?: { dropped?: boolean }) => void;
      try {
        const result = await admitter.admit({ key, cost });
        decision = result.decision;
        release = result.release;
      } catch (err) {
        options.onError?.(req, res, err);
        if (fail === "open") {
          next();
          return;
        }
        res.status(503);
        if (typeof res.json === "function") {
          res.json({ error: "admission unavailable" });
        } else {
          res.end();
        }
        return;
      }

      // Snapshot axes in the same microtask as the await result, before any subsequent
      // admit can mutate `lastDecisions()` (D-M-5 / §8 of the design).
      const axes = admitter.lastDecisions();

      const headers = unifiedHeadersFor(decision, emit, policyName, clock.now());
      for (const [name, value] of Object.entries(headers)) {
        res.setHeader(name, value);
      }

      if (!decision.allowed) {
        // Deny path: release was a NOOP_RELEASE from unifiedAdmission's short-circuit,
        // so no lifecycle wiring is needed. Just respond.
        options.onLimited?.(req, res, decision, axes);
        if (options.handler !== undefined) {
          options.handler(req, res, decision, axes);
          return;
        }
        res.status(429);
        if (typeof res.json === "function") {
          res.json({ error: "Too Many Requests", retryAfterMs: decision.retryAfterMs });
        } else {
          res.end("Too Many Requests");
        }
        return;
      }

      // Triple-admitted: wire the release to the response lifecycle and forward to the handler.
      wireResponseLifecycle(res as LifecycleResponseLike, release, dropOn5xx);
      next();
    })();
  };
}

/** Options for {@link expressAdaptiveConcurrency}. */
export type ExpressAdaptiveConcurrencyOptions = Pick<
  CommonAdapterOptions,
  "fail" | "emit" | "policyName"
> & {
  /** The concurrency guard to enforce. Build with `adaptiveConcurrency({...})` and pass it in. */
  guard: ConcurrencyGuard;
  /** Clock used for header delta math. Default {@link systemClock}. */
  clock?: Clock;
  /** Treat 5xx responses as `dropped: true` for the adaptive controller. Default `false`. See §5 of DESIGN.md. */
  dropOn5xx?: boolean;
  /** Fired on every denial. */
  onLimited?: (req: Request, res: Response, decision: Decision) => void;
  /** Custom 429 responder. */
  handler?: (req: Request, res: Response, decision: Decision) => void;
};

/**
 * Express middleware enforcing an adaptive {@link ConcurrencyGuard}. On admit it wires
 * `release()` to the response lifecycle so completions/aborts feed the controller's RTT
 * sampler correctly. On deny (over the inferred ceiling) it short-circuits with 429 +
 * `Retry-After: max(1, round(lastRtt))` — the honest Little's-Law hint.
 *
 * Concurrency is keyless: the guard counts global in-flight slots, not per-IP. If you need
 * per-tenant fairness, compose with `weightedFairEscrow` (0.9.1) ahead of this middleware.
 *
 * @example
 * const guard = adaptiveConcurrency({ minLimit: 4, maxLimit: 128 });
 * app.use(expressAdaptiveConcurrency({ guard }));
 */
export function expressAdaptiveConcurrency(
  options: ExpressAdaptiveConcurrencyOptions,
): RequestHandler {
  const { guard } = options;
  const emit: HeaderEmit | false = options.emit ?? { draft: true };
  const policyName = options.policyName ?? "adaptive";
  const clock = options.clock ?? systemClock;
  const dropOn5xx = options.dropOn5xx ?? false;

  return (req: Request, res: Response, next: NextFunction): void => {
    const lease = guard.acquire();
    const now = clock.now();

    if (!lease.ok) {
      // Over the inferred ceiling. Build a Decision-shaped denial for the headers / hook.
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
        res.setHeader(name, value);
      }
      options.onLimited?.(req, res, decision);
      if (options.handler !== undefined) {
        options.handler(req, res, decision);
        return;
      }
      res.status(429);
      if (typeof res.json === "function") {
        res.json({ error: "Too Many Requests", retryAfterMs: decision.retryAfterMs });
      } else {
        res.end("Too Many Requests");
      }
      return;
    }

    // Allow path: emit headers, wire lifecycle, forward.
    const decision: Decision = {
      allowed: true,
      limit: guard.limit,
      remaining: Math.max(0, guard.limit - guard.inflight),
      resetAt: now,
      retryAfterMs: 0,
    };
    const headers = unifiedHeadersFor(decision, emit, policyName, now);
    for (const [name, value] of Object.entries(headers)) {
      res.setHeader(name, value);
    }
    wireResponseLifecycle(res as LifecycleResponseLike, lease.release, dropOn5xx);
    next();
  };
}
