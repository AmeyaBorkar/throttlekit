/**
 * Fastify v5 adapter. Wraps a {@link Limiter} (prebuilt or constructed inline) as an `onRequest`
 * hook that derives a proxy-correct client-IP key by default, enforces the limit, emits standards
 * headers, and responds `429` with `Retry-After` on a denial — with explicit fail-open/closed
 * behavior when the store is unreachable. Mirrors the Express adapter's option shape and control
 * flow exactly. See THROTTLEKIT.md §§14,15.
 *
 * Also exposes {@link fastifyUnifiedAdmission} and {@link fastifyAdaptiveConcurrency} (0.9.2,
 * TK-1325) that wire the `release()` lifecycle to `reply.raw.on("finish")` +
 * `reply.raw.on("close")` using the first-fire-wins pattern. See
 * `research/bigger-bets/middleware-integration/DESIGN.md`.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
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

// ─────────────────────────────────────────────────────────────────────────────
// unifiedAdmission + adaptiveConcurrency middleware (0.9.2 / TK-1325).
// ─────────────────────────────────────────────────────────────────────────────

/** Per-axis Decision snapshot from `admitter.lastDecisions()`. */
type AxisSnapshot = Readonly<Record<UnifiedAxis, Decision | undefined>>;

/** Options for {@link fastifyUnifiedAdmission}. */
export type FastifyUnifiedAdmissionOptions = Pick<
  CommonAdapterOptions,
  "fail" | "emit" | "policyName" | "trustProxy" | "ipv6Prefix"
> & {
  /** The unified admitter to enforce. Build it once with `unifiedAdmission({...})` and pass it in. */
  admitter: UnifiedAdmitter;
  /** Cost passed to the cost axis. Defaults to 1. */
  cost?: number | ((request: FastifyRequest) => number);
  /** Key passed to the rate/cost axes. Defaults to the proxy-correct client IP. */
  key?: (request: FastifyRequest) => string;
  /** Clock used for header delta math. Default {@link systemClock}. */
  clock?: Clock;
  /** Treat 5xx responses as `dropped: true`. Default `false`. See DESIGN.md §5. */
  dropOn5xx?: boolean;
  /** Fired on every denial. */
  onLimited?: (
    request: FastifyRequest,
    reply: FastifyReply,
    decision: Decision,
    axes: AxisSnapshot,
  ) => void;
  /** Fired when `admit()` throws. */
  onError?: (request: FastifyRequest, reply: FastifyReply, err: unknown) => void;
  /** Custom 429 responder. */
  handler?: (
    request: FastifyRequest,
    reply: FastifyReply,
    decision: Decision,
    axes: AxisSnapshot,
  ) => void;
};

/**
 * Build a Fastify hook that enforces a {@link UnifiedAdmitter}. Register as `preHandler`
 * (NOT `onRequest`) so `reply.raw` has subscribers — `onRequest` runs before
 * the routing layer attaches handlers to the response stream. The hook wires
 * `release()` to `reply.raw`'s `finish` + `close` events.
 *
 * @example
 * const admitter = unifiedAdmission({ rate, concurrency, cost });
 * fastify.addHook("preHandler", fastifyUnifiedAdmission({ admitter }));
 */
export function fastifyUnifiedAdmission(
  options: FastifyUnifiedAdmissionOptions,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const { admitter } = options;
  const trust = trustFrom(options);
  const keyFn = options.key ?? ((request: FastifyRequest) => nodeClientIp(request, trust));
  const costOpt = options.cost ?? 1;
  const fail: FailMode = options.fail ?? "open";
  const emit: HeaderEmit | false = options.emit ?? { draft: true };
  const policyName = options.policyName ?? "unified";
  const clock = options.clock ?? systemClock;
  const dropOn5xx = options.dropOn5xx ?? false;

  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const key = keyFn(request);
    const cost = typeof costOpt === "function" ? costOpt(request) : costOpt;

    let decision: Decision;
    let release: (opts?: { dropped?: boolean }) => void;
    try {
      const result = await admitter.admit({ key, cost });
      decision = result.decision;
      release = result.release;
    } catch (err) {
      options.onError?.(request, reply, err);
      if (fail === "open") return;
      await reply.code(503).send({ error: "admission unavailable" });
      return;
    }

    // Capture per-axis snapshot in the same microtask (§8, D-M-5).
    const axes = admitter.lastDecisions();

    const headers = unifiedHeadersFor(decision, emit, policyName, clock.now());
    for (const [name, value] of Object.entries(headers)) {
      reply.header(name, value);
    }

    if (!decision.allowed) {
      options.onLimited?.(request, reply, decision, axes);
      if (options.handler !== undefined) {
        options.handler(request, reply, decision, axes);
        return;
      }
      await reply
        .code(429)
        .send({ error: "Too Many Requests", retryAfterMs: decision.retryAfterMs });
      return;
    }

    // Triple-admitted: wire the release to reply.raw (Node response). The hook returns void;
    // Fastify forwards to the route handler, which runs to completion or throws.
    wireResponseLifecycle(reply.raw as LifecycleResponseLike, release, dropOn5xx);
  };
}

/** Options for {@link fastifyAdaptiveConcurrency}. */
export type FastifyAdaptiveConcurrencyOptions = Pick<
  CommonAdapterOptions,
  "fail" | "emit" | "policyName"
> & {
  /** The concurrency guard to enforce. */
  guard: ConcurrencyGuard;
  /** Clock used for header delta math. Default {@link systemClock}. */
  clock?: Clock;
  /** Treat 5xx as `dropped: true`. Default false. */
  dropOn5xx?: boolean;
  /** Fired on every denial. */
  onLimited?: (request: FastifyRequest, reply: FastifyReply, decision: Decision) => void;
  /** Custom 429 responder. */
  handler?: (request: FastifyRequest, reply: FastifyReply, decision: Decision) => void;
};

/**
 * Build a Fastify `preHandler` hook that enforces an adaptive {@link ConcurrencyGuard}.
 * Wires `release()` to `reply.raw` lifecycle so completion/abort feeds the RTT sampler.
 *
 * @example
 * fastify.addHook("preHandler", fastifyAdaptiveConcurrency({ guard }));
 */
export function fastifyAdaptiveConcurrency(
  options: FastifyAdaptiveConcurrencyOptions,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const { guard } = options;
  const emit: HeaderEmit | false = options.emit ?? { draft: true };
  const policyName = options.policyName ?? "adaptive";
  const clock = options.clock ?? systemClock;
  const dropOn5xx = options.dropOn5xx ?? false;

  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
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
        reply.header(name, value);
      }
      options.onLimited?.(request, reply, decision);
      if (options.handler !== undefined) {
        options.handler(request, reply, decision);
        return;
      }
      await reply
        .code(429)
        .send({ error: "Too Many Requests", retryAfterMs: decision.retryAfterMs });
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
      reply.header(name, value);
    }
    wireResponseLifecycle(reply.raw as LifecycleResponseLike, lease.release, dropOn5xx);
  };
}
