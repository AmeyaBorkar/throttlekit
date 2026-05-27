import { systemClock } from "../core/clock";
import { clamp } from "../core/math";
import type { Clock, Decision } from "../core/types";
import { requireAtLeast, requireInteger, requirePositive } from "../core/validate";

/**
 * Admission-control primitives — decide whether to *attempt* work at all, upstream of the
 * per-key rate limiters. Several independent tools live here:
 *
 * - {@link adaptiveThrottle}: Google-SRE client-side adaptive throttling. A client that keeps
 *   hammering an overloaded backend only deepens the overload; this sheds a growing fraction of
 *   requests *locally* (before they leave the client) based on the backend's recent accept rate.
 * - {@link fairShare}: an online equal-share approximation of max-min fairness, so one greedy
 *   tenant cannot consume a shared global budget and starve the others.
 * - {@link weightedMaxMin} + {@link weightedFairShare}: weighted fairness — the exact, work-conserving
 *   weighted max-min split of a contended budget (batch), and its online streaming limiter.
 * - {@link tokenBudget}: a streaming token-budget meter for *post-hoc* costs (e.g. LLM output
 *   tokens, billed only as they stream). Debit the actual tokens as they are produced; overshoot is
 *   bounded by the debit granularity (exactly 0 per token), independent of the per-request cap and
 *   of how many streams meter concurrently. {@link distributedTokenBudget} is its fleet-shared,
 *   {@link Store}-backed form, with the same bound across every gateway at once.
 * - {@link learnedReservation}: an online newsvendor learner for the per-request token *reservation*
 *   that paces admission over a {@link tokenBudget} — it descends onto the cost-optimal quantile with
 *   `O(√T)` regret, while the meter (not the reservation) holds safety unconditionally.
 * - {@link predictiveReservation}: learning-augmented reservation — blend a per-request output-length
 *   *prediction* against {@link learnedReservation} with a Hedge meta-learner: accurate hints drive
 *   cost to the clairvoyant optimum (consistency), adversarial ones fall back to the no-regret
 *   quantile (robustness), and safety is untouched (the prediction is just a number the meter caps).
 *
 * The throttles and budgets read time only through an injected {@link Clock}, so every decision is
 * reproducible to the millisecond under {@link ManualClock}; the learners ({@link learnedReservation})
 * carry no clock at all and are driven purely by the outcomes you feed them. All are pure JavaScript
 * and dependency-free.
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
 * 4. **Per-window memory is O(distinct tenants).** The active-tenant map is cleared only when the
 *    window rolls, so it grows with the number of distinct tenant keys seen within a window. Key it
 *    on a **bounded, trusted** tenant set (not raw client input); for an unbounded/untrusted key
 *    universe, front it with {@link sketchRateLimit}. (Eviction is intentionally not offered here:
 *    dropping a tenant mid-window would change the fair-share divisor and skew the split.)
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

// ── Primitive 3: weighted max-min fairness (Weighted Fair Escrow) ──────────────────────────────

const sumOf = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

function validateAllocation(
  demands: readonly number[],
  weights: readonly number[],
  limit: number,
): void {
  if (demands.length !== weights.length) {
    throw new RangeError(
      `weightedMaxMin: demands/weights length mismatch (${demands.length} vs ${weights.length})`,
    );
  }
  requireAtLeast("weightedMaxMin.limit", limit, 0);
  for (const w of weights) requirePositive("weightedMaxMin.weight", w);
  for (const d of demands) requireAtLeast("weightedMaxMin.demand", d, 0);
}

/**
 * Each tenant's **guaranteed weighted share** `floor(w_i / W * limit)` (`W` = total weight) — the
 * static slice a weighted max-min split never drops a backlogged tenant below. Sums to `<= limit`.
 */
export function guaranteedShare(weights: readonly number[], limit: number): number[] {
  requireAtLeast("guaranteedShare.limit", limit, 0);
  for (const w of weights) requirePositive("guaranteedShare.weight", w);
  const W = sumOf(weights);
  return weights.map((w) => Math.floor((w / W) * limit));
}

