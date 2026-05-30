/**
 * NestJS adapter. Builds a guard (a `CanActivate`) you attach with `@UseGuards(...)`: under the limit
 * it sets the standards headers on the response and returns `true`; over the limit it **throws** so
 * Nest's exception layer renders the denial. The key defaults to the same proxy-correct client IP as
 * the Express/Fastify adapters. The `ExecutionContext`/`CanActivate` shapes are modeled structurally,
 * so this works on either HTTP platform with **no `@nestjs/common` dependency** — pass
 * `exceptionFactory` to throw a real `HttpException` for an idiomatic `429`. See THROTTLEKIT.md §§14,15.
 *
 * Also exposes {@link nestUnifiedAdmissionMiddleware} and {@link nestAdaptiveConcurrencyMiddleware}
 * (0.9.2, TK-1325) — Express-style middleware functions registered via NestJS's
 * `MiddlewareConsumer`. They wire `release()` to `res.on("finish")` + `res.on("close")` and
 * cover the adaptive-concurrency lifecycle that guards alone cannot (guards run pre-handler).
 * See `research/bigger-bets/middleware-integration/DESIGN.md` §4 + D-M-11.
 */

import type { UnifiedAdmitter, UnifiedAxis } from "../admission/unified";
import { gcra } from "../algorithms/gcra";
import type { ConcurrencyGuard } from "../concurrency/adaptive";
import { systemClock } from "../core/clock";
import { parseDuration as parseDurationShared } from "../core/duration";
import { RateLimitExceededError, ThrottleKitError } from "../core/errors";
import type { Clock, Decision, FailMode, Store, Strategy } from "../core/types";
import { requirePositive } from "../core/validate";
import type { HeaderEmit } from "../http/headers";
import {
  type CommonAdapterOptions,
  type Gate,
  type LimiterOrStrategy,
  type NodeReqLike,
  createGate,
  nodeClientIp,
  trustFrom,
} from "./core";
import { type LifecycleResponseLike, unifiedHeadersFor, wireResponseLifecycle } from "./lifecycle";

export type { CommonAdapterOptions, LimiterOrStrategy } from "./core";

/** The slice of a Nest response the adapter writes headers to (Express `setHeader` / Fastify `header`). */
export interface NestResponseLike {
  setHeader?(name: string, value: string): unknown;
  header?(name: string, value: string): unknown;
}

/**
 * The `HttpArgumentsHost` Nest hands a guard via `switchToHttp()`. Non-generic here for a trivial
 * structural match; Nest's generic `getRequest<T>()`/`getResponse<T>()` satisfy it (instantiated to
 * these shapes).
 */
export interface NestHttpArgumentsHostLike {
  getRequest(): NodeReqLike;
  getResponse(): NestResponseLike;
}

/** The slice of a Nest `ExecutionContext` the guard reads (the HTTP request/response). */
export interface NestExecutionContextLike {
  switchToHttp(): NestHttpArgumentsHostLike;
  /** The route handler (method). Read by {@link createRateLimitGuard} for `@RateLimit` metadata. */
  getHandler?(): object;
  /** The controller class. The fallback metadata source for a class-level `@RateLimit`. */
  getClass?(): object;
}

/** A Nest `CanActivate` guard. */
export interface NestCanActivate {
  canActivate(context: NestExecutionContextLike): boolean | Promise<boolean>;
}

export type NestRateLimitOptions = LimiterOrStrategy &
  CommonAdapterOptions & {
    /** Cost of a request in limiter units. A function computes it per request. Default 1. */
    cost?: number | ((req: NodeReqLike) => number);
    /** Derive the limit key from the request. Default: proxy-correct, aggregated client IP. */
    key?: (req: NodeReqLike) => string;
    /** Observability hook fired on every denial, before the exception is thrown. */
    onLimited?: (req: NodeReqLike, decision: Decision) => void;
    /** Observability hook fired when the store throws (before the fail policy is applied). */
    onError?: (req: NodeReqLike, err: unknown) => void;
    /**
     * Build the error thrown on a denial. Default: {@link RateLimitExceededError}. For an idiomatic
     * Nest `429`, pass a factory that returns an `HttpException`:
     * `(d) => new HttpException({ error: "Too Many Requests", retryAfterMs: d.retryAfterMs }, HttpStatus.TOO_MANY_REQUESTS)`.
     */
    exceptionFactory?: (decision: Decision) => unknown;
  };

