import { systemClock } from "../core/clock";
import { ThrottleKitError } from "../core/errors";
import { prefixer } from "../core/key";
import { rateLimit } from "../core/limiter";
import { decisionTransform } from "../core/transform";
import type { Clock, Decision, Limiter, Store, Strategy } from "../core/types";
import { requireCost } from "../core/validate";
import { leaseSizer } from "./sizing";
import type { LeaseSizer, LeaseSizerOptions } from "./sizing";

export { eoqOptimum, leaseSizer, predictiveLeaseSizer } from "./sizing";
export type {
  LeaseSizer,
  LeaseSizerOptions,
  PredictiveLeaseSizer,
  PredictiveLeaseSizerOptions,
} from "./sizing";

/**
 * GALE Pillar 4 graduation — `weightedFairEscrow(...)` ships in 0.9.1 (TK-1310). The L1-only
 * single-process path is here; the multi-process L2 backing arrives in the next commit. See
 * `research/bigger-bets/pillar4-wfe/DESIGN.md` for the full design lock.
 */
export { weightedFairEscrow } from "./weighted-fair-escrow";
export type {
  WeightedFairEscrowLimiter,
  WeightedFairEscrowOptions,
  WeightedFairEscrowStats,
} from "./weighted-fair-escrow";

/**
 * Federated WFE (TK-1404, #176) — Pillar 4 lifted across regions: per-region tenant WFE composed
 * (via a shared cross-region `regionFairPool` — a WFE over regions) into a GLOBAL weighted-max-min
 * guarantee. Design + composition theorem (T-FED-1..3): `research/gale/PILLAR4-fairness.md`.
 */
export {
  federatedWeightedFairEscrow,
  isAsyncRegionFairPool,
  regionFairPool,
  testRegionFairPool,
} from "./federated-weighted-fair-escrow";
export type {
  AsyncRegionFairPool,
  FederatedWeightedFairEscrowLimiter,
  FederatedWeightedFairEscrowOptions,
  FederatedWeightedFairEscrowStats,
  RegionFairPool,
  RegionFairPoolOptions,
  RegionFairPoolStats,
} from "./federated-weighted-fair-escrow";

/**
 * `RedisRegionFairPool` (DR-FWFE-1) — the production store-backed {@link AsyncRegionFairPool}: the
 * cross-region weighted-fair pool with its state in a shared Redis hash, so separate region processes
 * draw from ONE global budget. The grant runs the in-process pool's exact arithmetic, atomically in Lua.
 */
export { RedisRegionFairPool } from "./redis-region-fair-pool";
export type { RedisRegionFairPoolOptions } from "./redis-region-fair-pool";

/**
 * `LeaseSpender` (Tier-2 fleet leasing) — the client-side, window-coupled spend of a leased budget: a
 * verbatim port of the `twoTier(leased, windowCoupled)` L1 path. A high-throughput polyglot client leases
 * a chunk of a global budget over the service's `Fleet.Reserve` door and serves it locally (one round trip
 * per refresh, not per request); this synthesizes the allow while the service stays the *one oracle* for
 * the grant size. Pinned by the golden lease vectors (`wire/vectors`).
 */
export { LeaseSpender } from "./lease-spender";
export type {
  LeaseDenied,
  LeaseGrant,
  LeaseSpend,
  LeaseSpenderOptions,
  ReserveFn,
  ReserveResult,
} from "./lease-spender";

/** L1/L2 coordination mode. See docs and THROTTLEKIT.md §8. */
export type TwoTierMode = "strict" | "cached-deny" | "leased";

