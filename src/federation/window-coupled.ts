/**
 * Window-coupled federated leasing — the headline contribution of bet #77.
 *
 * Implements the formal model from `spec/GaleFederatedLeasing.tla` and the
 * full check path of `research/bigger-bets/federation/DESIGN.md` §3.2:
 * each region holds an in-process escrow lease drawn from a global
 * coordinator; the escrow expires at the window boundary; uncommitted
 * escrow forfeits and reconciles back to the coordinator.
 *
 * Proves (under the formal model):
 *   admitted_per_global_window  ≤  Limit       (Δ = 0, independent of K)
 *
 * Composition surfaces:
 * - `federate(...)` → returns a `Limiter` (parallel to `rateLimit` / `twoTier`).
 * - The same engine backs `FederatedStore.apply()` so users who prefer the
 *   Store contract (for layering inside `twoTier(leased)` or any other
 *   `Store`-consuming code) get identical semantics.
 *
 * Multi-process atomicity (TK-1306, 0.8.5): when a {@link RegionalEscrow} is
 * provided, the engine routes leases through it as an L2 cache between the
 * in-process L1 and the coordinator (L3). Multiple processes in the same
 * region share the L2 escrow atomically, bounding in-flight per-region
 * escrow by `perKeyBudget` rather than `M × batch`. When `regionalEscrow` is
 * undefined, the engine uses the legacy 0.8.4 in-process-only flow
 * (backward-compat).
 *
 * Scope at this commit (TK-1306):
 * - Strategies with `windowMs` defined (`fixedWindow`, `slidingWindow`,
 *   `quota` with fixed cadence). Pure-rate strategies (gcra/tokenBucket)
 *   aren't supported here because the window-coupling rule needs a
 *   discrete window boundary.
 * - Lazy reconcile: when the next request after a window boundary lands,
 *   we reconcile the prior window's leftover (best-effort; failure cannot
 *   violate the bound — only forfeits next window's would-be capacity).
 */

import { systemClock } from "../core/clock";
import { ThrottleKitError } from "../core/errors";
import { prefixer } from "../core/key";
import type { Clock, Decision, Limiter, Store, Strategy } from "../core/types";
import { requireCost } from "../core/validate";
import type { CoordinatorOutageMode, GlobalCoordinator, Region, RegionalEscrow } from "./types";

/** Default escrow lease size — see DESIGN.md §3.2 / §6.3. */
const DEFAULT_BATCH = 16;

export interface FederateOptions<S = unknown> {
  /**
   * The federated strategy — its `limit` defines the global per-window
   * budget; its `windowMs` defines the window boundary the escrow couples
   * to. The strategy MUST have `windowMs` defined; pure-rate strategies
   * (gcra, tokenBucket) are unsupported at this commit (DESIGN.md §4.3).
   */
  strategy: Strategy<S>;
  /** Cross-region lease coordinator (the "L3"). */
  coordinator: GlobalCoordinator;
  /** This region's identity — used in coordinator keys + telemetry. */
  region: Region;
  /**
   * Escrow lease size per global window per region. Default 16. Larger
   * batch = fewer cross-region RTTs at the cost of `(batch - 1) * (K - 1)`
   * worst-case unused capacity under skew. Under federated window-coupling
   * that unused capacity does NOT contribute to overshoot (Δ = 0) — it is
   * purely a utilization concern (DESIGN.md §6).
   */
  batch?: number;
  /**
   * Soft-deprecated as of 0.8.5: kept accepted for backward compat with the
   * 0.8.3+ `FederatedStore` API which used it for `reset()` plumbing, but
   * the engine no longer consults this field. Pass {@link regionalEscrow}
   * instead for the new multi-process per-region escrow path (TK-1306).
   */
  regional?: Store;
  /**
   * Regional escrow (L2) for multi-process per-region atomicity (TK-1306,
   * 0.8.5). When provided, the engine routes leases through this layer
   * between the in-process L1 and the coordinator (L3) — multiple
   * processes in the same region share it atomically, bounding in-flight
   * per-region escrow by `perKeyBudget` instead of `M × batch`.
   *
   * Also enables the `"regional-only"` outage mode: when the coordinator
   * is unreachable, the engine continues serving from the L2 balance until
   * depleted (availability-over-precision opt-in).
   *
   * When undefined, the engine uses in-process escrow only (legacy 0.8.4
   * behavior, fully backward-compatible).
   *
   * See {@link RegionalEscrow} and `research/regional-escrow/DESIGN.md`.
   */
  regionalEscrow?: RegionalEscrow;
  /**
   * Behavior when `coordinator.lease()` throws. Default `"fail-closed"`
   * (safety > availability). `"regional-only"` (TK-1306, 0.8.5) requires
   * a {@link regionalEscrow} — the engine continues serving from the L2
   * balance during the outage; once coordinator recovers, normal lease
   * + reconcile resumes.
   */
  onCoordinatorOutage?: CoordinatorOutageMode;
  /** Injected clock for deterministic tests. Defaults to {@link systemClock}. */
  clock?: Clock;
  /** Key namespace. */
  prefix?: string;
}

