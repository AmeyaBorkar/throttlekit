/**
 * Remix / React Router adapter. Exposes a guard you call at the top of a `loader`/`action`: under the
 * limit it resolves to the standards headers (attach them via `json(data, { headers })`); over the
 * limit it **throws** a `429` `Response` (Remix renders thrown Responses); a fail-closed store outage
 * throws `503`. The key derives from the Web `Request` — `cf-connecting-ip`/trusted `x-forwarded-for`
 * → `"anon"` (audit TK-S01) — overridable. See THROTTLEKIT.md §§14,15.
 */

import type { Decision } from "../core/types";
import {
  type CommonAdapterOptions,
  type LimiterOrStrategy,
  createGate,
  edgeClientIp,
  trustFrom,
} from "./core";

export type { CommonAdapterOptions, LimiterOrStrategy } from "./core";

export type RemixRateLimitOptions = LimiterOrStrategy &
  CommonAdapterOptions & {
    /** Cost of a request in limiter units. A function computes it per request. Default 1. */
    cost?: number | ((request: Request) => number);
    /** Derive the limit key from the request. Default: edge client IP (see {@link edgeClientIp}). */
    key?: (request: Request) => string;
    /** Observability hook fired on every denial, before the `Response` is thrown. */
    onLimited?: (request: Request, decision: Decision) => void;
    /** Observability hook fired when the store throws (before the fail policy is applied). */
    onError?: (request: Request, err: unknown) => void;
    /** Custom denial responder; its `Response` is thrown instead of the default 429. */
    handler?: (request: Request, decision: Decision) => Response | Promise<Response>;
  };

/** A Remix guard: resolves to headers to attach on allow; throws a `Response` on deny. */
export type RemixRateLimitGuard = (request: Request) => Promise<Record<string, string>>;

/**
 * Build a Remix loader/action rate-limit guard.
 *
 * @example
 * ```ts
 * const rateLimit = remixRateLimit({ strategy: gcra({ limit: 60, periodMs: 60_000 }) });
 * export async function loader({ request }: LoaderFunctionArgs) {
 *   const headers = await rateLimit(request); // throws a 429 Response when over the limit
 *   return json(await getData(), { headers });
 * }
 * ```
 */
export function remixRateLimit(options: RemixRateLimitOptions): RemixRateLimitGuard {
  const gate = createGate(options);
  const trust = trustFrom(options);
  const keyFn =
    options.key ??
    ((request: Request) => edgeClientIp(request, trust, options.trustClientIpHeader));
  const costOpt = options.cost ?? 1;

  return async (request: Request): Promise<Record<string, string>> => {
    const key = keyFn(request);
    const cost = typeof costOpt === "function" ? costOpt(request) : costOpt;

    let decision: Decision;
    try {
      decision = await gate.limiter.check(key, cost);
    } catch (err) {
      options.onError?.(request, err);
      if (gate.fail === "open") return {};
      throw new Response(JSON.stringify({ error: "rate limiter unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }

    const headers = gate.headersFor(decision);
    if (decision.allowed) return headers;

    options.onLimited?.(request, decision);
    if (options.handler !== undefined) throw await options.handler(request, decision);
    const denyHeaders = new Headers(headers);
    denyHeaders.set("Content-Type", "application/json");
    throw new Response(
      JSON.stringify({ error: "Too Many Requests", retryAfterMs: decision.retryAfterMs }),
      { status: 429, headers: denyHeaders },
    );
  };
}
