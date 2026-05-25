import { MemoryStore } from "../stores/memory";
import { systemClock } from "./clock";
import { ThrottleKitError } from "./errors";
import { decodeDecision } from "./lua";
import type { Clock, Decision, Limiter, LuaInvocation, Store, Strategy, Transform } from "./types";

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

  const makeTransform = (now: number, cost: number): Transform<S, Decision> => {
    const fn = (state: S | undefined) => {
      const r = strategy.check(state, now, cost);
      return { state: r.state, result: r.decision, ttlMs: r.ttlMs, persist: r.persist };
    };
    if (strategy.lua !== undefined) {
      const invocation: LuaInvocation<Decision> = {
        program: strategy.lua,
        now,
        cost,
        decode: decodeDecision,
      };
      (fn as { lua?: LuaInvocation<Decision> }).lua = invocation;
    }
    return fn as Transform<S, Decision>;
  };

  return {
    strategy: strategy as Strategy<unknown>,

    async check(key: string, cost = 1): Promise<Decision> {
      validateCost(cost);
      return store.apply(keyFor(key), makeTransform(clock.now(), cost));
    },

    checkSync(key: string, cost = 1): Decision {
      validateCost(cost);
      if (store.applySync === undefined) {
        throw new ThrottleKitError(
          "checkSync requires a synchronous store (e.g. MemoryStore); the configured store is async-only",
        );
      }
      return store.applySync(keyFor(key), makeTransform(clock.now(), cost));
    },

    async reset(key: string): Promise<void> {
      await store.reset(keyFor(key));
    },
  };
}