/** Per-key in-process state. */
interface Entry {
  /** Escrow units this region holds in the current window. */
  balance: number;
  /** Epoch-ms of the start of the window `balance` belongs to. */
  windowStart: number;
  /** Epoch-ms when the current window ends; balance expires at this instant (window-coupling). */
  windowExpiresAt: number;
  /**
   * In-flight coordinator lease promise; concurrent shortages on the same
   * key await this rather than issuing a parallel lease (the safety
   * coalescing — at most one outstanding lease per region per key).
   */
  pending: Promise<number> | undefined;
  /**
   * The windowStart of the most recent successful reconcile, so we don't
   * double-reconcile the same boundary (idempotence on `windowStart`).
   */
  lastReconciledWindowStart: number;
}

/**
 * The shared federation engine. Both {@link federate} and
 * `FederatedStore.apply()` route through this so their semantics are
 * bit-identical.
 *
 * Exported so {@link FederatedStore} can share its instance internally;
 * not part of the public surface (the public surface is `federate(...)`).
 *
 * @internal
 */
export interface FederationEngine {
  check(key: string, cost?: number): Promise<Decision>;
  reset(key: string): Promise<void>;
  close(): Promise<void>;
  /**
   * Test-only: snapshot the in-process escrow for `key`. Returns
   * `undefined` if the key has never been checked. Use the prefixed form
   * (i.e. what `prefixer(prefix)(rawKey)` returns).
   */
  peekEntry(prefixedKey: string): { balance: number; windowExpiresAt: number } | undefined;
}

const CHECK_SYNC_ERR =
  "federation cannot run sync: the global coordinator is intrinsically async (cross-region RTT). Use check() / checkMany().";

/**
 * Construct the federation engine. Exported so {@link FederatedStore} can
 * share an instance; the user-facing entry point is {@link federate}.
 *
 * @internal
 */
