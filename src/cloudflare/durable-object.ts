import { systemClock } from "../core/clock";
import type { Clock, Store, Transform } from "../core/types";

/**
 * Cloudflare **Durable Objects** store — the correct atomic backend for rate limiting on Cloudflare.
 *
 * A Durable Object is a single-threaded actor with strongly-consistent transactional storage, which
 * makes it the *right* Cloudflare primitive for a limiter: unlike Workers KV (eventually consistent,
 * no atomic compare-and-set — it cannot honor the {@link Store} contract and would silently
 * over-admit), a DO can run an exact read-modify-write. This store wraps the limiter's **existing pure
 * JS transform** (the same code every other backend runs — there is no DO-specific algorithm to keep
 * in sync) inside {@link DurableObjectStateLike.blockConcurrencyWhile}, which serializes the section
 * against every other handler in the object. So `apply` is atomic with **no optimistic-retry loop**:
 * N concurrent increments land exactly N, like Redis `INCR`.
 *
 * **Where it runs.** Construct it *inside* your Durable Object, from the object's `state`:
 *
 * ```ts
 * import { rateLimit, gcra } from "throttlekit";
 * import { DurableObjectStore } from "throttlekit/cloudflare";
 *
 * export class RateLimiter {
 *   private limiter;
 *   constructor(state: DurableObjectState) {
 *     this.limiter = rateLimit({
 *       strategy: gcra({ limit: 100, periodMs: 60_000, burst: 20 }),
 *       store: new DurableObjectStore(state),
 *     });
 *   }
 *   async fetch(req: Request) {
 *     const { pathname } = new URL(req.url);
 *     const d = await this.limiter.check(pathname.slice(1) || "default");
 *     return Response.json(d, { status: d.allowed ? 200 : 429 });
 *   }
 * }
 * ```
 *
 * **Sharding.** Each DO instance is a serialization point. For independent throughput per identity,
 * route each rate-limit key to its **own** DO via `env.NS.idFromName(key)` (one key per object). To
 * share one global budget across a region, route a bounded key set through a single object — every
 * apply then serializes there, which is exactly what makes the budget exact, at that object's
 * throughput ceiling.
 *
 * **Expiry** is lazy: an entry whose stored expiry has passed reads as absent (the next apply starts
 * fresh), mirroring Redis/Postgres. Every built-in strategy is idempotent w.r.t. stale state, so a
 * late physical delete never changes a decision. To reclaim storage proactively, schedule a DO alarm
 * that deletes expired keys; lazy expiry already keeps decisions correct without one.
 *
 * **State** is stored as the same JSON text the Redis optimistic-concurrency and Postgres paths write,
 * so a value round-trips as the exact IEEE-754 double and decisions stay bit-identical across backends.
 */
export interface DurableObjectStorageLike {
  /** Read a stored value (strongly consistent within the object). `undefined` when absent. */
  get<T = unknown>(key: string): Promise<T | undefined>;
  /** Write a value. */
  put<T = unknown>(key: string, value: T): Promise<void>;
  /** Delete a key; resolves `true` if it existed. */
  delete(key: string): Promise<boolean>;
}

/**
 * The minimal slice of a Cloudflare `DurableObjectState` ThrottleKit needs — its transactional
 * `storage` and `blockConcurrencyWhile`. A real `DurableObjectState` satisfies this structurally, so
 * you pass `state` directly; no `@cloudflare/workers-types` dependency is required.
 */
export interface DurableObjectStateLike {
  /** The object's transactional key-value storage. */
  storage: DurableObjectStorageLike;
  /**
   * Run `fn` while blocking delivery of any other event to this object until it settles — i.e. a
   * serialized critical section. This is what makes the read-modify-write atomic.
   */
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}

/** A stored entry: the JSON-encoded state plus an epoch-ms expiry (the entry reads absent once expired). */
interface StoredEntry {
  /** `JSON.stringify(state)` — same encoding as the other backends, for cross-backend bit-identity. */
  s: string;
  /** Epoch-ms at which the entry expires. */
  e: number;
}

export interface DurableObjectStoreOptions {
  /** Storage key namespace, prefixed as `prefix:key`. */
  prefix?: string;
  /**
   * Time source for lazy expiry. Defaults to {@link systemClock}; inject a `ManualClock` to drive
   * expiry deterministically in tests.
   */
  clock?: Clock;
}

/** Distributed store backed by a single Cloudflare Durable Object. See the file-level docs. */
export class DurableObjectStore implements Store {
  readonly #state: DurableObjectStateLike;
  readonly #storage: DurableObjectStorageLike;
  readonly #prefix: string;
  readonly #clock: Clock;

  constructor(state: DurableObjectStateLike, options: DurableObjectStoreOptions = {}) {
    this.#state = state;
    this.#storage = state.storage;
    this.#prefix = options.prefix ?? "";
    this.#clock = options.clock ?? systemClock;
  }

  #key(key: string): string {
    return this.#prefix.length > 0 ? `${this.#prefix}:${key}` : key;
  }

  async apply<S, R>(key: string, transform: Transform<S, R>): Promise<R> {
    const fullKey = this.#key(key);
    // Single-threaded + blockConcurrencyWhile ⇒ this read-modify-write is serialized against every
    // other handler in the object, so it is atomic with no optimistic-retry loop.
    return this.#state.blockConcurrencyWhile(async () => {
      const now = this.#clock.now();
      const entry = await this.#storage.get<StoredEntry>(fullKey);
      // Lazy expiry: a past-expiry entry reads as absent (the strategy then starts a fresh state).
      const state = entry !== undefined && entry.e > now ? (JSON.parse(entry.s) as S) : undefined;

      const out = transform(state);

      if (out.persist) {
        const ttl = Math.max(1, Math.ceil(out.ttlMs));
        await this.#storage.put<StoredEntry>(fullKey, {
          s: JSON.stringify(out.state),
          e: now + ttl,
        });
      }
      return out.result;
    });
  }

  async reset(key: string): Promise<void> {
    const fullKey = this.#key(key);
    // Serialize the delete against concurrent applies on the same object.
    await this.#state.blockConcurrencyWhile(async () => {
      await this.#storage.delete(fullKey);
    });
  }
}
