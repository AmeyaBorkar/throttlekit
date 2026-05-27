import { systemClock } from "../core/clock";
import { ThrottleKitError } from "../core/errors";
import { rateLimit } from "../core/limiter";
import { decisionTransform } from "../core/transform";
import type { Clock, Decision, Limiter, Store, Strategy } from "../core/types";

export { eoqOptimum, leaseSizer, predictiveLeaseSizer } from "./sizing";
export type {
  LeaseSizer,
  LeaseSizerOptions,
  PredictiveLeaseSizer,
  PredictiveLeaseSizerOptions,
} from "./sizing";

/** L1/L2 coordination mode. See docs and THROTTLEKIT.md §8. */
export type TwoTierMode = "strict" | "cached-deny" | "leased";

export interface LeaseOptions {
  /** Tokens leased from L2 per refill. Larger batch ⇒ fewer round trips, larger overshoot bound. */
  batch: number;
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
}

export interface L1Options {
  /** Max distinct keys held locally before approximate eviction. */
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

function validateCost(cost: number): void {
  if (!Number.isFinite(cost) || cost <= 0) {
    throw new RangeError(`cost must be a positive finite number, got ${String(cost)}`);
  }
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
  const keyFor =
    prefix !== undefined && prefix.length > 0
      ? (k: string): string => `${prefix}:${k}`
      : (k: string): string => k;

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
      validateCost(cost);
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
    throw new ThrottleKitError("leased mode requires `lease.batch`");
  }
  const batch = lease.batch;
  if (!Number.isFinite(batch) || batch < 1) {
    throw new RangeError(`lease.batch must be a finite number >= 1, got ${String(batch)}`);
  }
  const lowWater = lease.lowWater ?? 0;
  const returnIdleAfterMs = lease.returnIdleAfterMs;
  const windowCoupled = lease.windowCoupled ?? false;

  const credits = new Map<string, number>();
  const lastDecision = new Map<string, Decision>();
  const lastUse = new Map<string, number>();
  const refilling = new Set<string>();

  const forget = (fk: string): void => {
    credits.delete(fk);
    lastDecision.delete(fk);
    lastUse.delete(fk);
  };
  const evictCredits = (): void => {
    if (credits.size >= maxKeys) {
      const oldest = credits.keys().next();
      if (!oldest.done) forget(oldest.value);
    }
  };

  const synthAllow = (fk: string, now: number): Decision => {
    const last = lastDecision.get(fk);
    return {
      allowed: true,
      limit: strategy.limit,
      remaining: Math.max(0, Math.floor(credits.get(fk) ?? 0)),
      resetAt: last?.resetAt ?? now + strategy.ttlMs,
      retryAfterMs: 0,
    };
  };

  const maybeRefill = (fk: string): void => {
    if (lowWater <= 0) return; // proactive refill is opt-in
    if ((credits.get(fk) ?? 0) > lowWater) return;
    if (refilling.has(fk)) return;
    refilling.add(fk);
    // Fire-and-forget: requests never block on a refill.
    l2.apply(fk, decisionTransform(strategy, clock.now(), batch))
      .then((d) => {
        lastDecision.set(fk, d);
        if (d.allowed) credits.set(fk, (credits.get(fk) ?? 0) + batch);
      })
      .catch(() => {
        /* leave credits as-is; the next check leases synchronously */
      })
      .finally(() => refilling.delete(fk));
  };

  if (returnIdleAfterMs !== undefined && returnIdleAfterMs > 0) {
    const timer = setInterval(() => {
      const now = clock.now();
      for (const [k, t] of lastUse) {
        if (now - t > returnIdleAfterMs) forget(k);
      }
    }, returnIdleAfterMs);
    (timer as { unref?(): void }).unref?.();
  }

  const check = async (key: string, cost = 1): Promise<Decision> => {
    validateCost(cost);
    const fk = keyFor(key);
    const now = clock.now();
    lastUse.set(fk, now);

    if (windowCoupled) {
      // Once the L2 window that granted these credits has rolled over, they expire rather than
      // carrying across the boundary — removing the sole source of cross-window overshoot.
      const last = lastDecision.get(fk);
      if (last !== undefined && now >= last.resetAt && (credits.get(fk) ?? 0) > 0) {
        credits.set(fk, 0);
      }
    }

    const have = credits.get(fk) ?? 0;
    if (have >= cost) {
      credits.set(fk, have - cost);
      maybeRefill(fk);
      return synthAllow(fk, now);
    }

    // Not enough local budget: lease a batch (or `cost` if larger) from L2 in one round trip.
    const leaseAmount = Math.max(batch, cost);
    const d = await l2.apply(fk, decisionTransform(strategy, clock.now(), leaseAmount));
    lastDecision.set(fk, d);
    if (d.allowed) {
      evictCredits();
      credits.set(fk, (credits.get(fk) ?? 0) + leaseAmount - cost);
      return synthAllow(fk, now);
    }
    // L2 is globally exhausted — surface its denial (correct retryAfter/resetAt).
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
      forget(fk);
      await l2.reset(fk);
    },
  };
}