/** Continuous weighted max-min (water-filling): raise λ, give tenant i `min(d_i, w_i·λ)`. O(n log n). */
function waterfillContinuous(
  demands: readonly number[],
  weights: readonly number[],
  limit: number,
): number[] {
  const n = demands.length;
  const alloc = new Array<number>(n).fill(0);
  // Ascending demand-per-weight: the cheapest-to-satisfy tenants saturate first and free their weight.
  const order = [...Array(n).keys()].sort(
    (a, b) =>
      (demands[a] as number) / (weights[a] as number) -
      (demands[b] as number) / (weights[b] as number),
  );
  let rem = limit;
  let activeWeight = sumOf(weights);
  for (let k = 0; k < n; k++) {
    const i = order[k] as number;
    const w = weights[i] as number;
    const d = demands[i] as number;
    const level = activeWeight > 0 ? rem / activeWeight : 0;
    if (w * level >= d) {
      alloc[i] = d; // saturates at/below this level
      rem -= d;
      activeWeight -= w;
    } else {
      for (let j = k; j < n; j++) {
        const m = order[j] as number;
        alloc[m] = (weights[m] as number) * level; // level-capped
      }
      break;
    }
  }
  return alloc;
}

/**
 * **Weighted max-min fair allocation** of an integer `limit` across tenants with per-tenant `demands`
 * and positive `weights` — the heart of *Weighted Fair Escrow*. Returns the integer credits each
 * tenant receives:
 *
 * - **work-conserving** — sums to exactly `min(Σ demand, floor(limit))`; a tenant demanding below its
 *   share never strands the remainder, it flows to the backlogged tenants;
 * - **weight-honoring** — every backlogged tenant gets at least its guaranteed share
 *   `floor(w_i/W·limit)`, and surplus is split so all backlogged tenants reach a common *weighted*
 *   service level `a_i / w_i` (perfectly fair up to the ≤ 1-credit integer rounding gap).
 *
 * Equal weights reduce it to ordinary (unweighted) max-min. Computed as continuous water-filling
 * (`O(n log n)`) plus a bounded integer drip of the `< n` rounding remainder, so it is fast even for a
 * large `limit`. Pure. This is the batch primitive; for streaming admission see {@link weightedFairShare}.
 */
export function weightedMaxMin(
  demands: readonly number[],
  weights: readonly number[],
  limit: number,
): number[] {
  validateAllocation(demands, weights, limit);
  const cont = waterfillContinuous(demands, weights, limit);
  const alloc = cont.map((a) => Math.floor(a));
  // Distribute the floored-off remainder (< n credits) to the most-deserving backlogged tenants —
  // smallest normalized service a_i/w_i first — exactly as integer weighted max-min would.
  let leftover = Math.floor(limit) - sumOf(alloc);
  while (leftover > 0) {
    let best = -1;
    let bestRatio = Number.POSITIVE_INFINITY;
    for (let i = 0; i < alloc.length; i++) {
      if ((alloc[i] as number) >= (demands[i] as number)) continue; // fully served
      const ratio = (alloc[i] as number) / (weights[i] as number);
      if (ratio < bestRatio) {
        bestRatio = ratio;
        best = i;
      }
    }
    if (best === -1) break; // all demand met before the budget ran out
    alloc[best] = (alloc[best] as number) + 1;
    leftover--;
  }
  return alloc;
}

/** Options for {@link weightedFairShare}. */
export interface WeightedFairShareOptions {
  /** Global admissions budget shared across all tenants per window. */
  limit: number;
  /** Window width in ms. Windows are aligned to epoch: `floor(now/windowMs)*windowMs`. */
  windowMs: number;
  /** Per-tenant weight (a tenant's share is proportional to it). Default `() => 1` (equal — i.e. fairShare). */
  weightOf?: (tenant: string) => number;
  /** Injected clock. Defaults to {@link systemClock}. */
  clock?: Clock;
}

/**
 * A global, fixed-window budget shared across tenants **in proportion to weight**. The
 * {@link Decision.limit} reported to each tenant is *that tenant's* current weighted fair cap.
 */
export interface WeightedFairShareLimiter {
  /** Synchronous check for `tenant` with `cost` (default 1) and optional per-check `weight` override. */
  checkSync(tenant: string, cost?: number, weight?: number): Decision;
  /** Promise-returning form of {@link WeightedFairShareLimiter.checkSync}; resolves synchronously. */
  check(tenant: string, cost?: number, weight?: number): Promise<Decision>;
  /** Reset one tenant's usage (it leaves the active set), or — with no argument — the whole window. */
  reset(tenant?: string): void;
}

