import { MemoryStore } from "../stores/memory";
import { systemClock } from "./clock";
import { ThrottleKitError } from "./errors";
import { decisionTransform } from "./transform";
import type { Clock, Decision, Limiter, Store, Strategy, Transform } from "./types";

export interface RateLimitOptions<S = unknown> {
  /** The algorithm to enforce. Defaults across the library favor {@link gcra}. */
  strategy: Strategy<S>;
  /** Where state lives. Defaults to a fresh in-process {@link MemoryStore}. */
  store?: Store;
  /** Injected clock. Defaults to the system clock. */
  clock?: Clock;
  /** Key namespace, so one store can back many independent limiters. */
  prefix?: string;
}

function validateCost(cost: number): void {
  if (!Number.isFinite(cost) || cost <= 0) {
    throw new RangeError(`cost must be a positive finite number, got ${String(cost)}`);
  }
}

/**
 * Construct a limiter from a strategy and a store. The hot path builds a single transform that
 * carries both the pure JS transition and (when the strategy offers one) the atomic Lua form, so
 * an in-memory store runs the transition locally while a Redis store collapses it to one round
 * trip — from the same configuration.
 */
export function rateLimit<S = unknown>(options: RateLimitOptions<S>): Limiter {
  const strategy = options.strategy;
  const clock = options.clock ?? systemClock;
  const store: Store =
    options.store ?? new MemoryStore(options.clock !== undefined ? { clock: options.clock } : {});

  const prefix = options.prefix;
  const keyFor =
    prefix !== undefined && prefix.length > 0
      ? (k: string): string => `${prefix}:${k}`
      : (k: string): string => k;

  // A single reused transform for the local hot path, shared by checkSync and check's synchronous-
  // store fast path. Both set `now`/`cost` on these slots and then invoke the transform *through a
  // synchronous applySync* with no await in between, so single-threaded execution guarantees the
  // slots are read before any other call can run — safe to reuse, and it avoids a per-call closure
  // allocation. No Lua invocation is attached: a synchronous store never uses it.
  let syncNow = 0;
  let syncCost = 1;
  const syncTransform = ((state: S | undefined) => {
    const r = strategy.check(state, syncNow, syncCost);
    return { state: r.state, result: r.decision, ttlMs: r.ttlMs, persist: r.persist };
  }) as Transform<S, Decision>;

  return {
    strategy: strategy as Strategy<unknown>,

    check(key: string, cost = 1): Promise<Decision> {
      if (!Number.isFinite(cost) || cost <= 0) {
        return Promise.reject(
          new RangeError(`cost must be a positive finite number, got ${String(cost)}`),
        );
      }
      const k = keyFor(key);
      // Synchronous store (e.g. MemoryStore): run the transition inline with the reused transform
      // and hand back an already-resolved promise. This skips the async `store.apply` frame and the
      // per-call `decisionTransform` closure entirely — the async path below is only for stores that
      // are genuinely async (Redis), where a fresh transform is required for reentrancy.
      if (store.applySync !== undefined) {
        syncNow = clock.now();
        syncCost = cost;
        return Promise.resolve(store.applySync(k, syncTransform));
      }
      return store.apply(k, decisionTransform(strategy, clock.now(), cost));
    },

    checkSync(key: string, cost = 1): Decision {
      validateCost(cost);
      if (store.applySync === undefined) {
        throw new ThrottleKitError(
          "checkSync requires a synchronous store (e.g. MemoryStore); the configured store is async-only",
        );
      }
      syncNow = clock.now();
      syncCost = cost;
      return store.applySync(keyFor(key), syncTransform);
    },

    async reset(key: string): Promise<void> {
      await store.reset(keyFor(key));
    },
  };
}