export function createFederationEngine<S>(options: FederateOptions<S>): FederationEngine {
  const { strategy, coordinator, region: _region } = options;
  const clock = options.clock ?? systemClock;
  const batch = options.batch ?? DEFAULT_BATCH;
  const onOutage = options.onCoordinatorOutage ?? "fail-closed";
  const keyFor = prefixer(options.prefix);
  const regionalEscrow = options.regionalEscrow;

  if (strategy.windowMs === undefined) {
    throw new RangeError(
      `federate: strategy.windowMs must be defined (got strategy.name="${strategy.name}"). Federation requires a windowed strategy (fixedWindow, slidingWindow, quota); pure-rate strategies (gcra, tokenBucket) are unsupported at this commit (DESIGN.md §4.3).`,
    );
  }
  if (!Number.isFinite(batch) || batch < 1) {
    throw new RangeError(`batch must be a finite number >= 1, got ${String(batch)}`);
  }

  const windowMs = strategy.windowMs;
  const entries = new Map<string, Entry>();

  /** The epoch-aligned window boundary that includes `now` (so windowStart ≤ now < expiresAt). */
  function windowFor(now: number): { start: number; expiresAt: number } {
    const start = Math.floor(now / windowMs) * windowMs;
    return { start, expiresAt: start + windowMs };
  }

  /** Get-or-create an entry, advancing it to the current window if needed. */
  function advance(key: string, now: number): Entry {
    let e = entries.get(key);
    const { start, expiresAt } = windowFor(now);

    if (e === undefined) {
      e = {
        balance: 0,
        windowStart: start,
        windowExpiresAt: expiresAt,
        pending: undefined,
        lastReconciledWindowStart: -1,
      };
      entries.set(key, e);
      return e;
    }

    // Window-coupling: if the prior window expired, reconcile leftover then reset.
    if (now >= e.windowExpiresAt) {
      const oldStart = e.windowStart;
      const leftover = e.balance;
      e.balance = 0;
      e.windowStart = start;
      e.windowExpiresAt = expiresAt;
      // Drop any pending lease from the prior window — it would credit the wrong window.
      e.pending = undefined;

      if (e.lastReconciledWindowStart !== oldStart) {
        e.lastReconciledWindowStart = oldStart;
        if (regionalEscrow !== undefined) {
          // Multi-process path: capture L2 leftover (first releaser wins) and add this
          // process's L1 leftover, then reconcile the union up to L3. For M=1 this is
          // identical to the 0.8.4 path (all leftover recovered). For M>1, processes
          // other than the L2-release winner lose their L1 leftover — documented
          // utilization cost (the federation bound Δ = 0 is preserved either way).
          void (async () => {
            try {
              const l2Leftover = await regionalEscrow.release(key, oldStart);
              const total = leftover + l2Leftover;
              if (total > 0) await coordinator.reconcile(key, total, oldStart);
            } catch {
              // Best-effort; swallow.
            }
          })();
        } else if (leftover > 0) {
          // Single-process path: reconcile L1 leftover directly (existing 0.8.4 behavior).
          // A reconcile failure cannot violate the safety bound; at worst we lose the
          // leftover capacity next window (DESIGN.md §3.1 / §5).
          void coordinator.reconcile(key, leftover, oldStart).catch(() => undefined);
        }
      }
    }
    return e;
  }

  function denied(now: number, expiresAt: number, currentBalance: number): Decision {
    const wait = Math.max(1, expiresAt - now);
    return {
      allowed: false,
      limit: strategy.limit,
      remaining: currentBalance,
      resetAt: expiresAt,
      retryAfterMs: wait,
    };
  }

  async function check(rawKey: string, cost = 1): Promise<Decision> {
    requireCost(cost);
    const key = keyFor(rawKey);
    const now = clock.now();
    let e = advance(key, now);

    // Lease until balance >= cost or coordinator denies.
    while (e.balance < cost) {
      // L2 fast path: try regional escrow before reaching the coordinator.
      // Skip on a regional-store outage (caught below); the engine then falls
      // through to L3, matching the legacy 0.8.4 path for that window.
      if (regionalEscrow !== undefined) {
        const wanted = Math.max(batch, cost) - e.balance;
        if (wanted > 0) {
          let l2Granted = 0;
          try {
            l2Granted = await regionalEscrow.lease(key, wanted);
          } catch {
            // Regional L2 unavailable — fall through to L3 lease for this round.
          }
          // Re-resolve entry after await (window may have rolled, or reset() ran).
          const current = entries.get(key);
          if (current === undefined) return check(rawKey, cost);
          e = current;
          if (l2Granted > 0) {
            e.balance += l2Granted;
            continue;
          }
        }
      }

      // L2 empty or unavailable: lease from coordinator (L3). Refill L2 from the grant
      // so other processes share it; then immediately lease our share back from L2.
      let lease = e.pending;
      if (lease === undefined) {
        const windowStart = e.windowStart;
        const expiresAt = e.windowExpiresAt;
        const tokens = Math.max(batch, cost);
        lease = (async (): Promise<number> => {
          let granted: number;
          try {
            granted = await coordinator.lease(key, tokens, expiresAt);
          } catch {
            // Coordinator outage: per onOutage mode. Both "fail-closed" and
            // "regional-only" return 0 here at Phase B; the L2 fast-path
            // above keeps serving during outage for both modes. Phase 3
            // (TK-1306c) adds the health-recheck loop that distinguishes
            // the two — regional-only resumes coord.lease on recovery;
            // fail-closed never gates on outage state.
            if (onOutage === "fail-closed" || onOutage === "regional-only") return 0;
            return 0;
          }
          if (granted <= 0) return 0;

          if (regionalEscrow !== undefined) {
            try {
              // Push the grant to L2 (additive) and immediately lease our share back.
              await regionalEscrow.refill(key, granted, windowStart);
              return await regionalEscrow.lease(key, tokens);
            } catch {
              // L2 unavailable during refill: degrade to L1-only for this grant
              // (matches 0.8.4 behavior; the federation bound is still preserved
              // because the grant is already counted against the coordinator).
              return granted;
            }
          }
          return granted;
        })();
        e.pending = lease;
      }

      const grant = await lease;

      // After await, the entry may have rolled to a new window; re-resolve.
      const current = entries.get(key);
      if (current === undefined) {
        // Reset happened concurrently — start over.
        return check(rawKey, cost);
      }
      e = current;
      // Clear the pending iff it's still the same promise (concurrent callers may have replaced it).
      if (e.pending === lease) e.pending = undefined;

      if (grant > 0) {
        e.balance += grant;
        continue;
      }
      // Coordinator denied AND L2 empty — global budget is exhausted for this window.
      return denied(now, e.windowExpiresAt, e.balance);
    }

    // We have enough escrow to admit.
    e.balance -= cost;
    return {
      allowed: true,
      limit: strategy.limit,
      remaining: e.balance,
      resetAt: e.windowExpiresAt,
      retryAfterMs: 0,
    };
  }

  async function reset(rawKey: string): Promise<void> {
    const key = keyFor(rawKey);
    entries.delete(key);
  }

  async function close(): Promise<void> {
    entries.clear();
  }

  function peekEntry(
    prefixedKey: string,
  ): { balance: number; windowExpiresAt: number } | undefined {
    const e = entries.get(prefixedKey);
    if (e === undefined) return undefined;
    return { balance: e.balance, windowExpiresAt: e.windowExpiresAt };
  }

  return { check, reset, close, peekEntry };
}

