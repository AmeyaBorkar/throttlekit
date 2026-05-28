/**
 * Shared lifecycle-wiring helpers for the node-server adapters
 * (express, fastify, koa, nest). The unifiedAdmission and adaptiveConcurrency
 * primitives expose a `release()` callback that MUST be invoked exactly once
 * when the request lifecycle ends; this module centralizes the first-fire-wins
 * pattern from §6 of `research/bigger-bets/middleware-integration/DESIGN.md`.
 *
 * Web-platform adapters (hono, fetch, next, remix, sveltekit, elysia, trpc)
 * use a different pattern (try/finally around `await next()` or a
 * TransformStream wrap) — see TK-1326.
 */

import type { Decision } from "../core/types";
import { type HeaderEmit, buildRateLimitHeaders } from "../http/headers";

/**
 * The minimum response surface the lifecycle wiring touches. The fields read
 * (`statusCode`) and methods called (`on("finish"|"close", ...)`) are
 * shared by Node's `http.ServerResponse`, Fastify's `reply.raw`, and Koa's
 * `ctx.res`. The interface is *structural* so we don't import the express
 * type into this shared module.
 */
export interface LifecycleResponseLike {
  on(event: "finish" | "close", listener: () => void): unknown;
  /** Final response status. Read at finish-time for the `dropOn5xx` check. */
  statusCode?: number | undefined;
}

/**
 * Wire `release(opts)` to the response's `finish` + `close` events using the
 * first-fire-wins pattern from §6 of the design doc. The first event
 * classifies the lifecycle:
 *
 *   - `close` before `finish` ⇒ aborted / hung-up ⇒ `dropped: true`
 *   - `finish` first ⇒ normal completion ⇒ `dropped: false`
 *     (or `true` if `dropOn5xx` is set AND `statusCode >= 500`)
 *
 * The second event is a no-op (the local `released` flag short-circuits;
 * `release` is also idempotent at the primitive level, but the local flag
 * avoids an unnecessary call). Per-call state is held in this closure so
 * concurrent admits do not interfere.
 *
 * The property test in TK-1327 fuzzes random `[finish, close]` orderings
 * against this exact function to verify the exactly-once-release invariant
 * (D-M-3 of the design).
 */
export function wireResponseLifecycle(
  res: LifecycleResponseLike,
  release: (opts?: { dropped?: boolean }) => void,
  dropOn5xx: boolean,
): void {
  let released = false;
  const fire = (dropped: boolean): void => {
    if (released) return;
    released = true;
    release({ dropped });
  };
  res.on("finish", () => {
    // Normal-completion path. If user opted in to `dropOn5xx`, treat a 5xx as overload.
    const status = res.statusCode ?? 200;
    fire(dropOn5xx && status >= 500);
  });
  res.on("close", () => {
    // First-fire-wins. If `finish` already ran, `released` is true → no-op.
    // If close fires first, the response did not complete → dropped.
    fire(true);
  });
}

/**
 * Render the combined Decision into standard rate-limit headers.
 *
 * For the unified-admission and adaptive-concurrency adapters we don't have a
 * single underlying {@link Strategy} (the headers' `;w=` field uses
 * `strategy.windowMs` in the rate-limit adapter; here we omit it). Callers
 * pass an explicit `policyName` (default `"unified"` / `"adaptive"`).
 */
export function unifiedHeadersFor(
  decision: Decision,
  emit: HeaderEmit | false,
  policyName: string,
  now: number,
): Record<string, string> {
  if (emit === false) return {};
  return buildRateLimitHeaders(decision, { now, emit, policyName });
}