/** Set a header on whichever response shape Nest exposes (Express `setHeader` or Fastify `header`). */
function setResponseHeader(res: NestResponseLike, name: string, value: string): void {
  if (typeof res.setHeader === "function") res.setHeader(name, value);
  else if (typeof res.header === "function") res.header(name, value);
}

/**
 * Build a NestJS rate-limit guard.
 *
 * @example
 * ```ts
 * import { HttpException, HttpStatus } from "@nestjs/common";
 * import { nestRateLimit } from "throttlekit/nest";
 * import { gcra } from "throttlekit";
 *
 * const RateLimit = nestRateLimit({
 *   strategy: gcra({ limit: 100, periodMs: 60_000 }),
 *   exceptionFactory: (d) =>
 *     new HttpException({ error: "Too Many Requests", retryAfterMs: d.retryAfterMs }, HttpStatus.TOO_MANY_REQUESTS),
 * });
 *
 * @Controller("posts")
 * export class PostsController {
 *   @UseGuards(RateLimit)
 *   @Post() create() { ... }
 * }
 * ```
 */
export function nestRateLimit(options: NestRateLimitOptions): NestCanActivate {
  const gate = createGate(options);
  const trust = trustFrom(options);
  const keyFn = options.key ?? ((req: NodeReqLike) => nodeClientIp(req, trust));
  const costOpt = options.cost ?? 1;
  const buildException =
    options.exceptionFactory ?? ((d: Decision) => new RateLimitExceededError(d));

  return {
    async canActivate(context: NestExecutionContextLike): Promise<boolean> {
      const http = context.switchToHttp();
      const req = http.getRequest();
      const res = http.getResponse();
      const key = keyFn(req);
      const cost = typeof costOpt === "function" ? costOpt(req) : costOpt;

      let decision: Decision;
      try {
        decision = await gate.limiter.check(key, cost);
      } catch (err) {
        options.onError?.(req, err);
        if (gate.fail === "open") return true;
        throw err; // fail-closed: surface the store error (map it to 503 with a Nest filter)
      }

      for (const [name, value] of Object.entries(gate.headersFor(decision))) {
        setResponseHeader(res, name, value);
      }
      if (decision.allowed) return true;

      options.onLimited?.(req, decision);
      throw buildException(decision);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Idiomatic decorator form: `@RateLimit({ limit, period })` + a single global guard.
// ─────────────────────────────────────────────────────────────────────────────

/** Metadata key the decorator stamps and the guard reads (via the ambient reflect-metadata). */
const RATE_LIMIT_METADATA = Symbol.for("throttlekit:rate-limit");

/** The minimal reflect-metadata surface ThrottleKit uses, read off `globalThis.Reflect`. */
interface ReflectMetadata {
  defineMetadata(key: unknown, value: unknown, target: object): void;
  getMetadata(key: unknown, target: object): unknown;
}

function reflectMeta(): ReflectMetadata {
  const r = (globalThis as { Reflect?: Partial<ReflectMetadata> }).Reflect;
  if (
    r === undefined ||
    typeof r.defineMetadata !== "function" ||
    typeof r.getMetadata !== "function"
  ) {
    throw new ThrottleKitError(
      '@RateLimit requires reflect-metadata. Add `import "reflect-metadata";` at your app entry ' +
        "(NestJS apps already do this).",
    );
  }
  return r as ReflectMetadata;
}

/** Parse a duration into ms; re-exported from `src/core/duration` so the nest API stays stable. */
export const parseDuration: typeof parseDurationShared = parseDurationShared;

/** Per-route config attached by {@link RateLimit}. */
export interface RateLimitMetadata {
  /** Sustained ceiling for this route. Ignored if `strategy` is supplied. */
  limit?: number;
  /** Period as ms (number) or a duration string (`"1m"`, `"30s"`, `"1h"`). Default `"1m"`. */
  period?: string | number;
  /** GCRA burst allowance (defaults to `limit`). Ignored if `strategy` is supplied. */
  burst?: number;
  /** Provide a full strategy instead of `limit`/`period`/`burst` (e.g. `quota(...)`, `gcra(...)`). */
  strategy?: Strategy;
  /** Per-route cost (default 1). */
  cost?: number | ((req: NodeReqLike) => number);
  /** Per-route key override (default: the guard's key — a proxy-correct client IP). */
  key?: (req: NodeReqLike) => string;
}

/**
 * Idiomatic NestJS decorator. Annotate a handler or controller, then register **one**
 * {@link createRateLimitGuard} globally — the guard reads this metadata per route. Mirrors the
 * `@Throttle` + `ThrottlerGuard` pattern, but dependency-free (it reads the ambient reflect-metadata
 * that NestJS already loads; no `@nestjs/common` import).
 *
 * @example
 * ```ts
 * // app.module.ts — register the guard once
 * import { APP_GUARD } from "@nestjs/core";
 * import { createRateLimitGuard } from "throttlekit/nest";
 * import { RedisStore } from "throttlekit/redis";
 * providers: [{ provide: APP_GUARD, useValue: createRateLimitGuard({ store: new RedisStore({ client }) }) }]
 *
 * // any controller
 * import { RateLimit } from "throttlekit/nest";
 * @RateLimit({ limit: 100, period: "1m" })
 * @Post() create() { ... }
 * ```
 */
export function RateLimit(options: RateLimitMetadata): MethodDecorator & ClassDecorator {
  // Validate eagerly so a bad config fails at module load, not on the first request.
  if (options.strategy === undefined) {
    requirePositive("RateLimit.limit", options.limit ?? Number.NaN);
    parseDuration(options.period ?? "1m");
  }
  return ((
    target: object,
    _propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ): void => {
    const meta = reflectMeta();
    // Method decorator: stamp the handler function (what context.getHandler() returns). Class
    // decorator: stamp the constructor (what context.getClass() returns).
    const subject = descriptor !== undefined ? (descriptor.value as object) : target;
    meta.defineMetadata(RATE_LIMIT_METADATA, options, subject);
  }) as MethodDecorator & ClassDecorator;
}

/** Options for {@link createRateLimitGuard} — the shared store/policy applied to every `@RateLimit`. */
export type RateLimitGuardOptions = CommonAdapterOptions & {
  /** Shared store for every annotated route. Defaults to one in-process store for the whole guard. */
  store?: Store;
  /** Default key (default: proxy-correct, aggregated client IP). A route's own `key` overrides it. */
  key?: (req: NodeReqLike) => string;
  /** Applied to routes with no `@RateLimit` (default: unlimited — only annotated routes are limited). */
  defaults?: RateLimitMetadata;
  /** Fired on every denial, before the exception. */
  onLimited?: (req: NodeReqLike, decision: Decision) => void;
  /** Fired when the store throws, before the fail policy. */
  onError?: (req: NodeReqLike, err: unknown) => void;
  /** Build the thrown error (default {@link RateLimitExceededError}; return an `HttpException` for a real 429). */
  exceptionFactory?: (decision: Decision) => unknown;
};

/**
 * Build the single global guard that enforces {@link RateLimit} metadata. Register it once via
 * `APP_GUARD`; routes without `@RateLimit` (and no `defaults`) pass through untouched. One limiter is
 * built and cached per distinct `@RateLimit(...)` config, all sharing the guard's `store`.
 */
export function createRateLimitGuard(options: RateLimitGuardOptions = {}): NestCanActivate {
  const trust = trustFrom(options);
  const defaultKey = options.key ?? ((req: NodeReqLike) => nodeClientIp(req, trust));
  const sharedStore = options.store;
  // One gate per distinct metadata object (decorator configs are stable singletons → WeakMap keys).
  const gates = new WeakMap<RateLimitMetadata, Gate>();

  const gateFor = (meta: RateLimitMetadata): Gate => {
    let gate = gates.get(meta);
    if (gate === undefined) {
      const strategy =
        meta.strategy ??
        gcra({
          limit: meta.limit ?? 0,
          periodMs: parseDuration(meta.period ?? "1m"),
          ...(meta.burst !== undefined ? { burst: meta.burst } : {}),
        });
      gate = createGate({
        strategy,
        ...(sharedStore !== undefined ? { store: sharedStore } : {}),
        ...(options.fail !== undefined ? { fail: options.fail } : {}),
        ...(options.emit !== undefined ? { emit: options.emit } : {}),
        ...(options.policyName !== undefined ? { policyName: options.policyName } : {}),
      });
      gates.set(meta, gate);
    }
    return gate;
  };

  const readMeta = (context: NestExecutionContextLike): RateLimitMetadata | undefined => {
    const r = (globalThis as { Reflect?: Partial<ReflectMetadata> }).Reflect;
    if (r === undefined || typeof r.getMetadata !== "function") return options.defaults;
    const handler = context.getHandler?.();
    const onHandler = handler
      ? (r.getMetadata(RATE_LIMIT_METADATA, handler) as RateLimitMetadata | undefined)
      : undefined;
    if (onHandler !== undefined) return onHandler;
    const cls = context.getClass?.();
    const onClass = cls
      ? (r.getMetadata(RATE_LIMIT_METADATA, cls) as RateLimitMetadata | undefined)
      : undefined;
    return onClass ?? options.defaults;
  };

  const buildException =
    options.exceptionFactory ?? ((d: Decision) => new RateLimitExceededError(d));

  return {
    async canActivate(context: NestExecutionContextLike): Promise<boolean> {
      const meta = readMeta(context);
      if (meta === undefined) return true; // unannotated route, no defaults → not limited
      const gate = gateFor(meta);
      const http = context.switchToHttp();
      const req = http.getRequest();
      const res = http.getResponse();
      const key = (meta.key ?? defaultKey)(req);
      const costOpt = meta.cost ?? 1;
      const cost = typeof costOpt === "function" ? costOpt(req) : costOpt;

      let decision: Decision;
      try {
        decision = await gate.limiter.check(key, cost);
      } catch (err) {
        options.onError?.(req, err);
        if (gate.fail === "open") return true;
        throw err;
      }

      for (const [name, value] of Object.entries(gate.headersFor(decision))) {
        setResponseHeader(res, name, value);
      }
      if (decision.allowed) return true;

      options.onLimited?.(req, decision);
      throw buildException(decision);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// unifiedAdmission + adaptiveConcurrency Nest middleware (0.9.2 / TK-1325).
// Guards run pre-handler only — they cannot release a slot post-completion.
// We ship middleware functions instead, registered via Nest's MiddlewareConsumer:
//
//   consumer.apply(nestUnifiedAdmissionMiddleware({ admitter })).forRoutes("*");
//
// The function signature is Express-compatible (structurally typed; no
// `@nestjs/common` or `express` import). NestJS accepts these directly.
// See `research/bigger-bets/middleware-integration/DESIGN.md` D-M-11.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-axis Decision snapshot from `admitter.lastDecisions()`. */
type AxisSnapshot = Readonly<Partial<Record<UnifiedAxis, Decision | undefined>>>;

/** The slice of an Express-style response the Nest middleware writes through. */
interface NestMiddlewareResLike extends LifecycleResponseLike {
  setHeader(name: string, value: string): unknown;
  status(code: number): unknown;
  json?(body: unknown): unknown;
  end(body?: unknown): unknown;
}

/** Generic next function signature; matches Express. */
type NestMiddlewareNext = (err?: unknown) => void;

/** Options for {@link nestUnifiedAdmissionMiddleware}. */
export type NestUnifiedAdmissionMiddlewareOptions = Pick<
  CommonAdapterOptions,
  "fail" | "emit" | "policyName" | "trustProxy" | "ipv6Prefix"
> & {
  admitter: UnifiedAdmitter;
  cost?: number | ((req: NodeReqLike) => number);
  key?: (req: NodeReqLike) => string;
  clock?: Clock;
  dropOn5xx?: boolean;
  onLimited?: (
    req: NodeReqLike,
    res: NestMiddlewareResLike,
    decision: Decision,
    axes: AxisSnapshot,
  ) => void;
  onError?: (req: NodeReqLike, res: NestMiddlewareResLike, err: unknown) => void;
  handler?: (
    req: NodeReqLike,
    res: NestMiddlewareResLike,
    decision: Decision,
    axes: AxisSnapshot,
  ) => void;
};

/**
 * Express-style NestJS middleware enforcing a {@link UnifiedAdmitter}. Register via
 * `MiddlewareConsumer` in your module's `configure` method.
 *
 * @example
 * import type { MiddlewareConsumer, NestModule } from "@nestjs/common";
 * import { nestUnifiedAdmissionMiddleware } from "throttlekit/nest";
 *
 * \@Module({ ... })
 * export class AppModule implements NestModule {
 *   configure(consumer: MiddlewareConsumer) {
 *     consumer.apply(nestUnifiedAdmissionMiddleware({ admitter })).forRoutes("*");
 *   }
 * }
 */
export function nestUnifiedAdmissionMiddleware(
  options: NestUnifiedAdmissionMiddlewareOptions,
): (req: NodeReqLike, res: NestMiddlewareResLike, next: NestMiddlewareNext) => void {
  const { admitter } = options;
  const trust = trustFrom(options);
  const keyFn = options.key ?? ((req: NodeReqLike) => nodeClientIp(req, trust));
  const costOpt = options.cost ?? 1;
  const fail: FailMode = options.fail ?? "open";
  const emit: HeaderEmit | false = options.emit ?? { draft: true };
  const policyName = options.policyName ?? "unified";
  const clock = options.clock ?? systemClock;
  const dropOn5xx = options.dropOn5xx ?? false;

  return (req: NodeReqLike, res: NestMiddlewareResLike, next: NestMiddlewareNext): void => {
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

      const axes = admitter.lastDecisions();
      const headers = unifiedHeadersFor(decision, emit, policyName, clock.now());
      for (const [name, value] of Object.entries(headers)) {
        res.setHeader(name, value);
      }

      if (!decision.allowed) {
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

      wireResponseLifecycle(res, release, dropOn5xx);
      next();
    })();
  };
}

/** Options for {@link nestAdaptiveConcurrencyMiddleware}. */
export type NestAdaptiveConcurrencyMiddlewareOptions = Pick<
  CommonAdapterOptions,
  "fail" | "emit" | "policyName"
> & {
  guard: ConcurrencyGuard;
  clock?: Clock;
  dropOn5xx?: boolean;
  onLimited?: (req: NodeReqLike, res: NestMiddlewareResLike, decision: Decision) => void;
  handler?: (req: NodeReqLike, res: NestMiddlewareResLike, decision: Decision) => void;
};

/**
 * Express-style NestJS middleware enforcing an adaptive {@link ConcurrencyGuard}.
 *
 * @example
 * consumer.apply(nestAdaptiveConcurrencyMiddleware({ guard })).forRoutes("*");
 */
export function nestAdaptiveConcurrencyMiddleware(
  options: NestAdaptiveConcurrencyMiddlewareOptions,
): (req: NodeReqLike, res: NestMiddlewareResLike, next: NestMiddlewareNext) => void {
  const { guard } = options;
  const emit: HeaderEmit | false = options.emit ?? { draft: true };
  const policyName = options.policyName ?? "adaptive";
  const clock = options.clock ?? systemClock;
  const dropOn5xx = options.dropOn5xx ?? false;

  return (req: NodeReqLike, res: NestMiddlewareResLike, next: NestMiddlewareNext): void => {
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
    wireResponseLifecycle(res, lease.release, dropOn5xx);
    next();
  };
}