/**
 * Create a federated Limiter that shares its global budget across regions
 * via a {@link GlobalCoordinator}. Parallel to {@link rateLimit} and
 * {@link twoTier} — the cross-region analog.
 *
 * Quick start:
 *
 *     import { fixedWindow } from "throttlekit";
 *     import { federate, TestCoordinator } from "throttlekit/federation";
 *
 *     const coordinator = new TestCoordinator({ budgetPerWindow: 1000 });
 *     const limiter = federate({
 *       strategy: fixedWindow({ limit: 1000, windowMs: 60_000 }),
 *       coordinator,
 *       region: "us-east",
 *       batch: 16,
 *     });
 *     const decision = await limiter.check("user:42");
 *
 * For multi-process regions, compose with twoTier(leased) — the
 * recursive twoTier pattern (DESIGN.md §2.2):
 *
 *     const federated = federate({ ... });  // returns Limiter, not Store
 *     // For now (TK-904), wrap in twoTier yourself only if you need per-process
 *     // in-memory L1 caching on top of federation; the Store-shape composition
 *     // lands fully in TK-906 with RedisCoordinator.
 */
export function federate<S = unknown>(options: FederateOptions<S>): Limiter {
  const engine = createFederationEngine(options);
  const strategy = options.strategy as Strategy<unknown>;

  const noSync = (): never => {
    throw new ThrottleKitError(CHECK_SYNC_ERR);
  };

  return {
    strategy,
    check: (key: string, cost = 1) => engine.check(key, cost),
    checkSync: noSync,
    checkMany: (keys, cost = 1) => Promise.all(keys.map((k) => engine.check(k, cost))),
    checkManySync: noSync,
    reset: (key) => engine.reset(key),
    close: () => engine.close(),
  };
}
