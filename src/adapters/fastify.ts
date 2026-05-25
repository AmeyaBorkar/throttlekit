/**
 * Fastify v5 adapter. Wraps a {@link Limiter} (prebuilt or constructed inline) as an `onRequest`
 * hook that derives a proxy-correct client-IP key by default, enforces the limit, emits standards
 * headers, and responds `429` with `Retry-After` on a denial — with explicit fail-open/closed
 * behavior when the store is unreachable. Mirrors the Express adapter's option shape and control
 * flow exactly. See THROTTLEKIT.md §§14,15.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Decision } from "../core/types";
import {
  type CommonAdapterOptions,
  type LimiterOrStrategy,
  createGate,
  nodeClientIp,
  trustFrom,
} from "./core";

export type { CommonAdapterOptions, LimiterOrStrategy } from "./core";

export type FastifyRateLimitOptions = LimiterOrStrategy &
  CommonAdapterOptions & {
    /** Cost of a request in limiter units. A function computes it per request. Default 1. */
    cost?: number | ((request: FastifyRequest) => number);
    /** Derive the limit key from a request. Default: proxy-correct, aggregated client IP. */
    key?: (request: FastifyRequest) => string;
    /** Observability hook fired on every denial, before the response is written. */
    onLimited?: (request: FastifyRequest, reply: FastifyReply, decision: Decision) => void;
    /** Observability hook fired when the store throws (before the fail policy is applied). */
    onError?: (request: FastifyRequest, reply: FastifyReply, err: unknown) => void;
    /** Custom 429 responder. When provided, it fully owns the denial response. */
    handler?: (request: FastifyRequest, reply: FastifyReply, decision: Decision) => void;
  };

/**
 * Create a Fastify `onRequest` hook enforcing a rate limit. Register it with `addHook`; sending a
 * terminal reply inside an async `onRequest` hook short-circuits the lifecycle, so denials never
 * reach the route handler.
 *
 * @example
 * fastify.addHook("onRequest", fastifyRateLimit({ strategy: gcra({ limit: 100, periodMs: 60_000 }) }));
 */
export function fastifyRateLimit(
  options: FastifyRateLimitOptions,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const gate = createGate(options);
  const trust = trustFrom(options);
  const keyFn = options.key ?? ((request: FastifyRequest) => nodeClientIp(request, trust));
  const costOpt = options.cost ?? 1;

  const setHeaders = (reply: FastifyReply, decision: Decision): void => {
    for (const [name, value] of Object.entries(gate.headersFor(decision))) {
      reply.header(name, value);
    }
  };

  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const key = keyFn(request);
    const cost = typeof costOpt === "function" ? costOpt(request) : costOpt;

    let decision: Decision;
    try {
      decision = await gate.limiter.check(key, cost);
    } catch (err) {
      options.onError?.(request, reply, err);
      if (gate.fail === "open") {
        return;
      }
      await reply.code(503).send({ error: "rate limiter unavailable" });
      return;
    }

    setHeaders(reply, decision);

    if (decision.allowed) {
      return;
    }

    options.onLimited?.(request, reply, decision);
    if (options.handler !== undefined) {
      options.handler(request, reply, decision);
      return;
    }
    await reply.code(429).send({ error: "Too Many Requests", retryAfterMs: decision.retryAfterMs });
  };
}
