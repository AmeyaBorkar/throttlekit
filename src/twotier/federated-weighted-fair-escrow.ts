/**
 * **Federated Weighted Fair Escrow** — GALE Pillar 4 lifted across regions (TK-1404, #176).
 *
 * `weightedFairEscrow` splits ONE budget `L` across tenants in one process. This composes it across
 * REGIONS so that the **per-tenant GLOBAL total** — summed over every region a tenant is active in —
 * is the weighted-max-min-fair allocation a single, flat, global WFE would produce. The regions are
 * plumbing, not a fairness boundary: a tenant is neither helped nor hurt by *which* region it lives in.
 *
 * ## The composition (why naive pooling is not enough, and what works)
 *
 * Hierarchical max-min fairness is in general **not** flat max-min fairness — running WFE per region
 * over a budget shared by a plain first-come-first-served counter gives *in-region* weighted fairness
 * but *cross-region* FCFS pooling: a heavily-weighted region that arrives late is starved by a
 * lightly-weighted one (HLS isolation, Saeed et al. 2021; the same gap a shared counter leaves). Flat
 * global fairness emerges only under the Parekh-Gallager GPS-decomposition conditions, which this
 * mechanism realises by composing **two levels of WFE**:
 *
 *   1. **Cross-region WFE (the {@link RegionFairPool}).** A weighted-fair *reservation* layer over
 *      regions: region `r`'s weight is its DYNAMIC active aggregate tenant weight `W_r = Σ w_{t,r}`,
 *      and the pool grants region `r` at least its guaranteed share `⌊W_r/ΣW·L⌋` (reserved — a busy
 *      region cannot steal it) and lets it borrow idle regions' surplus (work-conservation). A plain
 *      counter cannot reserve, which is exactly why cross-region weights need this layer.
 *   2. **In-region WFE (per tenant).** The same `weightedFairEscrow` arithmetic (T1 cap, T2 guarantee,
 *      T4 DRR-bounded borrow) splits each region's pool-granted budget among its tenants by weight.
 *   3. **Demand-proportional weight-split.** A tenant active in several regions must have its global
 *      weight `w_t` SPLIT, `w_{t,r}=w_t·d_{t,r}/d_t` (so `Σ_r w_{t,r}=w_t`); returning the full `w_t`
 *      in every region double-counts it and over-serves ≈k×. `weightOf` returns the region-local
 *      split weight (for a region-local tenant, just `w_t`).
 *
 * Setting the region weight to `Σ` of its tenants' weights is the GPS-decomposition condition that
 * collapses the two-level hierarchy to a single global water-fill: the per-tenant global total equals
 * the flat global weighted-max-min ideal **exactly in the fluid limit**, and within a two-level DRR
 * residual under discrete granting. Proof + the machine-checked gate:
 * `research/bigger-bets/federation/federated-wfe-gate.ts`; theorem write-up (T-FED-1 safety, T-FED-2
 * fluid exactness, T-FED-3 bound): `research/gale/PILLAR4-fairness.md`.
 *
 * ## Safety
 *
 * The pool grants `Σ_r (region budget) ≤ L` and in-region WFE serves `Σ_t used ≤` the region budget,
 * so `Σ admitted ≤ L` globally regardless of region count — `Δ = 0`. Both levels only *reorder* who
 * gets a credit; neither raises the total.
 *
 * ## Topology / distribution
 *
 * The {@link RegionFairPool} is the shared cross-region authority. {@link regionFairPool} is the
 * in-process implementation: correct + complete for a single arbiter process that all regions consult
 * (e.g. a central rate-limit service), and the substrate the tests verify against the flat oracle.
 * Distributing the pool across separate region processes needs the same per-region accounting in a
 * shared store (a Redis hash of region→{weight,used}, the weighted analog of `RegionalEscrow`'s Lua) —
 * the documented production path (DR-FWFE-1), staged exactly as `weightedFairEscrow` shipped L1 then L2.
 *
 * ## What it is / is not
 *
 * - **`checkSync` available** (the in-process pool is synchronous); `check` is the Promise form.
 * - **Not strategy-proof** (inherited from WFE T5 / FairRide): a tenant can over-declare demand to
 *   claim surplus; window-coupling bounds the gain to one window.
 *
 * @example
 * import { regionFairPool, federatedWeightedFairEscrow } from "throttlekit";
 *
 * const pool = regionFairPool({ limit: 1_000_000, windowMs: 60_000 }); // global L, shared
 * const us = federatedWeightedFairEscrow({ region: "us-east", pool, weightOf: (t) => weights[t] ?? 1 });
 * const eu = federatedWeightedFairEscrow({ region: "eu-west", pool, weightOf: (t) => weights[t] ?? 1 });
 * us.checkSync("tenant-A", 5);
 */

