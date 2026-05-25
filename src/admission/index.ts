import { systemClock } from "../core/clock";
import type { Clock, Decision } from "../core/types";
import { requireAtLeast, requirePositive } from "../core/validate";

/**
 * Admission-control primitives — decide whether to *attempt* work at all, upstream of the
 * per-key rate limiters. Two independent tools live here:
 *
 * - {@link adaptiveThrottle}: Google-SRE client-side adaptive throttling. A client that keeps
 *   hammering an overloaded backend only deepens the overload; this sheds a growing fraction of
 *   requests *locally* (before they leave the client) based on the backend's recent accept rate.
 * - {@link fairShare}: an online equal-share approximation of max-min fairness, so one greedy
 *   tenant cannot consume a shared global budget and starve the others.
 *
 * Both are pure JavaScript, dependency-free, and read time only through an injected {@link Clock},
 * so every decision is reproducible to the millisecond under {@link ManualClock}.
 */

// ── Primitive 1: adaptiveThrottle (Google SRE client-side adaptive throttling) ─────────────────

/** Options for {@link adaptiveThrottle}. */
export interface AdaptiveThrottleOptions {
  /**
   * Acceptance multiplier `K` from the SRE formula. With `K = 2` the client only begins shedding
   * once it is sending more than twice what the backend accepts, tolerating a 50% rejection rate
   * before throttling locally; larger `K` is more permissive (sheds later). Must be `>= 1` — a `K`
   * below 1 would shed even a perfectly healthy backend. Default `2` (the SRE Book's value).
   */
  k?: number;
  /**
   * Width of the rolling accounting window in ms. `requests`/`accepts` are tracked over roughly the
   * trailing `windowMs` so a past overload is forgotten as the backend recovers. Default `10_000`.
   */
  windowMs?: number;
  /** Injected time source. Default {@link systemClock}. */
  clock?: Clock;
  /**
   * Source of randomness for the probabilistic shed, returning a value in `[0, 1)`. Inject a
   * seeded PRNG to make shedding deterministic in tests. Default `Math.random`.
   */
  random?: () => number;
}

/**
 * A client-side adaptive throttle. Track every request attempt with {@link AdaptiveThrottle.request}
 * (which tells you whether to send or shed) and feed back each sent request's outcome with
 * {@link AdaptiveThrottle.record}.
 */
export interface AdaptiveThrottle {
  /**
   * Decide whether to send the next request to the backend. Returns `true` to **send**, `false` to
   * **shed locally** (fail fast without touching the backend). Always counts as a request attempt,
   * whether or not it is shed.
   *
   * `priority` in `[0, 1]` (default `0`) scales the shed probability by `(1 - priority)`: a
   * `priority` of `1` is never shed, `0` is shed at the full rate. Use it to protect critical
   * traffic (health checks, payments) while shedding the bulk.
   */
  request(priority?: number): boolean;
  /**
   * Feed back the backend's outcome for a request that was **sent** (i.e. a {@link request} that
   * returned `true`). Counts an accept iff `accepted`. Locally-shed requests must NOT be recorded:
   * leaving them out is exactly what keeps the reject probability elevated until the backend
   * recovers.
   */
  record(accepted: boolean): void;
  /** The current local reject probability `p` in `[0, 1]`. Read-only; does not mutate state. */
  rejectProbability(): number;
  /** A point-in-time snapshot for metrics/introspection (rolling counts + current `p`). */
  stats(): { requests: number; accepts: number; rejectProbability: number };
}

/**
 * Client-side adaptive throttling — Google SRE Book, Chapter 21 "Handling Overload", the
 * "Client-Side Throttling" section.
 *
 * The client tracks, over a recent window, `requests` (application-layer attempts) and `accepts`
 * (requests the backend accepted). It rejects a new request *locally*, before it ever leaves the
 * client, with probability:
 *
 * ```text
 *   p = max(0, (requests - K * accepts) / (requests + 1))
 * ```
 *
 * When the backend is healthy (`accepts ≈ requests`) the numerator is negative, so `p ≈ 0` and
 * everything is sent. As the backend starts rejecting (`accepts → 0`) the numerator approaches
 * `requests`, so `p → requests/(requests+1) ≈ 1` and the client sheds nearly everything — which
 * relieves the backend instead of piling on. The `+1` in the denominator keeps `p` finite and
 * gentle when only a handful of requests have been seen.
 *
 * **Rolling-window choice (documented).** Rather than a hard reset every `windowMs` (which would
 * make `p` lurch — it would briefly read 0 right after a boundary even mid-overload), this keeps a
 * *previous* and a *current* epoch-aligned fixed window and reports a **time-weighted** blend:
 * `count = current + previous * (1 - elapsedFractionOfCurrentWindow)`. As the current window fills,
 * the previous window's contribution decays linearly to zero, so an old overload is forgotten
 * smoothly over roughly one `windowMs`. (This is the standard sliding-window-counter approximation,
 * the same shape used by {@link slidingWindow}; it weights by *time*, not by the actual arrival
 * positions within the previous window.)
 */
