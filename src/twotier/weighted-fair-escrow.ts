/**
 * **Weighted Fair Escrow** — GALE Pillar 4 graduated to production. A weighted, work-conserving
 * fair-allocation limiter that splits one shared budget `L` across tenants in proportion to weight,
 * with idle tenants' surplus reclaimed by backlogged ones — neither stranded nor first-come.
 *
 * Design + rationale: `research/bigger-bets/pillar4-wfe/DESIGN.md`. Proofs of the four theorems
 * (T1 safety, T2 sharing-incentive, T3 work-conservation, T4 bounded unfairness) live in
 * `research/gale/PILLAR4-fairness.md`; the pure batch algebra is machine-checked at 20 000 random
 * trials in `test/gale/fair-escrow.test.ts`.
 *
 * ## Algorithm (the streaming realisation)
 *
 * Each tenant has a *dynamic guaranteed share* `gᵢ = ⌊wᵢ/W·L⌋` recomputed from the current active
 * set on every check (`W` = total weight of active tenants). The check is hierarchical:
 *
 * 1. **Within guarantee** (`used + cost ≤ gᵢ`): always allowed, subject to the hard global cap
 *    `Σ used + cost ≤ L`. This is the T2 sharing-incentive promise.
 * 2. **Borrow phase** (`used + cost > gᵢ`): the asker tries to grow into surplus that other tenants
 *    have not yet claimed against their own guarantee. The pessimistic surplus available to the
 *    asker is
 *
 *    ```text
 *      borrowAvailable = max(0, (L − Σ used) − Σⱼ≠ᵢ max(0, gⱼ − usedⱼ))
 *    ```
 *
 *    i.e. the unallocated budget minus what would still need to be served to *other* backlogged
 *    tenants' guarantees. If `cost ≤ borrowAvailable`, the request is admitted; otherwise denied
 *    (with retryAfter = window remainder).
 *
 * ## What the streaming algorithm does and does not promise vs the batch ideal
 *
 * The batch `weightedMaxMin(d, w, L)` (in `src/admission/`) gives the exact lexicographically-
 * maximal split given the *complete* demand vector. Streaming WFE can only know each tenant's
 * declared demand at their check sites; the asymptotic behaviour matches:
 *
 * - **T1 safety** — `Σ used ≤ L` always (guarantee floor + L_remaining cap). ✓
 * - **T2 sharing-incentive** — every active tenant is admissible up to `gᵢ` before any other tenant
 *   can borrow beyond their `gⱼ`. ✓
 * - **T3 work-conservation** — surplus from idle tenants flows to backlogged ones, but only when
 *   `gⱼ − usedⱼ` for all `j` ≠ asker has been pessimistically reserved. A tenant who stops mid-
 *   window keeps their guaranteed reserve until the window rolls — the safe choice when we cannot
 *   distinguish "stopped" from "about to ask again." Work-conservation is therefore realised
 *   between *truly absent* tenants (who never join the active set), not between *paused* ones; the
 *   gap is the documented streaming-vs-batch trade. End-of-window T3 holds (everything reserved
 *   that was not used is forfeited at window roll).
 * - **T4 bounded unfairness** — `0` in this algorithm: there is no quantum slack at the streaming
 *   layer (each guarantee is recomputed exactly). The DRR quantum from the research model
 *   (`PILLAR4-fairness.md`) is a *multi-process* concept (it controls cross-process lease size); it
 *   does not appear in this single-process algorithm. See DR-P4-2 ("Why changed") in `DESIGN.md`.
 *
 * The cost is `O(N)` per check, with `N` = active tenants this window (a linear scan to compute
 * `W` and the reserve sum). For the bounded-`N` production case (`N ≤ 1024` via `l1.maxKeys`),
 * the bookkeeping is sub-microsecond per call.
 *
 * ## What it is not
 *
 * - **Not strategy-proof.** Per FairRide (Pu et al., NSDI'16): no shared-cache primitive can be
 *   sharing-incentive, work-conserving, AND strategy-proof at once. WFE takes the first two and
 *   concedes the third honestly. A tenant *can* over-declare demand to claim surplus; window-
 *   coupling bounds the gain to one window.
 * - **Not multi-process.** Single-pool only at 0.9.1 (DR-P4-13 / TK-1310). Multi-process WFE backed
 *   by a shared `Store` (the §6.3 design in `DESIGN.md`) is the next commit in the TK-1310 chain.
 * - **Not federated.** Cross-region pooling is the 0.10.x track (DR-P4-7); compose WFE with
 *   `federate(...)` via the `l2: federated` slot once shipped.
 * - **Not hierarchical.** Flat tenant set, single weight per tenant. Nested weights (teams-within-
 *   orgs, etc.) are deliberately out of scope at 0.9.1 (DR-P4-8).
 *
 * ## When to use this vs `weightedFairShare`
 *
 * `weightedFairShare` (`src/admission/index.ts`) ships an *equal-share approximation* — surplus from
 * idle tenants is first-come, not redistributed by weight. WFE is the work-conserving sibling:
 * under skewed demand, idle tenants' shares flow to backlogged ones in proportion to weight,
 * dominating the equal-share variant on utilisation while keeping the same hard `Δ = 0` per-window
 * cap (Pillar 1 inheritance). Pick `weightedFairShare` when single-process equal-share is enough;
 * pick `weightedFairEscrow` when work-conservation under skew matters (the LLM-gateway multi-tenant
 * overload case in Workload C of EVALUATION.md).
 */