/**
 * **Weighted** equal-share fairness across tenants — the weighted generalization of {@link fairShare}
 * (and the streaming face of {@link weightedMaxMin}). One global budget of `limit` admissions per
 * epoch-aligned window is split so each active tenant's ceiling is proportional to its weight:
 *
 * ```text
 *   fairCap_i = max(1, floor(weight_i / W * limit))      // W = total weight of active tenants
 * ```
 *
 * and a request is admitted iff `total + cost <= limit` **and** `tenantUsed + cost <= fairCap_i`. A
 * weight-4 tenant thus gets ~4× the share of a weight-1 tenant, and no tenant can be starved below its
 * weighted floor by a flood from the others.
 *
 * **Honest limitations (identical in spirit to {@link fairShare} — read them).** This is an *online
 * weighted equal-share approximation*, not exact work-conserving weighted max-min:
 *
 * 1. **Weighted floor + hard global cap (the guarantee).** Every active tenant may admit at least its
 *    weighted floor `floor(w_i/W·limit)` (`W` = active weight at the time), and the window total never
 *    exceeds `limit`.
 * 2. **Caps shrink as tenants arrive.** `W` only grows within a window, so an early tenant that took
 *    its full share keeps it even after later arrivals lower everyone's cap (self-corrects next window).
 * 3. **Surplus is first-come, not redistributed.** Capacity left idle by light tenants is handed out
 *    first-come up to `limit`, not perfectly reallocated by weight the way true max-min would. When you
 *    have all tenants' demands at once and want the exact, fully work-conserving weighted split, call
 *    {@link weightedMaxMin} instead (e.g. to divide a node's leased batch among its local tenants).
 * 4. **Per-window memory is O(distinct tenants)** (same as {@link fairShare}): key it on a bounded,
 *    trusted tenant set, or front an untrusted key universe with {@link sketchRateLimit}.
 */
export function weightedFairShare(options: WeightedFairShareOptions): WeightedFairShareLimiter {
  requirePositive("weightedFairShare.limit", options.limit);
  requirePositive("weightedFairShare.windowMs", options.windowMs);

  const limit = Math.floor(options.limit);
  const windowMs = options.windowMs;
  const clock = options.clock ?? systemClock;
  const weightOf = options.weightOf ?? ((): number => 1);

  let windowStart = Number.NEGATIVE_INFINITY;
  let total = 0;
  const used = new Map<string, number>();
  const weights = new Map<string, number>();

  function rollWindow(now: number): void {
    if (now >= windowStart + windowMs) {
      windowStart = Math.floor(now / windowMs) * windowMs;
      total = 0;
      used.clear();
      weights.clear();
    }
  }

  function checkSync(tenant: string, cost = 1, weight?: number): Decision {
    requirePositive("weightedFairShare.cost", cost);
    const w = weight ?? weightOf(tenant);
    requirePositive("weightedFairShare.weight", w);

    const now = clock.now();
    rollWindow(now);
    const resetAt = Math.ceil(windowStart + windowMs);

    if (!used.has(tenant)) used.set(tenant, 0);
    weights.set(tenant, w); // a tenant's latest weight; also marks it active
    const tenantUsed = used.get(tenant) ?? 0;

    // Weighted equal split across everyone active so far, floored — but at least 1 so a tenant is
    // never handed a zero cap. W is the live active-weight sum (grows as tenants appear this window).
    let activeWeight = 0;
    for (const wv of weights.values()) activeWeight += wv;
    const fairCap = Math.max(1, Math.floor((w / activeWeight) * limit));

    const allowed = total + cost <= limit && tenantUsed + cost <= fairCap;
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
    check(tenant: string, cost = 1, weight?: number): Promise<Decision> {
      return Promise.resolve(checkSync(tenant, cost, weight));
    },
    reset(tenant?: string): void {
      if (tenant === undefined) {
        windowStart = Number.NEGATIVE_INFINITY;
        total = 0;
        used.clear();
        weights.clear();
        return;
      }
      const tenantUsed = used.get(tenant);
      if (tenantUsed !== undefined) {
        total -= tenantUsed;
        used.delete(tenant);
        weights.delete(tenant);
      }
    },
  };
}

// ── Primitive 4: tokenBudget (streaming token-budget meter for post-hoc costs) ──────────────────

/** Options for {@link tokenBudget}. */
export interface TokenBudgetOptions {
  /** Token budget `L` enforced over each window. Floored to an integer; must be positive. */
  budget: number;
  /** Window width in ms. Windows are epoch-aligned: `floor(now/windowMs)*windowMs`. */
  windowMs: number;
  /** Injected clock. Defaults to {@link systemClock}. */
  clock?: Clock;
}

