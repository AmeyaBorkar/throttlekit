/**
 * Elysia adapter. Builds an `onBeforeHandle` hook that gates the routes it guards: it sets the
 * standards headers on the context, then either lets the handler run (returns `undefined`) or
 * short-circuits with a `429` body and `set.status`; a fail-closed store outage short-circuits with
 * `503`. The key derives from the Web `Request` — `cf-connecting-ip`/trusted `x-forwarded-for` →
 * `"anon"` (audit TK-S01) — overridable. The context shape is modeled structurally, so a real Elysia
 * context satisfies it with no dependency. See THROTTLEKIT.md §§14,15.
 *
 * Also exposes {@link elysiaUnifiedAdmission} and {@link elysiaAdaptiveConcurrency} (0.9.2,
 * TK-1326) — wrap-style functions the user calls inside the route handler:
 *   `app.get("/", (ctx) => admit(ctx, async () => "result"))`
 *
 * The wrap pattern is universal across Elysia's runtime versions; it doesn't require Elysia's
 * own plugin lifecycle hooks. The release fires when the wrapped handler returns / throws.
 */

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

/** The slice of an Elysia context the adapter reads/writes: the request and the mutable response `set`. */
export interface ElysiaContextLike {
  request: Request;
  set: {
    status?: number | string;
    headers: Record<string, string>;
  };
}

/** An Elysia `onBeforeHandle` hook: returns `undefined` to proceed, or a value to short-circuit. */
export type ElysiaRateLimitHook = (ctx: ElysiaContextLike) => unknown;

/** The 5xx status NAME strings Elysia accepts for `set.status` (it permits a status name, not just a code). */
const SERVER_ERROR_NAMES = new Set<string>([
  "Internal Server Error",
  "Not Implemented",
  "Bad Gateway",
  "Service Unavailable",
  "Gateway Timeout",
  "HTTP Version Not Supported",
  "Variant Also Negotiates",
  "Insufficient Storage",
  "Loop Detected",
  "Not Extended",
  "Network Authentication Required",
]);

/**
 * Classify an Elysia `set.status` as a 5xx server error. Elysia accepts a numeric code, a
 * numeric string ("500"), OR a status NAME string ("Internal Server Error"); a blind
 * `Number(status) >= 500` turns the name string into `NaN` (never 5xx), so `dropOn5xx` would
 * miss it. Handle all three shapes and bound to the proper 5xx class.
 */
function is5xx(status: number | string | undefined): boolean {
  if (status === undefined) return false;
  if (typeof status === "number") return status >= 500 && status < 600;
  const n = Number(status);
  if (!Number.isNaN(n)) return n >= 500 && n < 600; // "500"
  return SERVER_ERROR_NAMES.has(status); // "Internal Server Error"
}

export type ElysiaRateLimitOptions = LimiterOrStrategy &
  CommonAdapterOptions & {
    /** Cost of a request in limiter units. A function computes it per context. Default 1. */
    cost?: number | ((ctx: ElysiaContextLike) => number);
    /** Derive the limit key from the context. Default: edge client IP (see {@link edgeClientIp}). */
    key?: (ctx: ElysiaContextLike) => string;
    /** Observability hook fired on every denial. */
    onLimited?: (ctx: ElysiaContextLike, decision: Decision) => void;
    /** Observability hook fired when the store throws (before the fail policy is applied). */
    onError?: (ctx: ElysiaContextLike, err: unknown) => void;
    /** Custom denial responder; its return value becomes the short-circuit response body. */
    handler?: (ctx: ElysiaContextLike, decision: Decision) => unknown;
  };

/**
 * Build an Elysia `onBeforeHandle` hook that rate-limits requests.
 *
 * @example
 * ```ts
 * import { Elysia } from "elysia";
 * import { elysiaRateLimit } from "throttlekit/elysia";
 * import { gcra } from "throttlekit";
 * new Elysia()
 *   .onBeforeHandle(elysiaRateLimit({ strategy: gcra({ limit: 30, periodMs: 10_000 }) }))
 *   .get("/", () => "ok");
 * ```
 */
