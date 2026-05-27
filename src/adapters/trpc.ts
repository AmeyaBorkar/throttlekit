/**
 * tRPC adapter. Builds a middleware function (pass it to `t.middleware(...)`) that rate-limits the
 * procedures it guards: under the limit it calls `next()`; over it **throws** so tRPC turns it into
 * an error response; a fail-closed store outage rethrows the store error. Because a tRPC `ctx` is
 * app-defined, you supply the `key` derivation. Dependency-free: the denial error defaults to
 * {@link RateLimitExceededError}; pass `errorFactory` to throw a `TRPCError` so tRPC reports
 * `TOO_MANY_REQUESTS`.
 */

import { RateLimitExceededError } from "../core/errors";
import type { Decision } from "../core/types";
import { type CommonAdapterOptions, type LimiterOrStrategy, createGate } from "./core";

export type { LimiterOrStrategy } from "./core";

/** Metadata about the call being limited, passed to {@link TrpcRateLimitOptions.key}/`cost`. */
export interface TrpcCallMeta<Ctx> {
  ctx: Ctx;
  /** The procedure path (e.g. `"post.create"`), when tRPC provides it. */
  path?: string;
  /** The procedure type (`"query"`/`"mutation"`/`"subscription"`), when tRPC provides it. */
  type?: string;
}

/** The slice of tRPC's middleware argument the adapter uses. */
export interface TrpcMiddlewareParams<Ctx, Result> extends TrpcCallMeta<Ctx> {
  /** Continue to the next middleware / the procedure resolver. */
  next: () => Promise<Result>;
}

export type TrpcRateLimitOptions<Ctx> = LimiterOrStrategy &
  Pick<CommonAdapterOptions, "fail"> & {
    /** Derive the limit key from the call (required — a tRPC `ctx` is app-defined). */
    key: (meta: TrpcCallMeta<Ctx>) => string;
    /** Cost of a call in limiter units. A function computes it per call. Default 1. */
    cost?: number | ((meta: TrpcCallMeta<Ctx>) => number);
    /** Observability hook fired on every denial. */
    onLimited?: (ctx: Ctx, decision: Decision) => void;
    /** Observability hook fired when the store throws (before the fail policy is applied). */
    onError?: (ctx: Ctx, err: unknown) => void;
    /**
     * Build the error thrown on a denial. Default: {@link RateLimitExceededError}. Pass a TRPCError
     * factory to surface the proper code: `(d) => new TRPCError({ code: "TOO_MANY_REQUESTS" })`.
     */
    errorFactory?: (decision: Decision) => unknown;
  };

/** A tRPC middleware function; pass it to `t.middleware(...)`. */
export type TrpcRateLimitMiddleware<Ctx> = <Result>(
  params: TrpcMiddlewareParams<Ctx, Result>,
) => Promise<Result>;

/**
 * Build a tRPC rate-limit middleware.
 *
 * @example
 * ```ts
 * import { TRPCError } from "@trpc/server";
 * const rl = trpcRateLimit<MyCtx>({
 *   strategy: gcra({ limit: 100, periodMs: 60_000 }),
 *   key: ({ ctx }) => ctx.user?.id ?? ctx.ip,
 *   errorFactory: (d) => new TRPCError({ code: "TOO_MANY_REQUESTS", message: `retry in ${d.retryAfterMs}ms` }),
 * });
 * export const limited = t.procedure.use(t.middleware(rl));
 * ```
 */
export function trpcRateLimit<Ctx = unknown>(
  options: TrpcRateLimitOptions<Ctx>,
): TrpcRateLimitMiddleware<Ctx> {
  const gate = createGate(options);
  const costOpt = options.cost ?? 1;

  return async <Result>(params: TrpcMiddlewareParams<Ctx, Result>): Promise<Result> => {
    // `params` already carries { ctx, path?, type? } (it extends TrpcCallMeta), so pass it straight to
    // the key/cost derivations — no intermediate object (which would trip exactOptionalPropertyTypes).
    const key = options.key(params);
    const cost = typeof costOpt === "function" ? costOpt(params) : costOpt;

    let decision: Decision;
    try {
      decision = await gate.limiter.check(key, cost);
    } catch (err) {
      options.onError?.(params.ctx, err);
      if (gate.fail === "open") return params.next();
      throw err; // fail-closed: propagate (tRPC maps to INTERNAL_SERVER_ERROR)
    }

    if (decision.allowed) return params.next();
    options.onLimited?.(params.ctx, decision);
    throw options.errorFactory
      ? options.errorFactory(decision)
      : new RateLimitExceededError(decision);
  };
}