/**
 * A windowed token-budget meter — the streaming face of post-hoc cost control. Debit the *actual*
 * tokens a stream produces as they are produced; see {@link tokenBudget}.
 */
export interface TokenBudgetMeter {
  /** Atomically debit `tokens` (default 1, a positive integer) against the current window. */
  debitSync(tokens?: number): Decision;
  /** Promise-returning form of {@link TokenBudgetMeter.debitSync}; resolves synchronously. */
  debit(tokens?: number): Promise<Decision>;
  /** Tokens remaining in the current window (`>= 0`); rolls the window but does not debit. */
  remaining(): number;
  /** Forget all usage; the next call starts a fresh window. */
  reset(): void;
}

/**
 * **Streaming token-budget meter** — enforce a budget of `L` tokens per window when each request's
 * cost is revealed only *as it streams*. This is the LLM-gateway problem: you do not know how many
 * output tokens a completion will use until it has produced them, so you cannot price it at
 * admission.
 *
 * Call {@link TokenBudgetMeter.debit} for each chunk a stream produces (ideally one token at a
 * time). A debit is **admitted iff budget remains before it** (`served < L`); the single debit that
 * crosses `L` is still counted in full, then every later debit in the window is refused
 * (`allowed: false`) so the caller stops generating. This *stop-at-boundary* rule bounds the
 * overshoot by the debit granularity:
 *
 * ```text
 *   worst-case overshoot  Δ  ≤  (largest single debit) − 1
 * ```
 *
 * so **per-token debiting (`tokens = 1`) overshoots by exactly 0** — the meter stops on the token
 * that reaches `L`. Two properties make this strong:
 *
 * - **Independent of the per-request cap (`max_tokens`).** The meter never reserves a request's
 *   cap; it counts only what is actually produced. A heavy-tailed length distribution costs it
 *   nothing, so utilization stays ~1 with no tail waste.
 * - **Independent of concurrency.** Because each debit's check and increment are a single
 *   synchronous step, only the one crossing debit can exceed `L`, no matter how many streams meter
 *   through the instance at once.
 *
 * It thus dominates the two production corners on both axes at once:
 *
 * - **reserve `max_tokens` up front** (e.g. an API gateway that estimates the cap at admission and
 *   reconciles later): never overshoots, but sterilizes most of every reservation on a heavy tail —
 *   utilization collapses as the cap grows.
 * - **admit-then-count** (charge the real cost only at completion): fully utilized, but the streams
 *   in flight when the budget runs out overshoot by up to `C · max_tokens` (`C` = concurrency).
 *
 * The meter gives reserve-max's safety (`Δ = 0` per token) at admit-then-count's utilization (`~1`),
 * with no dependence on the cap.
 *
 * **Single-instance / single-gateway.** The synchronous check-then-increment is atomic only within
 * one process. To share a budget across a fleet of gateways, back it with an atomic shared counter:
 * that is GALE window-coupled leasing with the token as the unit (see
 * `research/cost-uncertainty/PROPOSAL.md`), so the distributed token meter inherits the leased
 * budget's fleet-size-independent overshoot bound.
 *
 * Not to be confused with {@link tokenBucket}, a *rate* limiter that refills capacity over time:
 * `tokenBudget` enforces a *fixed quota* of post-hoc-metered cost over a fixed window.
 *
 * @example
 * const meter = tokenBudget({ budget: 100_000, windowMs: 60_000 });
 * for await (const tok of completion) {
 *   if (!meter.debitSync(1).allowed) break; // budget spent — stop generating
 *   emit(tok);
 * }
 */
