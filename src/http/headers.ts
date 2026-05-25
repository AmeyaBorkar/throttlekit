/**
 * Standards-compliant rate-limit response headers.
 *
 * ThrottleKit emits, per configuration, three flavors of the same decision (see
 * docs/DESIGN-NOTES.md "IETF RateLimit headers" and THROTTLEKIT.md §15):
 *
 *  - `draft`      — the widely-consumed IETF triple `RateLimit-Limit/Remaining/Reset`, where
 *                   `Reset` is **delta-seconds** until replenishment (not a Unix timestamp).
 *  - `structured` — the current draft-ietf-httpapi-ratelimit-headers-11 form using RFC 9651
 *                   Structured Fields: `RateLimit` and `RateLimit-Policy`.
 *  - `legacy`     — the long-standing `X-RateLimit-*` triple, whose `Reset` is **epoch seconds**.
 *
 * On a denial (`!decision.allowed`) a `Retry-After` header (delta-seconds, rounded up, min 1) is
 * always added regardless of the emit selection. All values are strings; all time math derives
 * from the injected `now` so the output is deterministic in tests.
 */

import type { Decision } from "../core/types";

/** Which header families to emit. Unset flags default to off; the overall default is `{ draft: true }`. */
export interface HeaderEmit {
  /** The IETF triple `RateLimit-Limit/Remaining/Reset` (delta-seconds reset). */
  draft?: boolean;
  /** The RFC 9651 structured `RateLimit` + `RateLimit-Policy` fields (draft-11). */
  structured?: boolean;
  /** The legacy `X-RateLimit-*` triple (epoch-seconds reset). */
  legacy?: boolean;
}

export interface BuildRateLimitHeadersOptions {
  /** Current time in epoch-ms (from the injected clock), used for delta-seconds math. */
  now: number;
  /** Policy name surfaced in the structured fields. Defaults to `"default"`. */
  policyName?: string;
  /** Window length in seconds, surfaced as `;w=` of `RateLimit-Policy` when provided. */
  windowSeconds?: number;
  /** Which header families to emit. Defaults to `{ draft: true }`. */
  emit?: HeaderEmit;
}

/** Seconds until the limiter is fully replenished, clamped at 0 (the IETF "reset" delta). */
function resetDeltaSeconds(decision: Decision, now: number): number {
  return Math.max(0, Math.ceil((decision.resetAt - now) / 1000));
}

/**
 * Build the rate-limit response headers for one {@link Decision}.
 *
 * @returns a plain `Record<string,string>` ready to be set on a response. Header names use their
 * canonical casing; values are always strings.
 */
export function buildRateLimitHeaders(
  decision: Decision,
  opts: BuildRateLimitHeadersOptions,
): Record<string, string> {
  const emit = opts.emit ?? { draft: true };
  const headers: Record<string, string> = {};

  if (emit.draft === true) {
    headers["RateLimit-Limit"] = String(decision.limit);
    headers["RateLimit-Remaining"] = String(decision.remaining);
    headers["RateLimit-Reset"] = String(resetDeltaSeconds(decision, opts.now));
  }

  if (emit.structured === true) {
    const policy = opts.policyName ?? "default";
    const t = resetDeltaSeconds(decision, opts.now);
    headers.RateLimit = `"${policy}";r=${decision.remaining};t=${t}`;
    let policyValue = `"${policy}";q=${decision.limit}`;
    if (opts.windowSeconds !== undefined) {
      policyValue += `;w=${opts.windowSeconds}`;
    }
    headers["RateLimit-Policy"] = policyValue;
  }

  if (emit.legacy === true) {
    headers["X-RateLimit-Limit"] = String(decision.limit);
    headers["X-RateLimit-Remaining"] = String(decision.remaining);
    // Legacy clients expect an absolute epoch-seconds timestamp here, not a delta.
    headers["X-RateLimit-Reset"] = String(Math.ceil(decision.resetAt / 1000));
  }

  if (!decision.allowed) {
    headers["Retry-After"] = String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
  }

  return headers;
}