import { systemClock } from "../core/clock";
import type { Clock, Decision } from "../core/types";
import { requireCost, requirePositive } from "../core/validate";
import type { Region } from "../federation/types";

/**
 * Safety cap on the per-check region-budget re-lease loop. Each iteration strictly grows the region
 * budget (or returns when the pool caps the region at its fair share), so the loop terminates well
 * within this bound in practice (typically 1–3 iterations); the cap only guards a pathological
 * fixpoint. Hitting it simply lets `decide` deny — never an over-admit.
 */
const MAX_LEASE_ITERS = 64;

// ─────────────────────────── cross-region pool (level 1) ───────────────────

/** Options for {@link regionFairPool}. */
export interface RegionFairPoolOptions {
  /** Global per-window budget `L`, shared across ALL regions. Floored to an integer; must be > 0. */
  limit: number;
  /** Window width in ms. Epoch-aligned. Must be > 0. All regions on this pool share it. */
  windowMs: number;
  /** Injected clock. Default {@link systemClock}. */
  clock?: Clock;
}

/** Per-region snapshot for {@link RegionFairPool.stats}. */
export interface RegionFairPoolStats {
  readonly windowStart: number;
  readonly limit: number;
  readonly totalGranted: number;
  readonly regions: ReadonlyArray<{
    readonly region: string;
    readonly weight: number;
    readonly granted: number;
  }>;
}

/**
 * The shared cross-region weighted-fair reservation layer — a WFE whose "tenants" are regions. One
 * pool instance is shared by all {@link federatedWeightedFairEscrow} regions drawing from one global
 * budget. See the module doc for why a plain shared counter is insufficient (no reservation).
 */
export interface RegionFairPool {
  /** Global budget `L`. */
  readonly limit: number;
  /** Window width in ms. */
  readonly windowMs: number;
  /** The pool's clock (regions couple their tenant windows to it). */
  readonly clock: Clock;
  /**
   * Grant region `region` (current active aggregate weight `weight`) up to `wantTotal` total credits
   * for the active window, respecting cross-region weighted-max-min: the region is guaranteed at least
   * `⌊weight/ΣW·L⌋` (reserved) and may borrow idle regions' surplus, with `Σ_r granted ≤ L`. Returns
   * the region's new total grant (monotonic within a window). `now` is the caller's clock reading.
   */
  grant(region: string, weight: number, wantTotal: number, now: number): number;
  /** Drop a region from the active set (its grant returns to the pool for others). */
  release(region: string, now: number): void;
  /** Read-only snapshot of the current window. */
  stats(): RegionFairPoolStats;
}

interface RegionEntry {
  weight: number;
  granted: number;
}

/**
 * In-process {@link RegionFairPool}: cross-region weighted-max-min with reservation + borrow. This is
 * the shipped, tested substrate; distributing it across processes is the store-backed production path
 * (DR-FWFE-1). The grant arithmetic is the region-level analog of `weightedFairEscrow.decide`.
 */
