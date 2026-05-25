/**
 * Express adapter. Wraps a {@link Limiter} (prebuilt or constructed inline) as a `RequestHandler`
 * that derives a proxy-correct client-IP key by default, enforces the limit, emits standards
 * headers, and responds `429` with `Retry-After` on a denial — with explicit fail-open/closed
 * behavior when the store is unreachable. See THROTTLEKIT.md §§14,15.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Decision } from "../core/types";
import {
  type CommonAdapterOptions,
  type LimiterOrStrategy,
  createGate,
  nodeClientIp,
  trustFrom,
} from "./core";

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
