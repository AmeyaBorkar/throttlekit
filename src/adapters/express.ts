/**
 * Express adapter. Wraps a {@link Limiter} (prebuilt or constructed inline) as a `RequestHandler`
 * that derives a proxy-correct client-IP key by default, enforces the limit, emits standards
 * headers, and responds `429` with `Retry-After` on a denial — with explicit fail-open/closed
 * behavior when the store is unreachable. See THROTTLEKIT.md §§14,15.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { systemClock } from "../core/clock";
import { rateLimit } from "../core/limiter";
import type { Clock, Decision, FailMode, Limiter, Store, Strategy } from "../core/types";
import {
  type BuildRateLimitHeadersOptions,
  type HeaderEmit,
  buildRateLimitHeaders,
} from "../http/headers";
import { type TrustProxyConfig, clientIp } from "../security/ip";

/** Options shared by every adapter (Express and fetch alike). */
export interface CommonAdapterOptions extends TrustProxyConfig {
  /** Store-outage behavior: `"open"` allows, `"closed"` denies. Default `"open"`. */
  fail?: FailMode;
  /** Header families to emit, or `false` to emit none. Default `{ draft: true }`. */
  emit?: HeaderEmit | false;
  /** Policy name surfaced in structured headers. Defaults to the strategy name. */
  policyName?: string;
}

/** Either pass a prebuilt limiter, or the pieces to build one inline. */
export type LimiterOrStrategy =
  | { limiter: Limiter }
  | {
      /** The algorithm to enforce when no `limiter` is supplied. */
      strategy: Strategy;
      /** Where state lives. Defaults to a fresh in-process MemoryStore. */
      store?: Store;
      /** Injected clock. Defaults to the system clock. */
      clock?: Clock;
      /** Key namespace, so one store can back many limiters. */
      prefix?: string;
    };

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

/** Resolve the union to a concrete limiter, building one from the strategy when needed. */
function resolveLimiter(options: LimiterOrStrategy): Limiter {
  if ("limiter" in options) return options.limiter;
  return rateLimit({
    strategy: options.strategy,
    ...(options.store !== undefined ? { store: options.store } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
  });
}

/**
 * The clock used for header delta math. It must match the limiter's clock for `RateLimit-Reset`
 * to be correct (and deterministic under `ManualClock` in tests): when building inline we reuse
 * the supplied `clock`; with a prebuilt limiter we fall back to the system clock.
 */
function resolveClock(options: LimiterOrStrategy): Clock {
  if ("limiter" in options) return systemClock;
  return options.clock ?? systemClock;
}

/** Default key: the proxy-correct, aggregated client IP from the socket peer + `X-Forwarded-For`. */
function defaultKey(req: Request, trust: TrustProxyConfig): string {
  const remoteAddr = req.socket?.remoteAddress ?? "";
  const xff = req.headers["x-forwarded-for"];
  return clientIp({ remoteAddr, xForwardedFor: xff }, trust);
}

/** Build header-emit options from the strategy (policy name + window) at a given instant. */
function headerOptionsFor(
  strategy: Strategy,
  now: number,
  emit: HeaderEmit,
  policyName: string | undefined,
): BuildRateLimitHeadersOptions {
  const windowSeconds =
    strategy.windowMs !== undefined ? Math.round(strategy.windowMs / 1000) : undefined;
  return {
    now,
    emit,
    policyName: policyName ?? strategy.name,
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
  };
}

/**
 * Create an Express middleware enforcing a rate limit.
 *
 * @example
 * app.use(expressRateLimit({ strategy: gcra({ limit: 100, periodMs: 60_000 }) }));
 */
export function expressRateLimit(options: ExpressRateLimitOptions): RequestHandler {
  const limiter = resolveLimiter(options);
  const clock = resolveClock(options);
  const strategy = limiter.strategy;
  const fail: FailMode = options.fail ?? "open";
  const emit: HeaderEmit | false = options.emit ?? { draft: true };
  const trust: TrustProxyConfig = {
    ...(options.trustProxy !== undefined ? { trustProxy: options.trustProxy } : {}),
    ...(options.ipv6Prefix !== undefined ? { ipv6Prefix: options.ipv6Prefix } : {}),
  };
  const keyFn = options.key ?? ((req: Request) => defaultKey(req, trust));
  const costOpt = options.cost ?? 1;
  const policyName = options.policyName;

  const setHeaders = (res: Response, decision: Decision): void => {
    if (emit === false) return;
    const headers = buildRateLimitHeaders(
      decision,
      headerOptionsFor(strategy, clock.now(), emit, policyName),
    );
    for (const [name, value] of Object.entries(headers)) {
      res.setHeader(name, value);
    }
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyFn(req);
    const cost = typeof costOpt === "function" ? costOpt(req) : costOpt;

    void (async (): Promise<void> => {
      let decision: Decision;
      try {
        decision = await limiter.check(key, cost);
      } catch (err) {
        options.onError?.(req, res, err);
        if (fail === "open") {
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
