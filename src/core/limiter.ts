import { MemoryStore } from "../stores/memory";
import { systemClock } from "./clock";
import { ThrottleKitError } from "./errors";
import { prefixer } from "./key";
import { decisionTransform, readOnlyTransform } from "./transform";
import type { Clock, Decision, Forecast, Limiter, Store, Strategy, Transform } from "./types";
import { requireCost } from "./validate";

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

/**
 * Construct a limiter from a strategy and a store. The hot path builds a single transform that
 * carries both the pure JS transition and (when the strategy offers one) the atomic Lua form, so
 * an in-memory store runs the transition locally while a Redis store collapses it to one round
 * trip — from the same configuration.
 */
/**
 * Forward a limiter's **optional** methods (`peek`/`peekSync`/`forecast`/`forecastSync`/`close`) to
 * an inner limiter, but only the ones it actually implements. Spread the result into a wrapper's
 * returned object so decorators like {@link withAnalytics}, `instrumentLimiter`, and `tapDecisions`
 * don't silently drop introspection or disposal. (The limiter methods are closures, not `this`-bound,
 * so calling them detached is safe.)
 */
export function forwardIntrospection(inner: Limiter): Partial<Limiter> {
  const out: Partial<Limiter> = {};
  const { peek, peekSync, forecast, forecastSync, close } = inner;
  if (peek) out.peek = (key) => peek(key);
  if (peekSync) out.peekSync = (key) => peekSync(key);
  if (forecast) out.forecast = (key, cost) => forecast(key, cost);
  if (forecastSync) out.forecastSync = (key, cost) => forecastSync(key, cost);
  if (close) out.close = () => close();
  return out;
}

