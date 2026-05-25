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

  // A single reused transform for the synchronous hot path. checkSync is non-reentrant (it never
  // awaits), so threading `now`/`cost` through closure-captured mutable slots is safe and avoids a
  // per-call closure allocation. No Lua invocation is attached: a synchronous store never uses it.
  let syncNow = 0;
  let syncCost = 1;
  const syncTransform = ((state: S | undefined) => {
    const r = strategy.check(state, syncNow, syncCost);
    return { state: r.state, result: r.decision, ttlMs: r.ttlMs, persist: r.persist };
  }) as Transform<S, Decision>;

  return {
    strategy: strategy as Strategy<unknown>,

    async check(key: string, cost = 1): Promise<Decision> {
      validateCost(cost);
      return store.apply(keyFor(key), decisionTransform(strategy, clock.now(), cost));
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
