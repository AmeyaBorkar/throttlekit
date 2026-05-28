import type { ConcurrencyGuard } from "../concurrency/adaptive";
import { systemClock } from "../core/clock";
import type { Clock, Decision } from "../core/types";

/**
 * A concurrency admission shaped like the other unified-admission axes: a
 * {@link Decision} the algebra can combine, plus a separate `release`
 * tied to the caller's request lifecycle (`res.on("finish", release)`,
 * a `finally` block, etc.).
 *
 * The two halves are intentionally split because a {@link Decision} is
 * a point-in-time value but a concurrency slot has *temporal* state — it
 * stays held until the work completes. Combining them into one object
 * keeps the call-site idiomatic and surfaces the lifecycle obligation.
 */
export interface LeaseAdmission {
  /** The Decision view of this acquire. Suitable as input to `combineDecisions`. */
  decision: Decision;
  /**
   * Releases the concurrency slot (or is a no-op for a rejected admission).
   * `dropped: true` signals an overload (timeout / error) to the underlying
   * gradient2 / AIMD update — pass it through honestly so the limit
   * contracts. Idempotent: a second call is a no-op (the underlying
   * {@link Lease}'s release is already idempotent).
   */
  release(opts?: { dropped?: boolean }): void;
}

/** Options for {@link leaseAsAdmission}. */
export interface LeaseAsAdmissionOptions {
  /** Injectable time source. Defaults to {@link systemClock}. */
  clock?: Clock;
}

/** The shim surface — `acquire` mirrors the concurrency guard's primitive. */
export interface LeaseAdmitter {
  /** Try to take a slot; the returned {@link LeaseAdmission} carries the Decision plus the release. */
  acquire(): LeaseAdmission;
}

/**
 * Bridge a {@link ConcurrencyGuard}'s `acquire() → Lease` into a
 * Decision-shaped admission so it composes with the other unified-admission
 * axes via {@link combineDecisions}. The release is kept *separate* from
 * the Decision so the caller can wire it to the request lifecycle (see
 * `research/bigger-bets/unified/DESIGN.md` §5 — D-U4 and DR-08 in PLAN.md
 * §8: concurrency's lease semantics don't fit {@link Limiter}'s stateless
 * `.check() → Decision` shape, so we expose `{ decision, release }`).
 *
 * **Decision shape — accepted lease (`ok === true`):**
 * - `allowed: true`
 * - `limit: guard.limit` — the current inferred ceiling
 * - `remaining: max(0, guard.limit − guard.inflight)` — post-consume
 *   (the just-acquired slot is already counted in `inflight`)
 * - `resetAt: clock.now()` — concurrency replenishes by *event*
 *   (a release), not by clock, so we report "now" and let the
 *   MAX-aggregation in `combineDecisions` pick the rate / cost axis's
 *   real reset (always ≥ now)
 * - `retryAfterMs: 0`
 *
 * **Decision shape — rejected lease (`ok === false`):**
 * - `allowed: false`
 * - `limit: guard.limit`
 * - `remaining: 0`
 * - `resetAt: clock.now()`
 * - `retryAfterMs: max(1, round(guard.stats().lastRtt || 1))` — a
 *   Little's-Law-honest hint, since the slot frees by event not clock.
 *   `lastRtt` proxies the residence time `W`; under saturation the
 *   average wait for a free slot is approximately `W`. The
 *   `max(1, …)` floor guarantees we never tell a client "deny with
 *   retry-immediately" (a useless signal); the `|| 1` handles the
 *   "no samples yet" cold start. `round(…)` keeps the field integer
 *   (the project-wide bit-identity guarantee).
 *
 * The shim is pure (no internal state); each call to `acquire` either
 * grabs a slot on the underlying guard or doesn't, and returns the
 * shaped result. Idempotency / double-release safety is inherited from
 * the underlying {@link Lease.release}.
 */
export function leaseAsAdmission(
  guard: ConcurrencyGuard,
  options: LeaseAsAdmissionOptions = {},
): LeaseAdmitter {
  const clock = options.clock ?? systemClock;

  return {
    acquire(): LeaseAdmission {
      const lease = guard.acquire();
      const now = clock.now();

      if (lease.ok) {
        return {
          decision: {
            allowed: true,
            limit: guard.limit,
            // inflight already includes our just-acquired slot, so this is post-consume.
            remaining: Math.max(0, guard.limit - guard.inflight),
            resetAt: now,
            retryAfterMs: 0,
          },
          release: lease.release,
        };
      }

      // Rejected: no slot held. The retry hint is honest under Little's Law
      // (average wait ≈ average RTT under saturation); we fall back to 1 ms
      // when no samples have been recorded yet so the field stays a positive
      // integer hint rather than a misleading 0.
      const lastRtt = guard.stats().lastRtt;
      const retryAfterMs = Math.max(1, Math.round(lastRtt || 1));

      return {
        decision: {
          allowed: false,
          limit: guard.limit,
          remaining: 0,
          resetAt: now,
          retryAfterMs,
        },
        // Pass-through for shape uniformity. The underlying rejected lease's
        // release is already a no-op (rejected leases hold no slot), so
        // calling this is harmless if the consumer treats the deny path
        // generically.
        release: lease.release,
      };
    },
  };
}