export function elysiaRateLimit(options: ElysiaRateLimitOptions): ElysiaRateLimitHook {
  const gate = createGate(options);
  const trust = trustFrom(options);
  const keyFn =
    options.key ??
    ((ctx: ElysiaContextLike) => edgeClientIp(ctx.request, trust, options.trustClientIpHeader));
  const costOpt = options.cost ?? 1;

  return async (ctx: ElysiaContextLike): Promise<unknown> => {
    const key = keyFn(ctx);
    const cost = typeof costOpt === "function" ? costOpt(ctx) : costOpt;

    let decision: Decision;
    try {
      decision = await gate.limiter.check(key, cost);
    } catch (err) {
      options.onError?.(ctx, err);
      if (gate.fail === "open") return undefined; // let the handler run
      ctx.set.status = 503;
      return { error: "rate limiter unavailable" };
    }

    for (const [name, value] of Object.entries(gate.headersFor(decision))) {
      ctx.set.headers[name] = value;
    }
    if (decision.allowed) return undefined; // proceed to the handler

    options.onLimited?.(ctx, decision);
    if (options.handler !== undefined) {
      ctx.set.status = 429;
      return options.handler(ctx, decision);
    }
    ctx.set.status = 429;
    return { error: "Too Many Requests", retryAfterMs: decision.retryAfterMs };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// unifiedAdmission + adaptiveConcurrency wrap (0.9.2 / TK-1326).
// Elysia's lifecycle hooks (onBeforeHandle / onAfterHandle / onError) work
// for rate-limiting but cannot tie a single admit() to its release() across
// the three callbacks without per-request state. The wrap pattern is simpler
// and universal: the user calls `await admit(ctx, async () => handler-body)`
// inside their route handler. See DESIGN.md §4 (elysia row).
// ─────────────────────────────────────────────────────────────────────────────

/** Per-axis Decision snapshot. */
type AxisSnapshot = Readonly<Partial<Record<UnifiedAxis, Decision | undefined>>>;

/** Options for {@link elysiaUnifiedAdmission}. */
export type ElysiaUnifiedAdmissionOptions = Pick<
  CommonAdapterOptions,
  "fail" | "emit" | "policyName" | "trustProxy" | "ipv6Prefix" | "trustClientIpHeader"
> & {
  admitter: UnifiedAdmitter;
  cost?: number | ((ctx: ElysiaContextLike) => number);
  key?: (ctx: ElysiaContextLike) => string;
  clock?: Clock;
  dropOn5xx?: boolean;
  onLimited?: (ctx: ElysiaContextLike, decision: Decision, axes: AxisSnapshot) => void;
  onError?: (ctx: ElysiaContextLike, err: unknown) => void;
};

/** A `(ctx, body) => result` wrap; user calls inside their handler. */
export type ElysiaUnifiedAdmissionWrap = <R>(
  ctx: ElysiaContextLike,
  body: () => Promise<R> | R,
) => Promise<R | undefined>;

/**
 * Build an Elysia admission wrap. The user calls `await admit(ctx, async () => ...)` inside
 * their handler. The wrap admits (denying with 429 if blocked), forwards to the body inside
 * a try/finally, and fires release with `dropped = thrown`.
 *
 * @example
 * const admit = elysiaUnifiedAdmission({ admitter });
 * app.get("/", (ctx) => admit(ctx, async () => "ok"));
 */
export function elysiaUnifiedAdmission(
  options: ElysiaUnifiedAdmissionOptions,
): ElysiaUnifiedAdmissionWrap {
  const { admitter } = options;
  const trust = trustFrom(options);
  const keyFn =
    options.key ??
    ((ctx: ElysiaContextLike) => edgeClientIp(ctx.request, trust, options.trustClientIpHeader));
  const costOpt = options.cost ?? 1;
  const fail: FailMode = options.fail ?? "open";
  const emit: HeaderEmit | false = options.emit ?? { draft: true };
  const policyName = options.policyName ?? "unified";
  const clock = options.clock ?? systemClock;
  const dropOn5xx = options.dropOn5xx ?? false;

  return async <R>(ctx: ElysiaContextLike, body: () => Promise<R> | R): Promise<R | undefined> => {
    const key = keyFn(ctx);
    const cost = typeof costOpt === "function" ? costOpt(ctx) : costOpt;

    let decision: Decision;
    let release: (opts?: { dropped?: boolean }) => void;
    try {
      const r = await admitter.admit({ key, cost });
      decision = r.decision;
      release = r.release;
    } catch (err) {
      options.onError?.(ctx, err);
      if (fail === "open") return await body();
      ctx.set.status = 503;
      return undefined as R;
    }

    const axes = admitter.lastDecisions();
    for (const [n, v] of unifiedHeadersWeb(decision, emit, policyName, clock.now()).entries()) {
      ctx.set.headers[n] = v;
    }

    if (!decision.allowed) {
      options.onLimited?.(ctx, decision, axes);
      ctx.set.status = 429;
      return undefined as R;
    }

    let thrown = false;
    try {
      return await body();
    } catch (err) {
      thrown = true;
      throw err;
    } finally {
      release({ dropped: thrown || (dropOn5xx && is5xx(ctx.set.status)) });
    }
  };
}

/** Options for {@link elysiaAdaptiveConcurrency}. */
export type ElysiaAdaptiveConcurrencyOptions = Pick<
  CommonAdapterOptions,
  "fail" | "emit" | "policyName"
> & {
  guard: ConcurrencyGuard;
  clock?: Clock;
  dropOn5xx?: boolean;
  onLimited?: (ctx: ElysiaContextLike, decision: Decision) => void;
};

/** Build an Elysia adaptive-concurrency wrap. */
export function elysiaAdaptiveConcurrency(
  options: ElysiaAdaptiveConcurrencyOptions,
): ElysiaUnifiedAdmissionWrap {
  const { guard } = options;
  const emit: HeaderEmit | false = options.emit ?? { draft: true };
  const policyName = options.policyName ?? "adaptive";
  const clock = options.clock ?? systemClock;
  const dropOn5xx = options.dropOn5xx ?? false;

  return async <R>(ctx: ElysiaContextLike, body: () => Promise<R> | R): Promise<R | undefined> => {
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
      for (const [n, v] of unifiedHeadersWeb(decision, emit, policyName, now).entries()) {
        ctx.set.headers[n] = v;
      }
      options.onLimited?.(ctx, decision);
      ctx.set.status = 429;
      return undefined as R;
    }

    const decision: Decision = {
      allowed: true,
      limit: guard.limit,
      remaining: Math.max(0, guard.limit - guard.inflight),
      resetAt: now,
      retryAfterMs: 0,
    };
    for (const [n, v] of unifiedHeadersWeb(decision, emit, policyName, now).entries()) {
      ctx.set.headers[n] = v;
    }

    let thrown = false;
    try {
      return await body();
    } catch (err) {
      thrown = true;
      throw err;
    } finally {
      lease.release({ dropped: thrown || (dropOn5xx && is5xx(ctx.set.status)) });
    }
  };
}
