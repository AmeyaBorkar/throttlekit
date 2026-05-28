/**
 * Shared lifecycle-wiring helpers for the web-platform adapters (hono, fetch,
 * next, remix, sveltekit, elysia, trpc). Where the node-server adapters
 * subscribe to `res.on("finish")` + `res.on("close")`, web-platform adapters
 * need a different shape because the handler returns a `Response` value, not
 * a mutated stream:
 *
 *   - For Response-returning handlers (fetch, next, remix, sveltekit): wrap
 *     the `response.body` ReadableStream so we detect natural completion
 *     (`done`), errors mid-stream, and consumer cancellation. The first event
 *     to fire wins (idempotent release).
 *   - For try/finally-style frameworks (hono, trpc, elysia post-handle): a
 *     simple try/catch around `await next()` carries `dropped = thrown` to
 *     the release.
 *
 * See `research/bigger-bets/middleware-integration/DESIGN.md` §6 + §4.
 */

import type { Decision } from "../core/types";
import { type HeaderEmit, buildRateLimitHeaders } from "../http/headers";

/**
 * Wrap `response` so `release` fires exactly once per lifecycle end:
 *   - natural completion (stream read to `done`)         ⇒ dropped = `dropOn5xx && status >= 500`
 *   - stream error mid-flight                            ⇒ dropped = true
 *   - consumer cancels (e.g. client hangup)              ⇒ dropped = true
 *   - response has no body (null body / 204 / handler returned `new Response(null)`)
 *                                                         ⇒ release immediately, dropped = `dropOn5xx && status >= 500`
 *
 * Returns a fresh Response wrapping the wrapped body with the same status /
 * statusText / headers. The original Response is not mutated (Response is
 * immutable; we re-construct).
 */
export function wrapResponseStreamLifecycle(
  response: Response,
  release: (opts?: { dropped?: boolean }) => void,
  dropOn5xx: boolean,
): Response {
  let released = false;
  const fire = (dropped: boolean): void => {
    if (released) return;
    released = true;
    release({ dropped });
  };

  // No body to wrap → lifecycle is already complete. Release immediately.
  if (response.body === null) {
    fire(dropOn5xx && response.status >= 500);
    return response;
  }

  const sourceBody = response.body;
  const wrappedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = sourceBody.getReader();
      const pump = async (): Promise<void> => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              fire(dropOn5xx && response.status >= 500);
              controller.close();
              return;
            }
            controller.enqueue(value);
          }
        } catch (err) {
          // Source stream errored — treat as dropped (the consumer is not getting a complete response).
          fire(true);
          controller.error(err);
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // Reader may already be released if pump exited normally; ignore.
          }
        }
      };
      void pump();
    },
    cancel(): void {
      // Consumer (e.g. the runtime piping to a client) cancelled the wrapped stream.
      // Either the client hung up or the runtime tore down. Drop signal.
      fire(true);
    },
  });

  return new Response(wrappedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Render the combined Decision into standard rate-limit headers. Mirrors
 * `unifiedHeadersFor` in `lifecycle.ts` so the two adapter families produce
 * identical headers. Returns a `Headers` object (web-native) instead of a
 * plain Record so callers can merge it into Response.headers idiomatically.
 */
export function unifiedHeadersWeb(
  decision: Decision,
  emit: HeaderEmit | false,
  policyName: string,
  now: number,
): Headers {
  const h = new Headers();
  if (emit === false) return h;
  const entries = buildRateLimitHeaders(decision, { now, emit, policyName });
  for (const [name, value] of Object.entries(entries)) {
    h.set(name, value);
  }
  return h;
}

/**
 * Build the default 429 Response with rate-limit headers attached.
 */
export function defaultDenyResponse(
  decision: Decision,
  emit: HeaderEmit | false,
  policyName: string,
  now: number,
): Response {
  const headers = unifiedHeadersWeb(decision, emit, policyName, now);
  headers.set("Content-Type", "application/json");
  return new Response(
    JSON.stringify({ error: "Too Many Requests", retryAfterMs: decision.retryAfterMs }),
    { status: 429, headers },
  );
}

/**
 * Build the fail-closed 503 Response (no body lifecycle here — admit threw).
 */
export function defaultUnavailableResponse(): Response {
  return new Response(JSON.stringify({ error: "admission unavailable" }), {
    status: 503,
    headers: { "Content-Type": "application/json" },
  });
}