export interface LeaseOptions {
  /**
   * Tokens leased from L2 per refill. Larger batch ⇒ fewer round trips, larger overshoot bound.
   * Required unless {@link LeaseOptions.adaptive} is set — with adaptive sizing this is an optional
   * per-key warm-start size; the online learner takes over from there.
   */
  batch?: number;
  /**
   * When the local budget is at or below this level, refill asynchronously (so requests never
   * block on the network). Default 0, which disables proactive refill — purely lease-on-demand,
   * giving the tightest overshoot bound (≤ L×batch). Set > 0 to hide lease latency at the cost of
   * a looser bound (≤ L×(batch+lowWater)).
   */
  lowWater?: number;
  /** Drop a key's idle local credits after this many ms. Capacity self-heals via L2 refill. */
  returnIdleAfterMs?: number;
  /**
   * Couple leased-credit lifetime to the L2 window: when the L2 window that granted a key's local
   * credits has rolled over (i.e. `now >= the lease's resetAt`), discard those credits instead of
   * carrying them across the boundary. Cross-window carryover is the *sole* source of leased
   * overshoot, so this tightens the global per-window bound from `Limit + L×(batch−1)` to exactly
   * `Limit` — independent of the node count `L` — at the cost of one re-lease per node just after
   * each boundary. Intended for a fixed-window L2 strategy (the case the bound is proven for, in
   * `spec/GaleWindowCoupledLeasing.tla`). Default false (credits carry over — the legacy behaviour).
   */
  windowCoupled?: boolean;
  /**
   * **Adaptive (online) lease sizing — GALE Pillar 2.** Instead of a fixed {@link LeaseOptions.batch},
   * size each key's batch online with a {@link leaseSizer}: every L2 window the limiter feeds the
   * learner the demand that key actually served and reads back the batch for the next window, descending
   * onto the EOQ optimum `√(2·orderCost·demand/strandPenalty)` and tracking drift. One independent
   * learner per key (cold keys evict with their entry — bound them with {@link L1Options.maxKeys}).
   *
   * Pass {@link LeaseSizerOptions} (the limiter builds a `leaseSizer` per key) or a `() => LeaseSizer`
   * factory for a custom per-key learner. Safety is untouched: by Pillar 1 the per-window global bound
   * holds for *any* batch the learner emits (exactly `Limit` under {@link LeaseOptions.windowCoupled}),
   * so adaptive sizing only trades coordination against stranding — it can never loosen the cap.
   */
  adaptive?: LeaseSizerOptions | (() => LeaseSizer);
}

export interface L1Options {
  /**
   * Max distinct keys held locally before approximate (CLOCK-style) eviction. **Unbounded when
   * omitted** — set this on public-facing endpoints so a flood of unique keys can't grow the local
   * `credits`/`lastDecision`/`lastUse` maps without limit (the same stance as `MemoryStore`'s
   * `maxKeys`). The `cached-deny` deny-cache is bounded by the same value.
   */
  maxKeys?: number;
}

export interface TwoTierOptions<S = unknown> {
  /** The algorithm enforced at L2 (and, for leasing, the unit of the leased budget). */
  strategy: Strategy<S>;
  /** The distributed store (e.g. RedisStore). */
  l2: Store;
  /** Coordination mode. */
  mode: TwoTierMode;
  /** Required for `leased` mode. */
  lease?: LeaseOptions;
  /** Local-tier tuning. */
  l1?: L1Options;
  /** Injected clock. */
  clock?: Clock;
  /** Key namespace. */
  prefix?: string;
}

function noSync(): Decision {
  throw new ThrottleKitError(
    "two-tier checkSync is not supported because L2 access is asynchronous; use check()",
  );
}

function noSyncMany(): Decision[] {
  throw new ThrottleKitError(
    "two-tier checkManySync is not supported because L2 access is asynchronous; use checkMany()",
  );
}

/**
 * All per-key L1 state for `leased` mode in one record, so a local hit hashes the key once instead
 * of probing five parallel maps (credits / lastDecision / lastUse / refilling / pendingLease).
 */
