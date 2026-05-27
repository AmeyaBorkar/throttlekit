/**
 * NestJS adapter. Builds a guard (a `CanActivate`) you attach with `@UseGuards(...)`: under the limit
 * it sets the standards headers on the response and returns `true`; over the limit it **throws** so
 * Nest's exception layer renders the denial. The key defaults to the same proxy-correct client IP as
 * the Express/Fastify adapters. The `ExecutionContext`/`CanActivate` shapes are modeled structurally,
 * so this works on either HTTP platform with **no `@nestjs/common` dependency** — pass
 * `exceptionFactory` to throw a real `HttpException` for an idiomatic `429`. See THROTTLEKIT.md §§14,15.
 */

import { RateLimitExceededError } from "../core/errors";
import type { Decision } from "../core/types";
import {
  type CommonAdapterOptions,
  type LimiterOrStrategy,
  type NodeReqLike,
  createGate,
  nodeClientIp,
  trustFrom,
} from "./core";

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