export function tokenBudget(options: TokenBudgetOptions): TokenBudgetMeter {
  requirePositive("tokenBudget.budget", options.budget);
  requirePositive("tokenBudget.windowMs", options.windowMs);

  const L = Math.floor(options.budget);
  const windowMs = options.windowMs;
  const clock = options.clock ?? systemClock;

  // -Infinity guarantees the first call (at any finite `now`) starts a fresh, epoch-aligned window.
  let windowStart = Number.NEGATIVE_INFINITY;
  let served = 0;

  function rollWindow(now: number): void {
    if (now >= windowStart + windowMs) {
      windowStart = Math.floor(now / windowMs) * windowMs;
      served = 0;
    }
  }

  function debitSync(tokens = 1): Decision {
    requirePositive("tokenBudget.tokens", tokens);
    requireInteger("tokenBudget.tokens", tokens);

    const now = clock.now();
    rollWindow(now);
    const resetAt = Math.ceil(windowStart + windowMs);

    // Stop-at-boundary: refuse once the budget is already spent (`served >= L`). The cost is
    // post-hoc — the tokens of an admitted debit are already produced, so we count them honestly
    // and simply stop admitting more. The crossing debit can carry `served` to (L-1)+tokens, an
    // overshoot of at most tokens-1 (0 when debiting per token); all later debits land here.
    if (served >= L) {
      return {
        allowed: false,
        limit: L,
        remaining: 0,
        resetAt,
        retryAfterMs: Math.max(0, Math.ceil(resetAt - now)),
      };
    }
    served += tokens;
    return {
      allowed: true,
      limit: L,
      remaining: Math.max(0, L - served),
      resetAt,
      retryAfterMs: 0,
    };
  }

  return {
    debitSync,
    debit(tokens = 1): Promise<Decision> {
      return Promise.resolve(debitSync(tokens));
    },
    remaining(): number {
      const now = clock.now();
      rollWindow(now);
      return Math.max(0, L - served);
    },
    reset(): void {
      windowStart = Number.NEGATIVE_INFINITY;
      served = 0;
    },
  };
}

/**
 * The fleet-shared, {@link Store}-backed sibling of {@link tokenBudget}: the same stop-at-boundary
 * rule run as an atomic read-modify-write against a shared counter, so one budget `L` is enforced
 * across every gateway with a per-token overshoot of 0 independent of fleet size.
 */
export { distributedTokenBudget } from "./distributed-budget";
export type {
  DistributedTokenBudgetMeter,
  DistributedTokenBudgetOptions,
} from "./distributed-budget";

// ── Primitive 5: learnedReservation (TALE Layer 2 — online learned token reservation) ───────────

/** Options for {@link learnedReservation}. */
export interface LearnedReservationOptions {
  /** Hold cost `h`: penalty per token *reserved but unused* — the cost of a needless reject. Must be `> 0`. */
  holdCost: number;
  /** Overrun cost `p`: penalty per token of realised cost *beyond* the reservation — the cost of an abort. Must be `> 0`. */
  overrunCost: number;
  /** Upper clamp on the reservation = the per-request cap `m`; also the reservation-domain diameter. Must be `> 0`. */
  maxReservation: number;
  /** Lower clamp on the reservation. Default `0` (no admission gate — admit into any free slot). */
  minReservation?: number;
  /** Initial reservation. Default the feasible midpoint `(minR+maxR)/2`, a neutral prior. */
  initialReservation?: number;
  /** OGD step scale `η₀` in the step `η₀/√t`. Default `D/G = (maxR−minR)/max(h,p)`, the Zinkevich-optimal scale. */
  stepScale?: number;
}

/** A learned per-request reservation: commit a reservation, then learn from each realised cost. */
export interface LearnedReservation {
  /** The integer reservation to commit for the next request, in `[minReservation, maxReservation]`. */
  reserve(): number;
  /** Feed the realised cost once a request completes; updates the reservation for subsequent requests. */
  observe(cost: number): void;
  /** The continuous internal reservation (before rounding/clamping), for introspection. */
  readonly continuous: number;
}

/**
 * The **critical-fractile** quantile level `τ = p/(h+p)` — the cost quantile that minimises the
 * asymmetric newsvendor / pinball loss, and the target {@link learnedReservation} descends onto. With
 * `h = p` it is the median (`0.5`); a costlier overrun (`p > h`) pushes it toward higher percentiles.
 */
export function criticalFractile(holdCost: number, overrunCost: number): number {
  requirePositive("criticalFractile.holdCost", holdCost);
  requirePositive("criticalFractile.overrunCost", overrunCost);
  return overrunCost / (holdCost + overrunCost);
}