export function adaptiveThrottle(options: AdaptiveThrottleOptions = {}): AdaptiveThrottle {
  const k = options.k ?? 2;
  const windowMs = options.windowMs ?? 10_000;
  const clock = options.clock ?? systemClock;
  const random = options.random ?? Math.random;

  // K below 1 would shed a perfectly healthy backend (accepts == requests => p > 0), which is never
  // what you want; the SRE formula assumes K >= 1.
  requireAtLeast("adaptiveThrottle.k", k, 1);
  requirePositive("adaptiveThrottle.windowMs", windowMs);

  // Two adjacent epoch-aligned windows. `curStart` is the start of the live window; `prev*` hold the
  // immediately preceding window's totals so they can decay out as the live window fills.
  let curStart = Number.NEGATIVE_INFINITY;
  let curRequests = 0;
  let curAccepts = 0;
  let prevRequests = 0;
  let prevAccepts = 0;

  /**
   * Advance the rolling windows to `now`. On crossing exactly one window boundary the live window
   * becomes the previous one; crossing two or more (a long idle gap) clears both — there is no
   * recent history to weight.
   */
  function roll(now: number): void {
    const start = Math.floor(now / windowMs) * windowMs;
    if (start === curStart) return;
    if (start === curStart + windowMs) {
      // Slid forward by exactly one window: today's counts become yesterday's.
      prevRequests = curRequests;
      prevAccepts = curAccepts;
    } else {
      // Jumped two or more windows (or first-ever call): nothing recent survives.
      prevRequests = 0;
      prevAccepts = 0;
    }
    curStart = start;
    curRequests = 0;
    curAccepts = 0;
  }

  /** Fraction in `[0, 1)` of how far `now` is into the live window — the previous window's decay. */
  function elapsedFraction(now: number): number {
    return (now - curStart) / windowMs;
  }

  /** Time-weighted rolling requests at `now` (assumes {@link roll} already ran for `now`). */
  function rollingRequests(now: number): number {
    return curRequests + prevRequests * (1 - elapsedFraction(now));
  }

  /** Time-weighted rolling accepts at `now` (assumes {@link roll} already ran for `now`). */
  function rollingAccepts(now: number): number {
    return curAccepts + prevAccepts * (1 - elapsedFraction(now));
  }

  /** The SRE formula on the current rolling counts at `now`. */
  function probabilityAt(now: number): number {
    const requests = rollingRequests(now);
    const accepts = rollingAccepts(now);
    return Math.max(0, (requests - k * accepts) / (requests + 1));
  }

  return {
    request(priority = 0): boolean {
      const now = clock.now();
      roll(now);
      // Compute p BEFORE counting this attempt, so a single request against an idle, healthy
      // throttle (requests == accepts == 0 => p == 0) is always sent.
      const p = probabilityAt(now);
      curRequests++;

      // High priority shrinks the effective shed probability; priority 1 disables shedding entirely.
      const clampedPriority = priority <= 0 ? 0 : priority >= 1 ? 1 : priority;
      const effectiveP = p * (1 - clampedPriority);

      // Shed iff the draw lands under the effective probability. effectiveP <= 0 never sheds
      // (random() is in [0, 1)); effectiveP >= 1 always sheds.
      return !(random() < effectiveP);
    },

    record(accepted: boolean): void {
      const now = clock.now();
      roll(now);
      if (accepted) curAccepts++;
    },

    rejectProbability(): number {
      const now = clock.now();
      roll(now);
      return probabilityAt(now);
    },

    stats(): { requests: number; accepts: number; rejectProbability: number } {
      const now = clock.now();
      roll(now);
      return {
        requests: rollingRequests(now),
        accepts: rollingAccepts(now),
        rejectProbability: probabilityAt(now),
      };
    },
  };
}

// ── Primitive 2: fairShare (equal-share fairness across tenants) ───────────────────────────────

/** Options for {@link fairShare}. */
export interface FairShareOptions {
  /** Global admissions budget shared across all tenants per window. */
  limit: number;
  /** Window width in ms. Windows are aligned to epoch: `floor(now/windowMs)*windowMs`. */
  windowMs: number;
  /** Injected clock. Defaults to {@link systemClock}. */
  clock?: Clock;
}

/**
 * A global, fixed-window budget shared fairly across tenants. The {@link Decision.limit} reported
 * to each tenant is *that tenant's* current fair cap, not the global budget.
 */
export interface FairShareLimiter {
  /** Synchronous, zero-`await` check for `tenant` with the given `cost` (default 1). */
  checkSync(tenant: string, cost?: number): Decision;
  /** Promise-returning form of {@link FairShareLimiter.checkSync}; resolves synchronously. */
  check(tenant: string, cost?: number): Promise<Decision>;
  /** Reset one tenant's usage (it leaves the active set), or — with no argument — the whole window. */
  reset(tenant?: string): void;
}