interface LeaseEntry {
  /** Local leased credits available to spend without a round trip. */
  credits: number;
  /** The most recent L2 decision (for `resetAt` and windowCoupled expiry). */
  lastDecision: Decision | undefined;
  /** Epoch-ms of the last check (drives `returnIdleAfterMs` reclamation). */
  lastUse: number;
  /** A proactive (lowWater) refill is in flight. */
  refilling: boolean;
  /** An on-demand lease is in flight — concurrent misses await it instead of issuing their own. */
  pending: Promise<Decision> | undefined;
  /** Per-key adaptive sizer (GALE Pillar 2), or undefined when `lease.adaptive` isn't set. */
  sizer: LeaseSizer | undefined;
  /** Credits this key actually served in the window being accumulated — the learner's demand signal. */
  windowDemand: number;
  /** `resetAt` of the window `windowDemand` accumulates for; undefined until the first lease arms it. */
  windowEnd: number | undefined;
}

/**
 * A two-tier limiter: a local in-process tier (L1) fronting a distributed tier (L2), with a
 * selectable consistency/throughput trade-off.
 *
 * - `strict`: every check consults L2 (exact, 1 round trip / request).
 * - `cached-deny`: denials are cached locally for their `retryAfterMs`, so an abusive client can't
 *   translate a flood into L2 load; allowed traffic stays globally exact.
 * - `leased`: each node leases a batch of tokens from L2 and serves them locally, driving
 *   steady-state network cost toward ~1 round trip per `batch` requests, with a bounded global
 *   overshoot (≤ L×batch with the default `lowWater: 0`).
 */