/**
 * **Online learned reservation** (TALE Layer 2) — learn the per-request token *reservation* `r` that
 * best paces admission over a {@link tokenBudget}, when each request's true cost (its output tokens)
 * is revealed only *after* it runs.
 *
 * A {@link tokenBudget} bounds *overshoot* for any reservation, but admission still needs a reservation
 * committed *before* the cost is known — it sets the 429 and paces concurrency. Reserve too much
 * (`r = max_tokens`) and you reject admissible traffic and starve concurrency; reserve too little and
 * you over-admit, so the meter has to abort in-flight streams at the boundary (wasted half-finished
 * work). The per-request regret of a reservation `r` against the realised cost `c` is the asymmetric
 * **newsvendor / pinball** loss
 *
 * ```text
 *   ℓ(r, c) = holdCost·(r − c)₊  +  overrunCost·(c − r)₊
 * ```
 *
 * whose population minimiser is the {@link criticalFractile} quantile `τ = overrunCost/(holdCost+overrunCost)`
 * of the cost distribution. This learns it online with **projected online gradient descent** (Zinkevich,
 * ICML'03): {@link LearnedReservation.reserve} commits the current reservation, and
 * {@link LearnedReservation.observe} feeds back the realised cost (full information — the cost is known
 * once the stream finishes), stepping the reservation by the pinball subgradient (`+h` when it
 * over-reserved, `−p` when it under-reserved). With the canonical `η_t = η₀/√t` step this attains
 * **`O(√T)` regret** versus the best fixed reservation in hindsight (`R_T ≤ (3/2)·D·G·√T`, with
 * `D = maxR−minR`, `G = max(h,p)`; see `research/cost-uncertainty/REGRET-ANALYSIS.md`).
 *
 * **Safety is not this learner's job.** The reservation only governs the false-reject ⇆ abort
 * trade-off; the {@link tokenBudget} meter caps production at the budget for *any* reservation
 * whatsoever, so no choice of `r` — learned, maximal, or zero — can breach the budget `L`. Pair the
 * two: the meter holds the hard bound, this learner makes admission efficient.
 *
 * Pure and deterministic — no clock, no RNG; driven entirely by the costs you
 * {@link LearnedReservation.observe}. For predictions-with-safety (a per-request length hint blended
 * against this robust learner), see {@link predictiveReservation}.
 *
 * @example
 * const meter = tokenBudget({ budget: 100_000, windowMs: 60_000 });
 * const policy = learnedReservation({ holdCost: 1, overrunCost: 4, maxReservation: 4096 });
 * // at admission, only let a request in if its reservation fits the remaining budget:
 * if (policy.reserve() <= meter.remaining()) {
 *   let produced = 0;
 *   for await (const tok of completion) {
 *     if (!meter.debitSync(1).allowed) break; // budget spent — stop generating
 *     produced++;
 *     emit(tok);
 *   }
 *   policy.observe(produced); // learn from the realised cost
 * }
 */
export function learnedReservation(options: LearnedReservationOptions): LearnedReservation {
  const h = options.holdCost;
  const p = options.overrunCost;
  requirePositive("learnedReservation.holdCost", h);
  requirePositive("learnedReservation.overrunCost", p);
  const maxR = options.maxReservation;
  requirePositive("learnedReservation.maxReservation", maxR);
  const minR = options.minReservation ?? 0;
  requireAtLeast("learnedReservation.minReservation", minR, 0);
  if (minR > maxR) {
    throw new RangeError(
      `learnedReservation.minReservation must be <= maxReservation, got ${minR} > ${maxR}`,
    );
  }
  if (options.stepScale !== undefined) {
    requirePositive("learnedReservation.stepScale", options.stepScale);
  }

  // Zinkevich-optimal step scale η₀ = D/G: diameter D = maxR−minR over subgradient bound G = max(h,p).
  const stepScale = options.stepScale ?? Math.max((maxR - minR) / Math.max(h, p), 1e-6);

  let r = clamp(options.initialReservation ?? (minR + maxR) / 2, minR, maxR);
  let t = 0;

  return {
    reserve(): number {
      return Math.round(r);
    },
    observe(cost: number): void {
      // Subgradient of ℓ(r,c) w.r.t. r: +h if we over-reserved (r > c), −p if we under-reserved.
      // E[g] = h·F(r) − p·(1−F(r)) = 0 ⇔ F(r) = p/(h+p) = τ, so OGD descends onto the τ-quantile.
      t += 1;
      const grad = r > cost ? h : -p;
      const step = stepScale / Math.sqrt(t);
      r = clamp(r - step * grad, minR, maxR);
    },
    get continuous(): number {
      return r;
    },
  };
}

// ── Primitive 6: predictiveReservation (TALE Layer 3 — learning-augmented reservation) ──────────

