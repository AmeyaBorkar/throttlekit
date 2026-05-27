/**
 * Shared adapter core. Every framework binding (Express, fetch/edge, Hono, Next, Fastify, Koa)
 * needs the same four things: resolve a {@link Limiter} (prebuilt or built inline), pick the clock
 * for header delta math, build standards headers for a decision, and know the fail policy. That
 * logic lives here once; each adapter only maps its framework's request/response to these calls.
 */

import { systemClock } from "../core/clock";
import { rateLimit } from "../core/limiter";
import type { Clock, Decision, FailMode, Limiter, Store, Strategy } from "../core/types";
import {
  type BuildRateLimitHeadersOptions,
  type HeaderEmit,
  buildRateLimitHeaders,
} from "../http/headers";
import { type TrustProxyConfig, clientIp } from "../security/ip";

/** Options shared by every adapter. */
export interface CommonAdapterOptions extends TrustProxyConfig {
  /**
   * Store-outage behavior: `"open"` allows, `"closed"` denies. Default `"open"` (availability over
   * enforcement). **Prefer `"closed"` for security-sensitive limiters** (auth, payments, signup) so a
   * store outage can't be ridden to bypass the limit. Note the policy applies to *any* error the
   * limiter throws, not only store outages — pair it with `onError`/`onLimited` for visibility.
   */
  fail?: FailMode;
  /** Header families to emit, or `false` to emit none. Default `{ draft: true }`. */
  emit?: HeaderEmit | false;
  /** Policy name surfaced in structured headers. Defaults to the strategy name. */
  policyName?: string;
  /**
   * Edge adapters only: whether to trust the platform-injected `cf-connecting-ip` header as the
   * client key. Default `true` — correct behind Cloudflare, which **overwrites** any client-supplied
   * value, and other platforms that inject it. Set `false` when your edge is **not** behind such a
   * platform, so a client can't spoof the header to rotate rate-limit buckets; the key then comes
   * from a {@link TrustProxyConfig.trustProxy}-validated `X-Forwarded-For`, or `"anon"` when none is
   * trusted. (The spoofable rightmost `X-Forwarded-For` is consulted **only** when `trustProxy` is
   * configured, regardless of this flag.)
   */
  trustClientIpHeader?: boolean;
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

/** Resolve the union to a concrete limiter, building one from the strategy when needed. */
export function resolveLimiter(options: LimiterOrStrategy): Limiter {
  if ("limiter" in options) return options.limiter;
  return rateLimit({
    strategy: options.strategy,
    ...(options.store !== undefined ? { store: options.store } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
  });
}

/**
 * The clock used for header delta math. It must match the limiter's clock for `RateLimit-Reset` to
 * be correct (and deterministic under `ManualClock` in tests): when building inline we reuse the
 * supplied `clock`; with a prebuilt limiter we fall back to the system clock.
 */
export function resolveClock(options: LimiterOrStrategy): Clock {
  if ("limiter" in options) return systemClock;
  return options.clock ?? systemClock;
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

/** A resolved limiter plus the header/fail policy, shared across adapters. */
export interface Gate {
  /** The resolved limiter; call `check`/`checkSync` on it. */
  readonly limiter: Limiter;
  /** Store-outage policy the adapter applies in its catch block. */
  readonly fail: FailMode;
  /** Standards-compliant response headers for a decision (empty when emit is `false`). */
  headersFor(decision: Decision): Record<string, string>;
}

/** Resolve the common adapter options into a {@link Gate}. */
export function createGate(options: LimiterOrStrategy & CommonAdapterOptions): Gate {
  const limiter = resolveLimiter(options);
  const clock = resolveClock(options);
  const strategy = limiter.strategy;
  const fail: FailMode = options.fail ?? "open";
  const emit: HeaderEmit | false = options.emit ?? { draft: true };
  const policyName = options.policyName;
  return {
    limiter,
    fail,
    headersFor(decision: Decision): Record<string, string> {
      if (emit === false) return {};
      return buildRateLimitHeaders(
        decision,
        headerOptionsFor(strategy, clock.now(), emit, policyName),
      );
    },
  };
}

/** Narrow the adapter options down to just the trusted-proxy config, dropping unset keys. */
export function trustFrom(options: TrustProxyConfig): TrustProxyConfig {
  return {
    ...(options.trustProxy !== undefined ? { trustProxy: options.trustProxy } : {}),
    ...(options.ipv6Prefix !== undefined ? { ipv6Prefix: options.ipv6Prefix } : {}),
  };
}

/** The slice of a Node `IncomingMessage` the Node-style adapters (Express, Fastify, Koa) read. */
export interface NodeReqLike {
  socket?: { remoteAddress?: string | undefined } | undefined;
  headers: Record<string, string | string[] | undefined>;
}

/** Default Node key: the proxy-correct, aggregated client IP from the socket peer + `X-Forwarded-For`. */
export function nodeClientIp(req: NodeReqLike, trust: TrustProxyConfig): string {
  const remoteAddr = req.socket?.remoteAddress ?? "";
  const xff = req.headers["x-forwarded-for"];
  return clientIp({ remoteAddr, xForwardedFor: xff }, trust);
}

/**
 * Default edge/Web key derivation, hardened against header spoofing (audit TK-S01).
 *
 * Edge runtimes expose no socket peer, so the client IP can only come from a header:
 *  - `cf-connecting-ip` — injected (and overwritten) by Cloudflare and similar platforms. Trusted by
 *    default, because *behind such a platform* a client cannot forge it. Set `trustClientIpHeader`
 *    to `false` when you are NOT behind a platform that sets it, so a client can't spoof the header
 *    to mint a fresh rate-limit bucket per request.
 *  - `x-forwarded-for` — its rightmost entry is fully client-settable, so it is consulted **only**
 *    when `trustProxy` is configured (a declared trusted proxy chain) and then resolved through that
 *    policy; without `trustProxy` it is ignored rather than trusted blindly.
 *
 * With nothing trustworthy, the key is `"anon"` (one shared bucket) — never a spoofable header.
 */
export function edgeClientIp(
  request: Request,
  trust: TrustProxyConfig,
  trustClientIpHeader = true,
): string {
  if (trustClientIpHeader) {
    const cf = request.headers.get("cf-connecting-ip");
    if (cf !== null && cf.trim().length > 0) {
      return clientIp({ remoteAddr: cf.trim() }, trust);
    }
  }
  // The rightmost X-Forwarded-For entry is attacker-controlled at the edge, so consult it only when
  // a trusted proxy chain is declared; otherwise refuse to key on it and share one bucket.
  if (trust.trustProxy !== undefined && trust.trustProxy !== false) {
    const xff = request.headers.get("x-forwarded-for");
    if (xff !== null && xff.trim().length > 0) {
      const parts = xff.split(",").map((p) => p.trim());
      const remoteAddr = parts[parts.length - 1] ?? "";
      const upstream = parts.slice(0, -1);
      return clientIp({ remoteAddr, xForwardedFor: upstream }, trust);
    }
  }
  return "anon";
}