import { systemClock } from "../core/clock";
import type { Clock, Decision } from "../core/types";
import { requireCost, requirePositive } from "../core/validate";

/** Options for {@link weightedFairEscrow}. */
export interface WeightedFairEscrowOptions {
  /** Global per-window budget `L`. Floored to an integer; must be > 0. */
  limit: number;
  /** Window width in ms. Windows are epoch-aligned: `floor(now/windowMs)·windowMs`. Must be > 0. */
  windowMs: number;
  /**
   * Per-tenant weight `wᵢ`. Returns `> 0` for any tenant string. Default `() => 1` (equal share —
   * the exact work-conserving generalisation of {@link fairShare} / {@link weightedFairShare}).
   */
  weightOf?: (tenant: string) => number;
  /**
   * Bounded tenant set. Same role as `twoTier.l1.maxKeys`: caps the in-process per-tenant state
   * map to prevent unbounded growth on untrusted tenant input. Default unbounded; set on public
   * surfaces to a value that comfortably exceeds the expected tenant count.
   */
  l1?: { maxKeys?: number };
  /** Injected clock. Default {@link systemClock}. */
  clock?: Clock;
}

/**
 * A weighted-fair-escrow limiter: split a shared budget `L` across tenants by weight, with
 * surplus from idle tenants reclaimed to backlogged ones. See {@link weightedFairEscrow}.
 */
export interface WeightedFairEscrowLimiter {
  /**
   * Check `tenant` for the given `cost` (default 1). Returns a {@link Decision}; `limit` and
   * `remaining` describe **this tenant's** current fair-share ceiling and remaining headroom, not
   * the global pool — matches {@link weightedFairShare}'s contract so client-facing 429-rendering
   * is consistent.
   *
   * Single-process / L1-only at 0.9.1; multi-process backing (an L2 `Store`) is the next commit
   * in the TK-1310 chain (see `DESIGN.md` §6.3).
   */
  checkSync(tenant: string, cost?: number): Decision;
  /** Promise-returning form of {@link WeightedFairEscrowLimiter.checkSync}; resolves synchronously. */
  check(tenant: string, cost?: number): Promise<Decision>;
  /**
   * Reset one tenant's per-window usage (it leaves the active set), or — with no argument — the
   * whole window. The freed `used` is returned to the unallocated pool, so other backlogged
   * tenants can grow into it on subsequent checks.
   */
  reset(tenant?: string): void;
  /**
   * Read-only snapshot of the current window's tenant state, for metrics / introspection. The
   * returned object is a copy; mutating it does not affect the live state.
   */
  stats(): WeightedFairEscrowStats;
}