/** Asymmetric newsvendor / pinball loss: holdCost per token over-reserved, overrunCost per token of overrun. */
function reservationCost(
  reservation: number,
  cost: number,
  holdCost: number,
  overrunCost: number,
): number {
  return reservation > cost ? holdCost * (reservation - cost) : overrunCost * (cost - reservation);
}

/** Options for {@link predictiveReservation}. */
export interface PredictiveReservationOptions extends LearnedReservationOptions {
  /** Hedge learning rate `η` (expert weights ∝ `exp(−η · cumulative expert loss)`). Default `0.01`. */
  learningRate?: number;
}

/** A predictions-with-safety reservation: blend a per-request length hint against the robust learner. */
export interface PredictiveReservation {
  /** Commit a reservation for the next request, given its predicted output length. */
  reserve(prediction: number): number;
  /** Learn from the realised cost: update both experts' weights and the robust learner. */
  observe(cost: number): void;
  /** Current expert weights `[followPrediction, robust]` (sum to 1), for introspection. */
  readonly weights: readonly [number, number];
}

/**
 * **Learning-augmented reservation** (TALE Layer 3) — like {@link learnedReservation}, but able to
 * exploit a *per-request* output-length prediction when one is available, without trusting it.
 *
 * Predicting an LLM completion's exact length is infeasible, but its relative *rank* is learnable
 * (Fu et al., "Efficient LLM Scheduling by Learning to Rank", NeurIPS'24). This runs two experts each
 * request — "follow the prediction" and the robust {@link learnedReservation} quantile learner — and a
 * **Hedge** meta-learner sets convex weights from each expert's realised pinball loss; it plays the
 * weighted-average reservation. Because the pinball loss is convex, Jensen gives
 * `loss(blend) ≤ weighted-average expert loss`, and Hedge drives weight onto the better expert:
 *
 * - **accurate predictions ⇒ weight → follow ⇒ cost → the clairvoyant optimum** (consistency);
 * - **adversarial predictions ⇒ weight → robust ⇒ cost → the no-regret quantile** (robustness).
 *
 * **Safety is untouched.** The reservation is just a number the {@link tokenBudget} meter overrides at
 * the budget boundary, so *no* prediction — however adversarial — can breach the budget. This is the
 * predictions-with-safety guarantee on the cost axis: speed up the common case, never trade away the
 * hard bound.
 *
 * Pure and deterministic — no clock, no RNG. You supply the prediction; if you have none, pass `0`
 * (or use {@link learnedReservation} directly). Design + proofs: `research/cost-uncertainty/`.
 *
 * @example
 * const policy = predictiveReservation({ holdCost: 1, overrunCost: 4, maxReservation: 4096 });
 * const r = policy.reserve(predictedOutputLength); // blends the hint with the robust learner
 * // …run the request under a tokenBudget meter, then:
 * policy.observe(producedTokens);
 */
export function predictiveReservation(
  options: PredictiveReservationOptions,
): PredictiveReservation {
  const h = options.holdCost;
  const p = options.overrunCost;
  requirePositive("predictiveReservation.holdCost", h);
  requirePositive("predictiveReservation.overrunCost", p);
  const minR = options.minReservation ?? 0;
  const maxR = options.maxReservation;
  const eta = options.learningRate ?? 0.01;
  requirePositive("predictiveReservation.learningRate", eta);

  const robust = learnedReservation(options); // validates holdCost, overrunCost, and the bounds
  let cumFollow = 0;
  let cumRobust = 0;
  let lastFollow = minR;
  let lastRobust = minR;

  /** Hedge weights via a numerically-stable softmax of the negated, η-scaled cumulative losses. */
  function weights(): [number, number] {
    const m = Math.min(cumFollow, cumRobust);
    const ef = Math.exp(-eta * (cumFollow - m));
    const er = Math.exp(-eta * (cumRobust - m));
    const z = ef + er;
    return [ef / z, er / z];
  }

  return {
    reserve(prediction: number): number {
      lastFollow = clamp(prediction, minR, maxR);
      lastRobust = robust.reserve();
      const [wf, wr] = weights();
      return Math.round(clamp(wf * lastFollow + wr * lastRobust, minR, maxR));
    },
    observe(cost: number): void {
      // Score each expert on its own counterfactual pinball loss for this request (full information).
      cumFollow += reservationCost(lastFollow, cost, h, p);
      cumRobust += reservationCost(lastRobust, cost, h, p);
      robust.observe(cost);
    },
    get weights(): [number, number] {
      return weights();
    },
  };
}