export function regionFairPool(options: RegionFairPoolOptions): RegionFairPool {
  requirePositive("regionFairPool.limit", options.limit);
  requirePositive("regionFairPool.windowMs", options.windowMs);
  const L = Math.floor(options.limit);
  const windowMs = options.windowMs;
  const clock = options.clock ?? systemClock;

  let windowStart = Number.NEGATIVE_INFINITY;
  const regions = new Map<string, RegionEntry>();

  function rollWindow(now: number): void {
    if (now >= windowStart + windowMs) {
      windowStart = Math.floor(now / windowMs) * windowMs;
      regions.clear();
    }
  }

  return {
    limit: L,
    windowMs,
    clock,
    grant(region: string, weight: number, wantTotal: number, now: number): number {
      requirePositive("regionFairPool.weight", weight);
      rollWindow(now);
      let entry = regions.get(region);
      if (entry === undefined) {
        entry = { weight, granted: 0 };
        regions.set(region, entry);
      } else {
        entry.weight = weight;
      }
      if (wantTotal <= entry.granted) return entry.granted; // already holds enough; monotonic

      let totalWeight = 0;
      for (const r of regions.values()) totalWeight += r.weight;

      // Every OTHER *active* region is reserved `max(its current grant, its guarantee gⱼ)`: we protect
      // what it already holds AND its full guaranteed share. This region grows into whatever is left;
      // `max(entry.granted, …)` keeps grants monotonic, and the mutual reservation makes `Σ granted ≤ L`
      // inductively (`self ≤ L − Σ_{j≠self} max(grantedⱼ, gⱼ) ≤ L − Σ_{j≠self} grantedⱼ`). This is the
      // tenant-level borrow math (`weightedFairEscrow.decide`) lifted one level, to regions — including
      // its streaming-vs-batch trade: a region that joined the active set keeps its guaranteed reserve
      // until the window rolls, so work-conservation is realised against TRULY ABSENT regions (which
      // never call `grant`), not paused ones. Identical honesty to in-region WFE (PILLAR4 T3).
      let othersHold = 0;
      for (const [name, r] of regions) {
        if (name === region) continue;
        const gj = totalWeight > 0 ? Math.floor((r.weight * L) / totalWeight) : 0;
        othersHold += Math.max(r.granted, gj);
      }
      const ceiling = Math.max(entry.granted, L - othersHold);
      entry.granted = Math.min(wantTotal, ceiling);
      return entry.granted;
    },
    release(region: string, now: number): void {
      rollWindow(now);
      regions.delete(region);
    },
    stats(): RegionFairPoolStats {
      const snapshot: Array<{ region: string; weight: number; granted: number }> = [];
      let totalGranted = 0;
      for (const [name, r] of regions) {
        totalGranted += r.granted;
        snapshot.push({ region: name, weight: r.weight, granted: r.granted });
      }
      return { windowStart, limit: L, totalGranted, regions: snapshot };
    },
  };
}

// ─────────────────────────── per-region limiter (level 2) ──────────────────

/** Options for {@link federatedWeightedFairEscrow}. */
export interface FederatedWeightedFairEscrowOptions {
  /** This region's identity. */
  region: Region;
  /**
   * The shared cross-region {@link RegionFairPool} (the global budget authority). All regions drawing
   * from one global budget `L` MUST share one pool instance. `limit`/`windowMs`/`clock` come from it.
   */
  pool: RegionFairPool;
  /**
   * Per-tenant weight `w_{t,r}` as seen in this region. For a region-local tenant, return its global
   * weight `w_t`. For a tenant active in MULTIPLE regions, return the demand-proportional SPLIT
   * `w_t·d_{t,r}/d_t` (so `Σ_r w_{t,r} = w_t`) — full `w_t` in every region double-counts it. `> 0`.
   * Default `() => 1`.
   */
  weightOf?: (tenant: string) => number;
  /**
   * Bounded tenant set — caps the in-process per-tenant map (same role as `weightedFairEscrow.l1`).
   * Default unbounded; set on public surfaces above the expected tenant count.
   */
  l1?: { maxKeys?: number };
}

/** A point-in-time read of a federated WFE region's current window. */
export interface FederatedWeightedFairEscrowStats {
  readonly region: Region;
  readonly windowStart: number;
  /** Global budget `L`. */
  readonly limit: number;
  /** Budget the pool has granted THIS region this window (its `L_r`). */
  readonly regionBudget: number;
  /** This region's active aggregate weight `W_r = Σ wᵢ`. */
  readonly activeWeight: number;
  /** Total used across this region's tenants this window. */
  readonly totalUsed: number;
  readonly tenants: ReadonlyArray<{
    readonly tenant: string;
    readonly weight: number;
    readonly used: number;
  }>;
}