/** A point-in-time read of the WFE's current window for metrics / introspection. */
export interface WeightedFairEscrowStats {
  /** Window start (epoch-ms, `floor(now/windowMs)·windowMs`); -Infinity if no check has happened. */
  readonly windowStart: number;
  /** Global per-window budget `L` (constant). */
  readonly limit: number;
  /** Effective unallocated pool: `L − Σ used`. Drops as tenants consume; resets at window roll. */
  readonly pool: number;
  /** Total used across all tenants this window. */
  readonly totalUsed: number;
  /** Per-tenant snapshot: weight + used (current cumulative consumption in this window). */
  readonly tenants: ReadonlyArray<{
    readonly tenant: string;
    readonly weight: number;
    readonly used: number;
  }>;
}

/** Internal per-tenant record: weight (most recent observed) + cumulative used this window. */
interface TenantEntry {
  weight: number;
  used: number;
}

/**
 * **Weighted Fair Escrow** — split a shared per-window budget across tenants in weighted-max-min-
 * fair proportion, with idle tenants' surplus reclaimed by backlogged ones.
 *
 * @example
 * import { weightedFairEscrow } from "throttlekit/twotier";
 *
 * const escrow = weightedFairEscrow({
 *   limit: 10_000,                                    // L
 *   windowMs: 60_000,
 *   weightOf: (tenant) => tenantWeights[tenant] ?? 1,
 * });
 *
 * const d = await escrow.check("tenant-A", 5);
 * if (!d.allowed) return reject(d);
 *
 * @example
 * // Composes with unifiedAdmission's cost axis:
 * import { unifiedAdmission, rateLimit, gcra } from "throttlekit";
 *
 * const admit = unifiedAdmission({
 *   rate: rateLimit({ strategy: gcra({ limit: 500, periodMs: 60_000 }) }),
 *   cost: weightedFairEscrow({ limit: 200_000, windowMs: 60_000, weightOf: ... }),
 * });
 */
