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
 * Each tenant has a *dynamic guaranteed share* `gᵢ = ⌊wᵢ/W·L_effective⌋` recomputed from the
 * current active set on every check (`W` = total weight of active tenants;
 * `L_effective` = the credits visible to this process — see "L1 vs L2" below). The check is
 * hierarchical:
 *
 * 1. **Within guarantee** (`used + cost ≤ gᵢ`): always allowed, subject to the hard cap
 *    `Σ used + cost ≤ L_effective`. This is the T2 sharing-incentive promise.
 * 2. **Borrow phase** (`used + cost > gᵢ`): the asker tries to grow into surplus that other tenants
 *    have not yet claimed against their own guarantee. The pessimistic surplus available is
 *
 *    ```text
 *      borrowAvailable = max(0, (L_effective − Σ used) − Σⱼ≠ᵢ max(0, gⱼ − usedⱼ))
 *    ```
 *
 *    i.e. the unallocated budget minus what would still need to be served to *other* backlogged
 *    tenants' guarantees. If `cost ≤ borrowAvailable`, the request is admitted; otherwise denied.
 *
 * ## L1 vs L2: what `L_effective` means
 *
 * Two configurations share the same fairness algorithm but differ in where `L_effective` comes
 * from:
 *
 * - **L1-only (single-process)** — `L_effective` is just `options.limit`; the whole budget is
 *   visible to this one process. The bound is `Σ used ≤ L` within the process.
 * - **L2-backed (multi-process)** — when an L2 `Store` is configured, `L_effective` starts at 0
 *   each window and grows lazily: when a check needs more credits than the local pool holds, the
 *   WFE leases `quantum` credits (or `cost` if larger) atomically from a shared L2 counter
 *   (a `fixedWindow({ limit: L, windowMs })` against the same key on every process). The L2
 *   counter's atomicity bounds the *global* total at `L` across processes; within a process the
 *   leased-and-used credits feed the same fairness math. See DESIGN.md §6.3 / §6.4 for the
 *   multi-process T1/T2/T4 bounds (each cross-process bound picks up a `quantum`-scaled slack).
 *
 * ## What the streaming algorithm does and does not promise vs the batch ideal
 *
 * The batch `weightedMaxMin(d, w, L)` (in `src/admission/`) gives the exact lexicographically-
 * maximal split given the *complete* demand vector. Streaming WFE can only know each tenant's
 * declared demand at their check sites; the asymptotic behaviour matches:
 *
 * - **T1 safety** — `Σ used ≤ L` always (guarantee floor + L_remaining cap; L2 atomicity for the
 *   cross-process case). ✓
 * - **T2 sharing-incentive** — every active tenant is admissible up to `gᵢ` before any other
 *   tenant can borrow beyond their `gⱼ`, within a process and against the process's `L_effective`.
 *   Across processes, T2 scales by the process's leased share; see DESIGN.md §6.4. ✓
 * - **T3 work-conservation** — surplus from idle tenants flows to backlogged ones, but only when
 *   `gⱼ − usedⱼ` for all `j` ≠ asker has been pessimistically reserved. A tenant who stops mid-
 *   window keeps their guaranteed reserve until the window rolls — the safe choice when we cannot
 *   distinguish "stopped" from "about to ask again." Work-conservation is therefore realised
 *   between *truly absent* tenants (who never join the active set), not between *paused* ones; the
 *   gap is the documented streaming-vs-batch trade. End-of-window T3 holds.
 * - **T4 bounded unfairness** — `0` at the L1 layer (exact integer guarantees per check).
 *   `Σₚ Q⁽ᵖ⁾ · (1/wᵢ + 1/wⱼ)` across processes in L2 mode (the DRR quantum bound, scaled by the
 *   number of processes contending for the shared pool).
 *
 * The cost is `O(N)` per check (L1 mode) or `O(N) + 1 RTT` per check that triggers a lease (L2
 * mode), with `N` = active tenants this window. For the bounded-`N` production case (`N ≤ 1024`
 * via `l1.maxKeys`), the L1 bookkeeping is sub-microsecond per call.
 *
 * ## What it is not
 *
 * - **Not strategy-proof.** Per FairRide (Pu et al., NSDI'16): no shared-cache primitive can be
 *   sharing-incentive, work-conserving, AND strategy-proof at once. WFE takes the first two and
 *   concedes the third honestly. A tenant *can* over-declare demand to claim surplus; window-
 *   coupling bounds the gain to one window.
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

import { fixedWindow } from "../algorithms/fixed-window";
import { systemClock } from "../core/clock";
import { ThrottleKitError } from "../core/errors";
import { decisionTransform } from "../core/transform";
import type { Clock, Decision, Store } from "../core/types";
import { requireCost, requireInteger, requirePositive } from "../core/validate";

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
   * **L2 backing (multi-process)** — when provided, the shared budget lives in this `Store`
   * (any distributed store: Redis, Postgres, MemoryStore for tests). Each process atomically
   * leases credits from the shared counter via the existing `fixedWindow({ limit: L, windowMs })`
   * strategy (DR-P4-5 — no new Lua); per-tenant fairness arithmetic stays in-process. When omitted,
   * the limiter is single-process and the full `limit` is visible immediately.
   */
  l2?: Store;
  /**
   * L2-only: the per-process **lease size** — how many credits to acquire from the shared store
   * at a time. Larger quantum = fewer round trips, looser cross-process T4 bound
   * (`Σₚ Q⁽ᵖ⁾ · (1/wᵢ + 1/wⱼ)`). Must be a positive integer. Required when `l2` is set; ignored
   * when omitted. There is no default — tune it to your latency-vs-fairness budget.
   */
  quantum?: number;
  /**
   * L2-only: the shared store's key for this WFE instance. All processes sharing a budget MUST
   * use the same key. Default `"tk:wfe:pool"`.
   */
  l2Key?: string;
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
   * Synchronous only when L1-only (no `l2` configured); with `l2` configured the lease step is
   * async and {@link WeightedFairEscrowLimiter.checkSync} throws.
   */
  checkSync(tenant: string, cost?: number): Decision;
  /** Promise-returning form; required path when `l2` is configured. */
  check(tenant: string, cost?: number): Promise<Decision>;
  /**
   * Reset one tenant's per-window usage (it leaves the active set), or — with no argument — the
   * whole window. The freed `used` is returned to the unallocated pool, so other backlogged
   * tenants can grow into it on subsequent checks. **L2 note:** in L2 mode this does NOT reset
   * the shared store — it only resets in-process accounting. The shared store rolls itself at the
   * next window boundary; call `store.reset(l2Key)` explicitly to force a global reset.
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
  /** Configured per-window budget `L` (constant). */
  readonly limit: number;
  /**
   * Effective `L_effective` visible to this process. In L1-only mode = `limit`; in L2 mode it
   * grows lazily as the process leases from the shared store, capped at `limit`.
   */
  readonly effectiveLimit: number;
  /** Effective unallocated pool: `effectiveLimit − Σ used`. */
  readonly pool: number;
  /** Total used across all tenants this window (in this process). */
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
 * // Single-process WFE (no `l2`):
 * import { weightedFairEscrow } from "throttlekit/twotier";
 *
 * const escrow = weightedFairEscrow({
 *   limit: 10_000,                                    // L
 *   windowMs: 60_000,
 *   weightOf: (tenant) => tenantWeights[tenant] ?? 1,
 * });
 * const d = await escrow.check("tenant-A", 5);
 *
 * @example
 * // Multi-process WFE — one shared L2 counter, atomic leases:
 * import { weightedFairEscrow, MemoryStore } from "throttlekit";
 * import { RedisStore } from "throttlekit/redis";
 *
 * const escrow = weightedFairEscrow({
 *   limit: 10_000,
 *   windowMs: 60_000,
 *   weightOf: (t) => tenantWeights[t] ?? 1,
 *   l2: new RedisStore({ client }),
 *   quantum: 100,                                     // per-process lease size
 *   l2Key: "tk:wfe:my-gateway",                       // same on every process
 * });
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

  // L2 backing — validate up front to fail fast on misconfiguration.
  const l2 = options.l2;
  let quantum = 0;
  if (l2 !== undefined) {
    if (options.quantum === undefined) {
      throw new RangeError(
        "weightedFairEscrow: `quantum` is required when `l2` is configured (DR-P4-2 — controls the per-process lease size to the shared store)",
      );
    }
    requirePositive("weightedFairEscrow.quantum", options.quantum);
    requireInteger("weightedFairEscrow.quantum", options.quantum);
    quantum = options.quantum;
  }
  const l2Key = options.l2Key ?? "tk:wfe:pool";

  // The same shared-store strategy every process leases against. Using fixedWindow keeps the wire
  // surface zero-add: this is the same script (and JS transform) that has shipped since 0.7.x and
  // is conformance-pinned in `test/conformance/`.
  const sharedStrategy = l2 !== undefined ? fixedWindow({ limit: L, windowMs }) : undefined;

  // -Infinity guarantees the first call (at any finite `now`) opens a fresh, epoch-aligned window.
  let windowStart = Number.NEGATIVE_INFINITY;
  // `L_effective` is what this process sees as its budget for the fairness math. In L1 mode it
  // equals `L`; in L2 mode it starts at 0 each window and grows via leases.
  let lEffective = l2 === undefined ? L : 0;
  // Insertion order preserved so eviction is approximate-FIFO when `l1.maxKeys` is set.
  const tenants = new Map<string, TenantEntry>();

  function rollWindow(now: number): void {
    if (now >= windowStart + windowMs) {
      windowStart = Math.floor(now / windowMs) * windowMs;
      lEffective = l2 === undefined ? L : 0;
      tenants.clear();
    }
  }

  /**
   * Per-tenant dynamic guaranteed share `gᵢ = ⌊wᵢ·L_effective/W⌋` for the current active set.
   * Multiplication-first to avoid the float-precision trap of `(w/W)*L` (e.g. `(6/11)*99 =
   * 53.999...` floors to 53, not 54). The integer-first form `(w·L)/W` keeps the numerator exact
   * up to MAX_SAFE_INTEGER and floors correctly.
   */
  function guaranteedShare(weight: number, totalWeight: number): number {
    return Math.floor((weight * lEffective) / totalWeight);
  }

  /** Aggregate the active set in one scan: total weight + total used. */
  function aggregate(): { totalWeight: number; totalUsed: number } {
    let totalWeight = 0;
    let totalUsed = 0;
    for (const t of tenants.values()) {
      totalWeight += t.weight;
      totalUsed += t.used;
    }
    return { totalWeight, totalUsed };
  }

  /**
   * Run the L1 fairness algorithm against the current `lEffective`. The algorithm is identical
   * across L1 and L2 modes; what changes is only how `lEffective` is grown (synchronously fixed
   * at `L` for L1; lazily leased from L2). Returns the Decision; if denied, the caller (in L2
   * mode) may try a lease and re-run.
   */
  function decide(entry: TenantEntry, cost: number, now: number): Decision {
    const resetAt = Math.ceil(windowStart + windowMs);
    const { totalWeight, totalUsed } = aggregate();
    const gAsker = guaranteedShare(entry.weight, totalWeight);
    const lRemaining = lEffective - totalUsed;

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
    const wanted = entry.used + cost - gAsker;
    // Cap per-call borrow at the call's own `cost` — this is the DRR quantum semantics adapted
    // to variable-cost calls (a call of size c borrows at most c beyond its guarantee, matching
    // Shreedhar-Varghese's q-per-round bound). It also keeps the T4 bound at
    // |aᵢ/wᵢ − aⱼ/wⱼ| ≤ max_cost · (1/wᵢ + 1/wⱼ) — for the common cost=1 case the bound is the
    // canonical DRR bound. Without the cap, a single call could borrow the entire slack `L − Σg`,
    // dilating the spread to `(L − Σg)/w_min`.
    const grantable = Math.min(wanted, cost, borrowAvailable, lRemaining);
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

  function bootstrapTenant(tenant: string, w: number): TenantEntry {
    if (tenants.size >= maxKeys) {
      const oldest = tenants.keys().next();
      if (!oldest.done) tenants.delete(oldest.value);
    }
    const entry: TenantEntry = { weight: w, used: 0 };
    tenants.set(tenant, entry);
    return entry;
  }

  function validateInputs(tenant: string, cost: number): number {
    if (typeof tenant !== "string" || tenant.length === 0) {
      throw new TypeError("weightedFairEscrow: tenant must be a non-empty string");
    }
    requireCost(cost);
    const w = weightOf(tenant);
    requirePositive("weightedFairEscrow.weight", w);
    return w;
  }

  function checkSync(tenant: string, cost = 1): Decision {
    if (l2 !== undefined) {
      throw new ThrottleKitError(
        "weightedFairEscrow.checkSync is unavailable when `l2` is configured (L2 lease is async); use check()",
      );
    }
    const w = validateInputs(tenant, cost);
    const now = clock.now();
    rollWindow(now);
    let entry = tenants.get(tenant);
    if (entry === undefined) entry = bootstrapTenant(tenant, w);
    else entry.weight = w;
    return decide(entry, cost, now);
  }

  async function check(tenant: string, cost = 1): Promise<Decision> {
    const w = validateInputs(tenant, cost);
    const now = clock.now();
    rollWindow(now);
    let entry = tenants.get(tenant);
    if (entry === undefined) entry = bootstrapTenant(tenant, w);
    else entry.weight = w;

    if (l2 === undefined) {
      return decide(entry, cost, now);
    }

    // L2 path. Top up `lEffective` by leasing from the shared store whenever the local budget is
    // insufficient to satisfy the T1 cap (`L_remaining ≥ cost`). The borrow phase's reserve math
    // is bounded by `lEffective`, so growing it grows both `gᵢ` and the reserve in lockstep —
    // leasing past T1 satisfaction doesn't help the borrow-blocked-by-reserve case and would only
    // pull more credits out of the shared pool unnecessarily. Documented in DESIGN.md §6.3.
    for (;;) {
      const { totalUsed } = aggregate();
      const lRem = lEffective - totalUsed;
      if (lRem >= cost) break;
      const needed = cost - lRem;
      const leaseAmount = Math.max(needed, quantum);
      // Use the existing fixedWindow strategy as the atomic leasing primitive (DR-P4-5). The
      // transform wraps the strategy's pure transition + the Lua acceleration; the store runs it
      // atomically against the shared `l2Key`.
      // sharedStrategy is set whenever l2 is set (constructor-time invariant). Cast through a
      // local non-null type to satisfy TS without a runtime check on the hot path.
      const strat = sharedStrategy as NonNullable<typeof sharedStrategy>;
      const leased = await (l2 as Store).apply(l2Key, decisionTransform(strat, now, leaseAmount));
      if (!leased.allowed) {
        // The shared store says no — surface its retryAfter as the tenant's denial. We do NOT
        // grow lEffective for a denied lease.
        const resetAt = Math.ceil(windowStart + windowMs);
        return {
          allowed: false,
          limit: Math.max(0, entry.used),
          remaining: 0,
          resetAt,
          retryAfterMs: leased.retryAfterMs,
        };
      }
      lEffective += leaseAmount;
      // Loop to recompute lRem; one iteration usually suffices, but `lEffective + L` could be
      // capped if the shared store's window has rolled mid-lease — re-check.
      if (lEffective >= L) break; // nothing more to lease beyond the global cap
    }

    return decide(entry, cost, now);
  }

  return {
    checkSync,
    check,
    reset(tenant?: string): void {
      if (tenant === undefined) {
        windowStart = Number.NEGATIVE_INFINITY;
        lEffective = l2 === undefined ? L : 0;
        tenants.clear();
        return;
      }
      tenants.delete(tenant);
    },
    stats(): WeightedFairEscrowStats {
      const snapshot: Array<{ tenant: string; weight: number; used: number }> = [];
      let tot = 0;
      for (const [k, t] of tenants) {
        tot += t.used;
        snapshot.push({ tenant: k, weight: t.weight, used: t.used });
      }
      return {
        windowStart,
        limit: L,
        effectiveLimit: lEffective,
        pool: lEffective - tot,
        totalUsed: tot,
        tenants: snapshot,
      };
    },
  };
}