/** A federated weighted-fair-escrow limiter for one region. See {@link federatedWeightedFairEscrow}. */
export interface FederatedWeightedFairEscrowLimiter {
  /** Synchronous check (the in-process pool is sync). `cost` default 1. */
  checkSync(tenant: string, cost?: number): Decision;
  /** Promise form of {@link FederatedWeightedFairEscrowLimiter.checkSync}. */
  check(tenant: string, cost?: number): Promise<Decision>;
  /** Reset one tenant's in-region usage, or — with no argument — the whole region (releases it from the pool). */
  reset(tenant?: string): void;
  /** Read-only snapshot of this region's current window. */
  stats(): FederatedWeightedFairEscrowStats;
}

interface TenantEntry {
  weight: number;
  used: number;
}

/**
 * **Federated Weighted Fair Escrow** — per-region WFE composing (via a shared {@link RegionFairPool})
 * to a GLOBAL weighted-max-min guarantee. See the module doc for the composition theorem.
 */
export function federatedWeightedFairEscrow(
  options: FederatedWeightedFairEscrowOptions,
): FederatedWeightedFairEscrowLimiter {
  if (typeof options.region !== "string" || options.region.length === 0) {
    throw new TypeError("federatedWeightedFairEscrow: region must be a non-empty string");
  }
  const pool = options.pool;
  if (pool == null || typeof pool.grant !== "function") {
    throw new TypeError("federatedWeightedFairEscrow: pool must be a RegionFairPool");
  }
  const region = options.region;
  const L = pool.limit;
  const windowMs = pool.windowMs;
  const clock = pool.clock;
  const weightOf = options.weightOf ?? ((): number => 1);
  const maxKeys = options.l1?.maxKeys ?? Number.POSITIVE_INFINITY;

  let windowStart = Number.NEGATIVE_INFINITY;
  // `regionBudget` is this region's pool-granted budget L_r (grows via the pool, capped at L).
  let regionBudget = 0;
  // Credits served to tenants that were later EVICTED (`l1.maxKeys`). They were admitted, so they
  // must keep counting against the region budget — otherwise the freed `used` would let the region
  // re-lease and over-admit (the eviction would silently break `Σ used ≤ regionBudget`, hence Σ ≤ L).
  let evictedUsed = 0;
  const tenants = new Map<string, TenantEntry>();

  function rollWindow(now: number): void {
    if (now >= windowStart + windowMs) {
      windowStart = Math.floor(now / windowMs) * windowMs;
      regionBudget = 0;
      evictedUsed = 0;
      tenants.clear();
    }
  }

  function aggregate(): { totalWeight: number; totalUsed: number } {
    let totalWeight = 0;
    let totalUsed = evictedUsed; // evicted-tenant credits still count against the budget
    for (const t of tenants.values()) {
      totalWeight += t.weight;
      totalUsed += t.used;
    }
    return { totalWeight, totalUsed };
  }

  /** gᵢ = ⌊wᵢ·regionBudget/W⌋ — the tenant's guaranteed share of this region's pool-granted budget. */
  function guaranteedShare(weight: number, totalWeight: number): number {
    return totalWeight > 0 ? Math.floor((weight * regionBudget) / totalWeight) : 0;
  }

  /** In-region tenant fairness against `regionBudget`. Identical math to `weightedFairEscrow.decide`. */
  function decide(entry: TenantEntry, cost: number, now: number): Decision {
    const resetAt = Math.ceil(windowStart + windowMs);
    const { totalWeight, totalUsed } = aggregate();
    const gAsker = guaranteedShare(entry.weight, totalWeight);
    const lRemaining = regionBudget - totalUsed;

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
    let reserve = 0;
    for (const t of tenants.values()) {
      if (t === entry) continue;
      const gj = guaranteedShare(t.weight, totalWeight);
      reserve += Math.max(0, gj - t.used);
    }
    const borrowAvailable = Math.max(0, lRemaining - reserve);
    const wanted = entry.used + cost - gAsker;
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
      const oldestKey = tenants.keys().next();
      if (!oldestKey.done) {
        const evicted = tenants.get(oldestKey.value);
        if (evicted !== undefined) evictedUsed += evicted.used; // preserve the safety bound
        tenants.delete(oldestKey.value);
      }
    }
    const entry: TenantEntry = { weight: w, used: 0 };
    tenants.set(tenant, entry);
    return entry;
  }

  /** Non-mutating predicate: would {@link decide} admit `cost` for `entry` at the current budget? */
  function wouldAdmit(entry: TenantEntry, cost: number): boolean {
    const { totalWeight, totalUsed } = aggregate();
    const lRemaining = regionBudget - totalUsed;
    if (cost > lRemaining) return false;
    const gAsker = guaranteedShare(entry.weight, totalWeight);
    if (entry.used + cost <= gAsker) return true;
    let reserve = 0;
    for (const t of tenants.values()) {
      if (t === entry) continue;
      reserve += Math.max(0, guaranteedShare(t.weight, totalWeight) - t.used);
    }
    const borrowAvailable = Math.max(0, lRemaining - reserve);
    const grantable = Math.min(entry.used + cost - gAsker, cost, borrowAvailable, lRemaining);
    return entry.used + cost <= gAsker + grantable;
  }

  /**
   * Grow `regionBudget` from the pool until the asker would be admitted, or the pool caps the region
   * at its weighted-fair share. We must lease enough to cover the asker's `cost` ON TOP OF every other
   * tenant's reserved guarantee (`decide`'s borrow reserve) — not just `totalUsed + cost`, which
   * deadlocks a multi-tenant region (the asker's cost gets eaten by the co-tenant reserve, the request
   * is denied, `used` never advances, the next lease asks for the same amount → permanent stall). We
   * request only what the current backlog needs (bounded, not all of L), so regions still interleave
   * weight-fairly through the pool's reservation rather than the first one grabbing the whole budget.
   */
  function ensureRegionBudget(entry: TenantEntry, cost: number, now: number): void {
    for (let iter = 0; iter < MAX_LEASE_ITERS; iter++) {
      if (regionBudget >= L || wouldAdmit(entry, cost)) return;
      const { totalWeight, totalUsed } = aggregate();
      let reserveOthers = 0;
      for (const t of tenants.values()) {
        if (t === entry) continue;
        reserveOthers += Math.max(0, guaranteedShare(t.weight, totalWeight) - t.used);
      }
      const need = Math.min(L, totalUsed + reserveOthers + cost);
      const before = regionBudget;
      regionBudget = pool.grant(region, totalWeight, need, now);
      if (regionBudget <= before) return; // pool capped us at our weighted-fair share
    }
  }

  function validateInputs(tenant: string, cost: number): number {
    if (typeof tenant !== "string" || tenant.length === 0) {
      throw new TypeError("federatedWeightedFairEscrow: tenant must be a non-empty string");
    }
    requireCost(cost);
    const w = weightOf(tenant);
    requirePositive("federatedWeightedFairEscrow.weight", w);
    return w;
  }

  function checkSync(tenant: string, cost = 1): Decision {
    const w = validateInputs(tenant, cost);
    const now = clock.now();
    rollWindow(now);
    let entry = tenants.get(tenant);
    if (entry === undefined) entry = bootstrapTenant(tenant, w);
    else entry.weight = w;

    // Grow this region's pool-granted budget until it can admit (or the pool caps us at our
    // weighted-fair share). The region's weight is its CURRENT active aggregate tenant weight (the
    // GPS-decomposition condition that collapses the two-level hierarchy to a flat water-fill).
    ensureRegionBudget(entry, cost, now);
    return decide(entry, cost, now);
  }

  return {
    checkSync,
    async check(tenant: string, cost = 1): Promise<Decision> {
      return checkSync(tenant, cost);
    },
    reset(tenant?: string): void {
      if (tenant === undefined) {
        const now = clock.now();
        if (Number.isFinite(windowStart)) pool.release(region, now);
        windowStart = Number.NEGATIVE_INFINITY;
        regionBudget = 0;
        evictedUsed = 0;
        tenants.clear();
        return;
      }
      tenants.delete(tenant);
    },
    stats(): FederatedWeightedFairEscrowStats {
      const snapshot: Array<{ tenant: string; weight: number; used: number }> = [];
      let used = evictedUsed; // evicted-tenant credits are part of the region's consumption
      let weight = 0;
      for (const [k, t] of tenants) {
        used += t.used;
        weight += t.weight;
        snapshot.push({ tenant: k, weight: t.weight, used: t.used });
      }
      return {
        region,
        windowStart,
        limit: L,
        regionBudget,
        activeWeight: weight,
        totalUsed: used,
        tenants: snapshot,
      };
    },
  };
}
