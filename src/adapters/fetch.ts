/**
 * Web-standard `fetch` adapter for edge runtimes (Cloudflare Workers, Deno, Bun, Next.js edge).
 * Wraps a `(Request, ...args) => Response` handler with a rate-limit gate: on allow it forwards to
 * the handler and copies the rate-limit headers onto the returned `Response`; on deny it returns a
 * `429` with `Retry-After`. Store outages resolve via the explicit fail policy. Uses the global
 * Web `Request`/`Response`/`Headers` (Node 18+). See THROTTLEKIT.md §§14,15.
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

/** A Web-`fetch` style handler: receives a `Request` (plus any runtime args) and returns a `Response`. */
export type FetchHandler = (request: Request, ...args: unknown[]) => Response | Promise<Response>;

/** Either pass a prebuilt limiter, or the pieces to build one inline. */
export type FetchLimiterOrStrategy =
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

export type FetchRateLimitOptions = FetchLimiterOrStrategy &
  TrustProxyConfig & {
    /** Cost of a request in limiter units. A function computes it per request. Default 1. */
    cost?: number | ((request: Request) => number);
    /** Store-outage behavior: `"open"` allows, `"closed"` denies. Default `"open"`. */
    fail?: FailMode;
    /** Header families to emit, or `false` to emit none. Default `{ draft: true }`. */
    emit?: HeaderEmit | false;
    /** Policy name surfaced in structured headers. Defaults to the strategy name. */
    policyName?: string;
    /** Derive the limit key from a request. Default: `cf-connecting-ip` → `x-forwarded-for` → `"anon"`. */
    key?: (request: Request) => string;
    /** Observability hook fired on every denial. */
    onLimited?: (request: Request, decision: Decision) => void;
    /** Observability hook fired when the store throws (before the fail policy is applied). */
    onError?: (request: Request, err: unknown) => void;
    /** Custom 429 responder. When provided, it fully owns the denial response. */
    handler?: (request: Request, decision: Decision) => Response | Promise<Response>;
  };

/** Resolve the union to a concrete limiter, building one from the strategy when needed. */
function resolveLimiter(options: FetchLimiterOrStrategy): Limiter {
  if ("limiter" in options) return options.limiter;
  return rateLimit({
    strategy: options.strategy,
    ...(options.store !== undefined ? { store: options.store } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
  });
}

/** The clock used for header delta math; must match the limiter's clock (see Express adapter). */
function resolveClock(options: FetchLimiterOrStrategy): Clock {
  if ("limiter" in options) return systemClock;
  return options.clock ?? systemClock;
}

/**
 * Default edge key derivation. Edge platforms expose the trusted client IP directly (Cloudflare's
 * `cf-connecting-ip`), so prefer it; otherwise fall back to `x-forwarded-for` resolved through the
 * trusted-proxy policy. There is no socket peer at the edge, so the rightmost XFF entry stands in
 * as `remoteAddr` for trust-chain selection. With nothing usable, the key is `"anon"` (one shared
 * bucket) rather than a spoofable header.
 */
function defaultKey(request: Request, trust: TrustProxyConfig): string {
  const cf = request.headers.get("cf-connecting-ip");
  if (cf !== null && cf.trim().length > 0) {
    // Already the trusted client; aggregate it (IPv6 prefix) but trust it as the socket peer.
    return clientIp({ remoteAddr: cf.trim() }, trust);
  }
  const xff = request.headers.get("x-forwarded-for");
  if (xff !== null && xff.trim().length > 0) {
    // The rightmost XFF entry is the peer the edge node actually saw — treat it as the socket
    // peer, and the rest as the upstream chain, so `clientIp` rebuilds the full chain without
    // duplicating the last hop. Trust semantics then apply exactly as on a Node socket.
    const parts = xff.split(",").map((p) => p.trim());
    const remoteAddr = parts[parts.length - 1] ?? "";
    const upstream = parts.slice(0, -1);
    return clientIp({ remoteAddr, xForwardedFor: upstream }, trust);
  }
  return "anon";
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
 * Wrap a `fetch` handler with rate limiting.
 *
 * @example
 * export default { fetch: withRateLimit(handler, { strategy: gcra({ limit: 30, periodMs: 10_000 }) }) };
 */
export function withRateLimit(
  handler: FetchHandler,
  options: FetchRateLimitOptions,
): (request: Request, ...args: unknown[]) => Promise<Response> {
  const limiter = resolveLimiter(options);
  const clock = resolveClock(options);
  const strategy = limiter.strategy;
  const fail: FailMode = options.fail ?? "open";
  const emit: HeaderEmit | false = options.emit ?? { draft: true };
  const trust: TrustProxyConfig = {
    ...(options.trustProxy !== undefined ? { trustProxy: options.trustProxy } : {}),
    ...(options.ipv6Prefix !== undefined ? { ipv6Prefix: options.ipv6Prefix } : {}),
  };
  const keyFn = options.key ?? ((request: Request) => defaultKey(request, trust));
  const costOpt = options.cost ?? 1;
  const policyName = options.policyName;

  const buildHeaders = (decision: Decision): Record<string, string> => {
    if (emit === false) return {};
    return buildRateLimitHeaders(
      decision,
      headerOptionsFor(strategy, clock.now(), emit, policyName),
    );
  };

  return async (request: Request, ...args: unknown[]): Promise<Response> => {
    const key = keyFn(request);
    const cost = typeof costOpt === "function" ? costOpt(request) : costOpt;

    let decision: Decision;
    try {
      decision = await limiter.check(key, cost);
    } catch (err) {
      options.onError?.(request, err);
      if (fail === "open") {
        return handler(request, ...args);
      }
      return new Response(JSON.stringify({ error: "rate limiter unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    const headers = buildHeaders(decision);

    if (decision.allowed) {
      const res = await handler(request, ...args);
      // Copy the rate-limit headers onto a clone of the handler's response (don't mutate shared state).
      const merged = new Headers(res.headers);
      for (const [name, value] of Object.entries(headers)) {
        merged.set(name, value);
      }
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: merged,
      });
    }

    options.onLimited?.(request, decision);
    if (options.handler !== undefined) {
      const custom = await options.handler(request, decision);
      const merged = new Headers(custom.headers);
      for (const [name, value] of Object.entries(headers)) {
        if (!merged.has(name)) merged.set(name, value);
      }
      return new Response(custom.body, {
        status: custom.status,
        statusText: custom.statusText,
        headers: merged,
      });
    }

    const denyHeaders = new Headers(headers);
    denyHeaders.set("Content-Type", "application/json");
    return new Response(
      JSON.stringify({ error: "Too Many Requests", retryAfterMs: decision.retryAfterMs }),
      { status: 429, headers: denyHeaders },
    );
  };
}