/**
 * Equal-share fairness across tenants — an online approximation of **max-min fair allocation**
 * (Bertsekas & Gallager, "Data Networks", 2nd ed., §6.5.2 "max-min flow control"; the same
 * fairness goal as Nagle's fair queuing, RFC 970, "On Packet Switches with Infinite Storage").
 *
 * One global budget of `limit` admissions per epoch-aligned window is shared so that no single
 * tenant can monopolize it. Within a window we track the global total admitted, each tenant's
 * admitted amount, and the set of tenants that have been **active** (made at least one check) this
 * window. A tenant joins the active set on its first check. The per-tenant ceiling is
 *
 * ```text
 *   fairCap = max(1, floor(limit / activeCount))
 * ```
 *
 * and a request is admitted iff `total + cost <= limit` **and** `tenantUsed + cost <= fairCap`.
 *
 * **Honest limitations (read these — do not over-rely on the word "fair").** This is an *online
 * equal-share approximation*, not exact, work-conserving max-min fairness:
 *
 * 1. **No starvation, hard global cap (what it *does* guarantee).** Every active tenant may admit at
 *    least `floor(limit / N)` (where `N` is the active-tenant count at the time), and the global
 *    total admitted in a window never exceeds `limit`. So a greedy tenant cannot starve the others,
 *    and the budget is never overspent.
 * 2. **Caps shrink mid-window.** `fairCap` is recomputed from the *current* `activeCount`, which
 *    only ever grows within a window. A tenant that grabbed its full share early, before others
 *    appeared, keeps what it already took even though everyone's cap has since dropped — so the
 *    realized split can be less even than `limit / N` for that window. (It self-corrects next
 *    window, which starts fresh.)
 * 3. **Not work-conserving; spare capacity is first-come.** Capacity left unused by idle tenants is
 *    handed out on a first-come basis up to the global `limit`, **not** perfectly redistributed to
 *    the remaining tenants the way true max-min fairness would. An active tenant can use idle
 *    tenants' slack only until those tenants show up or the global budget runs out.
 *
 * In short: a robust anti-starvation budget splitter with a hard global ceiling — not a precise
 * max-min fair scheduler.
 */
export function fairShare(options: FairShareOptions): FairShareLimiter {
  requirePositive("fairShare.limit", options.limit);
  requirePositive("fairShare.windowMs", options.windowMs);

  const limit = Math.floor(options.limit);
  const windowMs = options.windowMs;
  const clock = options.clock ?? systemClock;

  // -Infinity guarantees the first check (at any finite `now`) is treated as a fresh window.
  let windowStart = Number.NEGATIVE_INFINITY;
  let total = 0;
  /** Per-tenant admitted units this window. Membership doubles as the active set. */
  const used = new Map<string, number>();

  /** Roll to a fresh, epoch-aligned window if `now` has crossed the current window's end. */
  function rollWindow(now: number): void {
    if (now >= windowStart + windowMs) {
      windowStart = Math.floor(now / windowMs) * windowMs;
      total = 0;
      used.clear();
    }
  }

  function checkSync(tenant: string, cost = 1): Decision {
    requirePositive("fairShare.cost", cost);

    const now = clock.now();
    rollWindow(now);
    const resetAt = Math.ceil(windowStart + windowMs);

    // First check this window makes the tenant active; this also fixes the divisor for the cap.
    if (!used.has(tenant)) used.set(tenant, 0);
    const tenantUsed = used.get(tenant) ?? 0;

    // Equal split of the global budget across everyone active so far, floored — but at least 1 so a
    // tenant is never handed a zero cap once N exceeds `limit`.
    const fairCap = Math.max(1, Math.floor(limit / used.size));

    const fitsGlobal = total + cost <= limit;
    const fitsFair = tenantUsed + cost <= fairCap;
    const allowed = fitsGlobal && fitsFair;

    if (allowed) {
      used.set(tenant, tenantUsed + cost);
      total += cost;
      return {
        allowed: true,
        limit: fairCap,
        remaining: Math.max(0, Math.floor(fairCap - (tenantUsed + cost))),
        resetAt,
        retryAfterMs: 0,
      };
    }

    return {
      allowed: false,
      limit: fairCap,
      remaining: Math.max(0, Math.floor(fairCap - tenantUsed)),
      resetAt,
      retryAfterMs: Math.ceil(resetAt - now),
    };
  }

  return {
    checkSync,
    check(tenant: string, cost = 1): Promise<Decision> {
      return Promise.resolve(checkSync(tenant, cost));
    },
    reset(tenant?: string): void {
      if (tenant === undefined) {
        // Reset the whole window: forget all tenants and force a fresh window on the next check.
        windowStart = Number.NEGATIVE_INFINITY;
        total = 0;
        used.clear();
        return;
      }
      // Reset a single tenant: refund its usage to the global total and drop it from the active set
      // (so it no longer counts toward the fair-share divisor).
      const tenantUsed = used.get(tenant);
      if (tenantUsed !== undefined) {
        total -= tenantUsed;
        used.delete(tenant);
      }
    },
  };
}