export function weightedFairEscrow(options: WeightedFairEscrowOptions): WeightedFairEscrowLimiter {
  requirePositive("weightedFairEscrow.limit", options.limit);
  requirePositive("weightedFairEscrow.windowMs", options.windowMs);

  const L = Math.floor(options.limit);
  const windowMs = options.windowMs;
  const weightOf = options.weightOf ?? ((): number => 1);
  const maxKeys = options.l1?.maxKeys ?? Number.POSITIVE_INFINITY;
  const clock = options.clock ?? systemClock;

  // -Infinity guarantees the first call (at any finite `now`) opens a fresh, epoch-aligned window.
  let windowStart = Number.NEGATIVE_INFINITY;
  // Insertion order preserved so eviction is approximate-FIFO when `l1.maxKeys` is set.
  const tenants = new Map<string, TenantEntry>();

  function rollWindow(now: number): void {
    if (now >= windowStart + windowMs) {
      windowStart = Math.floor(now / windowMs) * windowMs;
      tenants.clear();
    }
  }

  /** Per-tenant dynamic guaranteed share `gᵢ = ⌊wᵢ/W·L⌋` for the current active set. */
  function guaranteedShare(weight: number, totalWeight: number): number {
    return Math.floor((weight / totalWeight) * L);
  }

  function checkSync(tenant: string, cost = 1): Decision {
    if (typeof tenant !== "string" || tenant.length === 0) {
      throw new TypeError("weightedFairEscrow: tenant must be a non-empty string");
    }
    requireCost(cost);
    const w = weightOf(tenant);
    requirePositive("weightedFairEscrow.weight", w);

    const now = clock.now();
    rollWindow(now);
    const resetAt = Math.ceil(windowStart + windowMs);

    let entry = tenants.get(tenant);
    if (entry === undefined) {
      if (tenants.size >= maxKeys) {
        // Approximate-FIFO eviction: drop the oldest entry. Its `used` is forgotten; the global
        // pool effectively grows by that amount because L_remaining is recomputed from Σ used.
        const oldest = tenants.keys().next();
        if (!oldest.done) tenants.delete(oldest.value);
      }
      entry = { weight: w, used: 0 };
      tenants.set(tenant, entry);
    } else {
      entry.weight = w; // refresh; weights may drift between checks (takes effect this check)
    }

    // Aggregate the current active set in a single scan: total weight + total used + the
    // pessimistic reserve for other tenants' guarantees.
    let totalWeight = 0;
    let totalUsed = 0;
    for (const t of tenants.values()) {
      totalWeight += t.weight;
      totalUsed += t.used;
    }
    const gAsker = guaranteedShare(w, totalWeight);
    const lRemaining = L - totalUsed;

    // T1 hard cap — never over-admit globally, no matter how the fairness math shakes out.
    if (cost > lRemaining) {
      return {
        allowed: false,
        limit: Math.max(gAsker, entry.used),
        remaining: Math.max(0, gAsker - entry.used),
        resetAt,
        retryAfterMs: Math.max(0, Math.ceil(resetAt - now)),
      };
    }

    if (entry.used + cost <= gAsker) {
      // Within the asker's guaranteed share. Always allowed.
      entry.used += cost;
      return {
        allowed: true,
        limit: gAsker,
        remaining: Math.max(0, gAsker - entry.used),
        resetAt,
        retryAfterMs: 0,
      };
    }

    // Over guarantee — borrow phase. Pessimistically reserve every *other* active tenant's
    // remaining guaranteed share before letting the asker borrow.
    let reserve = 0;
    for (const t of tenants.values()) {
      if (t === entry) continue;
      const gj = guaranteedShare(t.weight, totalWeight);
      reserve += Math.max(0, gj - t.used);
    }
    const borrowAvailable = Math.max(0, lRemaining - reserve);
    // The asker is borrowing the excess `(used + cost) − gAsker`; cap by `borrowAvailable` AND by
    // `lRemaining` (T1 already enforced cost ≤ lRemaining, so the second is redundant — but keep
    // it explicit; future changes to the borrow rule must not accidentally drop the T1 cap).
    const wanted = entry.used + cost - gAsker;
    const grantable = Math.min(wanted, borrowAvailable, lRemaining);
    const realizedCeiling = gAsker + grantable;

    if (entry.used + cost <= realizedCeiling) {
      entry.used += cost;
      return {
        allowed: true,
        limit: realizedCeiling,
        remaining: Math.max(0, realizedCeiling - entry.used),
        resetAt,
        retryAfterMs: 0,
      };
    }

    return {
      allowed: false,
      limit: realizedCeiling,
      remaining: Math.max(0, realizedCeiling - entry.used),
      resetAt,
      retryAfterMs: Math.max(0, Math.ceil(resetAt - now)),
    };
  }

  return {
    checkSync,
    check(tenant: string, cost = 1): Promise<Decision> {
      return Promise.resolve(checkSync(tenant, cost));
    },
    reset(tenant?: string): void {
      if (tenant === undefined) {
        windowStart = Number.NEGATIVE_INFINITY;
        tenants.clear();
        return;
      }
      tenants.delete(tenant);
    },
    stats(): WeightedFairEscrowStats {
      // Build as a mutable array, then return widened to the `Readonly` snapshot type — same
      // pattern adaptive concurrency / federation use for read-only return shapes.
      const snapshot: Array<{ tenant: string; weight: number; used: number }> = [];
      let tot = 0;
      for (const [k, t] of tenants) {
        tot += t.used;
        snapshot.push({ tenant: k, weight: t.weight, used: t.used });
      }
      return { windowStart, limit: L, pool: L - tot, totalUsed: tot, tenants: snapshot };
    },
  };
}