export function twoTier<S = unknown>(options: TwoTierOptions<S>): Limiter {
  const { strategy, l2, mode } = options;
  const clock = options.clock ?? systemClock;
  const prefix = options.prefix;
  const keyFor = prefixer(prefix);

  if (mode === "strict") {
    return rateLimit<S>({
      strategy,
      store: l2,
      clock,
      ...(prefix !== undefined ? { prefix } : {}),
    });
  }

  const maxKeys = options.l1?.maxKeys ?? Number.POSITIVE_INFINITY;

  if (mode === "cached-deny") {
    const denyUntil = new Map<string, { until: number; decision: Decision }>();
    const evict = (): void => {
      if (denyUntil.size >= maxKeys) {
        const oldest = denyUntil.keys().next();
        if (!oldest.done) denyUntil.delete(oldest.value);
      }
    };
    const check = async (key: string, cost = 1): Promise<Decision> => {
      requireCost(cost);
      const fk = keyFor(key);
      const now = clock.now();
      const cached = denyUntil.get(fk);
      if (cached !== undefined && now < cached.until) {
        // Serve the denial locally — no L2 round trip for an already-blocked key.
        return {
          allowed: false,
          limit: cached.decision.limit,
          remaining: 0,
          resetAt: cached.decision.resetAt,
          retryAfterMs: Math.ceil(cached.until - now),
        };
      }
      if (cached !== undefined) denyUntil.delete(fk);
      const d = await l2.apply(fk, decisionTransform(strategy, now, cost));
      if (!d.allowed) {
        evict();
        denyUntil.set(fk, { until: now + d.retryAfterMs, decision: d });
      }
      return d;
    };
    return {
      strategy: strategy as Strategy<unknown>,
      check,
      checkSync: noSync,
      checkMany: (keys: readonly string[], cost = 1): Promise<Decision[]> =>
        Promise.all(keys.map((k) => check(k, cost))),
      checkManySync: noSyncMany,
      async reset(key: string): Promise<void> {
        const fk = keyFor(key);
        denyUntil.delete(fk);
        await l2.reset(fk);
      },
    };
  }

  // leased
  const lease = options.lease;
  if (lease === undefined) {
    throw new ThrottleKitError("leased mode requires `lease.batch` (or `lease.adaptive`)");
  }
  const adaptive = lease.adaptive;
  let makeSizer: (() => LeaseSizer) | undefined;
  if (adaptive === undefined) {
    makeSizer = undefined;
  } else if (typeof adaptive === "function") {
    makeSizer = adaptive;
  } else {
    // Fail fast on invalid EOQ params: construct one now to validate, then mint a fresh, independent
    // learner per key (shared read-only options, separate state).
    const sizerOptions: LeaseSizerOptions = {
      ...(lease.batch !== undefined ? { initialSize: lease.batch } : {}),
      ...adaptive,
    };
    leaseSizer(sizerOptions);
    makeSizer = () => leaseSizer(sizerOptions);
  }
  const batch = lease.batch;
  if (makeSizer === undefined) {
    if (batch === undefined) {
      throw new ThrottleKitError("leased mode requires `lease.batch` (or `lease.adaptive`)");
    }
    if (!Number.isFinite(batch) || batch < 1) {
      throw new RangeError(`lease.batch must be a finite number >= 1, got ${String(batch)}`);
    }
  } else if (batch !== undefined && (!Number.isFinite(batch) || batch < 1)) {
    throw new RangeError(
      `lease.batch (adaptive warm-start) must be a finite number >= 1, got ${String(batch)}`,
    );
  }
  const lowWater = lease.lowWater ?? 0;
  const returnIdleAfterMs = lease.returnIdleAfterMs;
  const windowCoupled = lease.windowCoupled ?? false;

  const entries = new Map<string, LeaseEntry>();

  const forget = (fk: string): void => {
    entries.delete(fk);
  };
  /** Fetch (or create) the one record for `fk`, bounding the map before adding a new key. */
  const entryFor = (fk: string): LeaseEntry => {
    let e = entries.get(fk);
    if (e === undefined) {
      if (entries.size >= maxKeys) {
        const oldest = entries.keys().next(); // approximate FIFO eviction of the oldest key
        if (!oldest.done) entries.delete(oldest.value);
      }
      e = {
        credits: 0,
        lastDecision: undefined,
        lastUse: 0,
        refilling: false,
        pending: undefined,
        sizer: makeSizer?.(),
        windowDemand: 0,
        windowEnd: undefined,
      };
      entries.set(fk, e);
    }
    return e;
  };

  /** The lease size for one refill: the per-key learner's current size if adaptive, else `batch`. */
  const leaseSizeFor = (e: LeaseEntry): number =>
    e.sizer !== undefined ? Math.max(1, e.sizer.size()) : (batch as number);

  const synthAllow = (e: LeaseEntry, now: number): Decision => ({
    allowed: true,
    limit: strategy.limit,
    remaining: Math.max(0, Math.floor(e.credits)),
    resetAt: e.lastDecision?.resetAt ?? now + strategy.ttlMs,
    retryAfterMs: 0,
  });

  const maybeRefill = (fk: string, e: LeaseEntry): void => {
    if (lowWater <= 0) return; // proactive refill is opt-in
    if (e.credits > lowWater) return;
    if (e.refilling) return;
    e.refilling = true;
    const amt = leaseSizeFor(e);
    // Fire-and-forget: requests never block on a refill. Re-fetch by key in the callbacks in case
    // the entry was evicted/reclaimed while the refill was in flight.
    l2.apply(fk, decisionTransform(strategy, clock.now(), amt))
      .then((d) => {
        const t = entries.get(fk);
        if (t !== undefined) {
          // Under windowCoupled, a proactive refill leased just before a boundary can land after the
          // window has rolled. Crediting it would smuggle a past window's budget across the boundary,
          // and clobbering lastDecision with this stale (rolled) decision would blind the discard at
          // check() entry to it — so drop the late grant (mirrors the `now >= resetAt` discard above).
          if (windowCoupled && clock.now() >= d.resetAt) return;
          t.lastDecision = d;
          if (d.allowed) {
            t.credits += amt;
            if (t.sizer !== undefined && t.windowEnd === undefined) t.windowEnd = d.resetAt;
          }
        }
      })
      .catch(() => {
        /* leave credits as-is; the next check leases synchronously */
      })
      .finally(() => {
        const t = entries.get(fk);
        if (t !== undefined) t.refilling = false;
      });
  };

  let idleTimer: ReturnType<typeof setInterval> | undefined;
  if (returnIdleAfterMs !== undefined && returnIdleAfterMs > 0) {
    idleTimer = setInterval(() => {
      const now = clock.now();
      for (const [k, e] of entries) {
        if (now - e.lastUse > returnIdleAfterMs) forget(k);
      }
    }, returnIdleAfterMs);
    (idleTimer as { unref?(): void }).unref?.();
  }

  const check = async (key: string, cost = 1): Promise<Decision> => {
    requireCost(cost);
    const fk = keyFor(key);
    const now = clock.now();
    let e = entryFor(fk);
    e.lastUse = now;

    // Adaptive sizing: once the window this key was accumulating demand for has rolled, feed the
    // learner that window's served demand and let it resize the batch for subsequent windows.
    if (e.sizer !== undefined && e.windowEnd !== undefined && now >= e.windowEnd) {
      e.sizer.observe(e.windowDemand);
      e.windowDemand = 0;
      e.windowEnd = undefined;
    }

    if (windowCoupled && e.lastDecision !== undefined) {
      // Once the L2 window that granted these credits has rolled over, they expire rather than
      // carrying across the boundary — removing the sole source of cross-window overshoot.
      if (now >= e.lastDecision.resetAt && e.credits > 0) e.credits = 0;
    }

    // Serve from local credits; when short, lease a batch from L2 — coalescing concurrent misses on
    // the same key onto ONE in-flight lease (the shared `e.pending`), so a node never holds more than
    // `batch` outstanding (the overshoot-bound assumption) and a hot cold key can't stampede L2.
    for (;;) {
      if (e.credits >= cost) {
        e.credits -= cost;
        if (e.sizer !== undefined) e.windowDemand += cost;
        maybeRefill(fk, e);
        return synthAllow(e, now);
      }

      let lease = e.pending;
      if (lease === undefined) {
        const leaseAmount = Math.max(leaseSizeFor(e), cost);
        lease = l2.apply(fk, decisionTransform(strategy, clock.now(), leaseAmount)).then((d) => {
          const t = entries.get(fk);
          if (t !== undefined) {
            t.lastDecision = d;
            if (d.allowed) {
              t.credits += leaseAmount;
              if (t.sizer !== undefined && t.windowEnd === undefined) t.windowEnd = d.resetAt;
            }
          }
          return d;
        });
        e.pending = lease;
        // Free the slot once settled so the next shortage starts a fresh lease. The separate
        // `.catch` keeps a rejected lease from going unhandled here; the awaiter still observes it.
        const settled = lease;
        void settled
          .catch(() => undefined)
          .finally(() => {
            const t = entries.get(fk);
            if (t !== undefined && t.pending === settled) t.pending = undefined;
          });
      }

      const d = await lease;
      // The entry may have been evicted+recreated across the await; re-fetch the live one.
      e = entries.get(fk) ?? entryFor(fk);
      // L2 globally exhausted and still nothing to serve locally ⇒ surface its denial.
      if (!d.allowed && e.credits < cost) return d;
      // Otherwise loop: the lease added a batch, so this request now fits (or we lease again).
    }
  };
  return {
    strategy: strategy as Strategy<unknown>,
    check,
    checkSync: noSync,
    checkMany: (keys: readonly string[], cost = 1): Promise<Decision[]> =>
      Promise.all(keys.map((k) => check(k, cost))),
    checkManySync: noSyncMany,
    async reset(key: string): Promise<void> {
      const fk = keyFor(key);
      forget(fk);
      await l2.reset(fk);
    },

    async close(): Promise<void> {
      // Release the idle-return timer this limiter owns. The L2 store was provided by the caller, so
      // it is theirs to close — we never close it here.
      if (idleTimer !== undefined) {
        clearInterval(idleTimer);
        idleTimer = undefined;
      }
    },
  };
}