export function rateLimit<S = unknown>(options: RateLimitOptions<S>): Limiter {
  const strategy = options.strategy;
  const clock = options.clock ?? systemClock;
  const store: Store =
    options.store ?? new MemoryStore(options.clock !== undefined ? { clock: options.clock } : {});
  // We own (and so will close) the store only when we defaulted it; a caller's store is theirs.
  const ownsStore = options.store === undefined;

  const keyFor = prefixer(options.prefix);

  // A single reused transform for the local hot path, shared by checkSync and check's synchronous-
  // store fast path. Both set `now`/`cost` on these slots and then invoke the transform *through a
  // synchronous applySync* with no await in between, so single-threaded execution guarantees the
  // slots are read before any other call can run — safe to reuse, and it avoids a per-call closure
  // allocation. No Lua invocation is attached: a synchronous store never uses it.
  let syncNow = 0;
  let syncCost = 1;
  const syncTransform = ((state: S | undefined) =>
    strategy.check(state, syncNow, syncCost)) as Transform<S, Decision>;

  return {
    strategy: strategy as Strategy<unknown>,

    check(key: string, cost = 1): Promise<Decision> {
      try {
        requireCost(cost);
      } catch (err) {
        return Promise.reject(err);
      }
      const k = keyFor(key);
      // Synchronous store (e.g. MemoryStore): run the transition inline with the reused transform
      // and hand back an already-resolved promise. This skips the async `store.apply` frame and the
      // per-call `decisionTransform` closure entirely — the async path below is only for stores that
      // are genuinely async (Redis), where a fresh transform is required for reentrancy.
      if (store.applySync !== undefined) {
        syncNow = clock.now();
        syncCost = cost;
        return Promise.resolve(store.applySync(k, syncTransform, syncNow));
      }
      return store.apply(k, decisionTransform(strategy, clock.now(), cost));
    },

    checkSync(key: string, cost = 1): Decision {
      requireCost(cost);
      if (store.applySync === undefined) {
        throw new ThrottleKitError(
          "checkSync requires a synchronous store (e.g. MemoryStore); the configured store is async-only",
        );
      }
      syncNow = clock.now();
      syncCost = cost;
      return store.applySync(keyFor(key), syncTransform, syncNow);
    },

    checkMany(keys: readonly string[], cost = 1): Promise<Decision[]> {
      try {
        requireCost(cost);
      } catch (err) {
        return Promise.reject(err);
      }
      // Synchronous store: one clock read, a tight loop, no per-key promise. Reusing the shared
      // transform is safe because applySync never yields between iterations.
      if (store.applySync !== undefined) {
        syncNow = clock.now();
        syncCost = cost;
        const out: Decision[] = new Array(keys.length);
        for (let i = 0; i < keys.length; i++) {
          out[i] = store.applySync(keyFor(keys[i] as string), syncTransform, syncNow);
        }
        return Promise.resolve(out);
      }
      // Async store: one timestamp for the whole batch, fired concurrently. Each apply gets its own
      // transform (the shared slots aren't reentrant across concurrent awaits).
      const now = clock.now();
      return Promise.all(
        keys.map((k) => store.apply(keyFor(k), decisionTransform(strategy, now, cost))),
      );
    },

    checkManySync(keys: readonly string[], cost = 1): Decision[] {
      requireCost(cost);
      if (store.applySync === undefined) {
        throw new ThrottleKitError(
          "checkManySync requires a synchronous store (e.g. MemoryStore); the configured store is async-only",
        );
      }
      syncNow = clock.now();
      syncCost = cost;
      const out: Decision[] = new Array(keys.length);
      for (let i = 0; i < keys.length; i++) {
        out[i] = store.applySync(keyFor(keys[i] as string), syncTransform, syncNow);
      }
      return out;
    },

    peek(key: string): Promise<Decision> {
      const peekFn = strategy.peek;
      if (peekFn === undefined) {
        return Promise.reject(
          new ThrottleKitError(`peek() is not supported by the "${strategy.name}" strategy`),
        );
      }
      const k = keyFor(key);
      const t = readOnlyTransform(strategy, peekFn, clock.now());
      // Non-consuming on every backend: persist:false (and the read-only Lua) never writes.
      if (store.applySync !== undefined) return Promise.resolve(store.applySync(k, t));
      return store.apply(k, t);
    },

    peekSync(key: string): Decision {
      const peekFn = strategy.peek;
      if (peekFn === undefined) {
        throw new ThrottleKitError(`peek() is not supported by the "${strategy.name}" strategy`);
      }
      if (store.applySync === undefined) {
        throw new ThrottleKitError(
          "peekSync requires a synchronous store (e.g. MemoryStore); the configured store is async-only",
        );
      }
      return store.applySync(keyFor(key), readOnlyTransform(strategy, peekFn, clock.now()));
    },

    forecast(key: string, cost = 1): Promise<Forecast> {
      const fc = strategy.forecast;
      if (fc === undefined) {
        return Promise.reject(
          new ThrottleKitError(`forecast() is not supported by the "${strategy.name}" strategy`),
        );
      }
      try {
        requireCost(cost);
      } catch (err) {
        return Promise.reject(err);
      }
      const k = keyFor(key);
      const t = readOnlyTransform(strategy, (state, now) => fc(state, now, cost), clock.now());
      if (store.applySync !== undefined) return Promise.resolve(store.applySync(k, t));
      return store.apply(k, t);
    },

    forecastSync(key: string, cost = 1): Forecast {
      const fc = strategy.forecast;
      if (fc === undefined) {
        throw new ThrottleKitError(
          `forecast() is not supported by the "${strategy.name}" strategy`,
        );
      }
      requireCost(cost);
      if (store.applySync === undefined) {
        throw new ThrottleKitError(
          "forecastSync requires a synchronous store (e.g. MemoryStore); the configured store is async-only",
        );
      }
      const t = readOnlyTransform(strategy, (state, now) => fc(state, now, cost), clock.now());
      return store.applySync(keyFor(key), t);
    },

    async reset(key: string): Promise<void> {
      await store.reset(keyFor(key));
    },

    async close(): Promise<void> {
      // Only release a store we created ourselves; a caller-provided store is theirs to close.
      if (ownsStore) await store.close?.();
    },
  };
}
