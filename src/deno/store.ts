import { systemClock } from "../core/clock";
import { StoreUnavailableError } from "../core/errors";
import type { Clock, Store, Transform } from "../core/types";

/** A Deno KV key: an array of key parts (e.g. `["throttlekit", "user:42"]`). */
export type KvKeyLike = readonly unknown[];

/** The result of a `kv.get`: the value (or `null` if absent) plus its versionstamp (`null` if absent). */
export interface KvEntryLike<T> {
  key: KvKeyLike;
  value: T | null;
  /** Opaque per-key version token; `null` means the key does not exist. The CAS check token. */
  versionstamp: string | null;
}

/** A single optimistic-concurrency assertion: "this key is still at this versionstamp". */
export interface KvCheckLike {
  key: KvKeyLike;
  versionstamp: string | null;
}

/** The slice of a Deno KV atomic-commit result ThrottleKit reads: whether every check held. */
export interface KvCommitResultLike {
  ok: boolean;
}

/** The slice of a Deno KV atomic operation ThrottleKit uses (a fluent transaction builder). */
export interface AtomicOperationLike {
  /** Assert each key is still at the given versionstamp; a mismatch fails the whole commit. */
  check(...checks: KvCheckLike[]): AtomicOperationLike;
  /** Stage a write, optionally with a native TTL (`expireIn` milliseconds). */
  set(key: KvKeyLike, value: unknown, options?: { expireIn?: number }): AtomicOperationLike;
  /** Stage a delete. */
  delete(key: KvKeyLike): AtomicOperationLike;
  /** Apply the staged mutations iff every check held; `ok` is `false` when any check failed. */
  commit(): Promise<KvCommitResultLike>;
}

/**
 * The minimal slice of a `Deno.Kv` handle ThrottleKit needs. A real `Deno.Kv` satisfies this
 * structurally, so you pass it directly — no Deno type dependency in this Node-built package.
 */
export interface DenoKvLike {
  get<T = unknown>(key: KvKeyLike): Promise<KvEntryLike<T>>;
  atomic(): AtomicOperationLike;
  delete(key: KvKeyLike): Promise<void>;
}

/** The stored value: JSON-encoded state plus an epoch-ms expiry (for clock-driven lazy expiry). */
interface StoredValue {
  /** `JSON.stringify(state)` — same encoding as every other backend, for cross-backend bit-identity. */
  s: string;
  /** Epoch-ms at which the entry expires (read as absent past it). */
  e: number;
}

export interface DenoKvStoreOptions {
  /** An open `Deno.Kv` (or compatible). ThrottleKit never closes a handle it is given. */
  kv: DenoKvLike;
  /** Key-prefix part: keys become `[prefix, key]` (vs `[key]`), namespacing one KV across limiters. */
  prefix?: string;
  /**
   * Bounded retries for the atomic compare-and-set. Default `16`. In-process applies to one key are
   * coalesced (see {@link DenoKvStore}), so retries are only spent on genuine cross-isolate races.
   */
  maxRetries?: number;
  /**
   * Time source for lazy expiry. Defaults to {@link systemClock}; inject a `ManualClock` to drive
   * expiry deterministically in tests. (Deno KV's native `expireIn` reclaims storage on Deno's own
   * clock; this clock decides "expired" for reads, keeping decisions correct and deterministic.)
   */
  clock?: Clock;
}

/** A resolved, never-rejecting promise used to seed the per-key serialization chain. */
const RESOLVED: Promise<void> = Promise.resolve();

/**
 * Distributed store backed by **Deno KV**.
 *
 * Deno KV gives a *first-class* atomic primitive — `kv.atomic().check(...).set(...).commit()` with a
 * per-key **versionstamp** — so the atomic read-modify-write {@link Store.apply} demands is built on
 * native optimistic concurrency rather than a hand-rolled version column:
 *
 * ```text
 *   const { value, versionstamp } = await kv.get(key)      -- read; lazy-expire in JS
 *   <run transform(value) in JS>                           -- the same pure code every backend runs
 *   await kv.atomic().check({ key, versionstamp })         -- commit iff the key is unchanged…
 *            .set(key, next, { expireIn }).commit()         -- …else ok=false ⇒ re-read and retry
 * ```
 *
 * The `check` asserts the key is still at the versionstamp we read (`null` = "still absent"), so the
 * commit is a true compare-and-set: a concurrent write from another isolate bumps the versionstamp,
 * the check fails (`ok: false`), and we re-read and retry. N concurrent increments across the fleet
 * land exactly N — like Redis `INCR` — with no lock held; an expired entry is overwritten in place by
 * that same CAS (its versionstamp still matches what we read).
 *
 * **In-process coalescing.** The transform is arbitrary JS, so every apply takes the CAS loop; a hot
 * key hammered from one isolate would CAS-contend with itself and burn retries. Applies to the same
 * key *from this isolate* are therefore serialized behind a per-key promise chain — one clean commit
 * each — while the CAS still reconciles genuine cross-isolate races. The chain entry is dropped once
 * it drains, bounding the lock map by in-flight keys.
 *
 * **Expiry.** `set` carries Deno KV's native `expireIn` so KV reclaims storage automatically, *and*
 * the entry stores an epoch-ms expiry so reads lazily expire on the injected {@link Clock} — which is
 * what makes expiry deterministic under a `ManualClock` and consistent with the Redis/Postgres
 * backends. **State** is the same JSON text every other backend writes, so values round-trip as the
 * exact IEEE-754 double and decisions stay bit-identical across stores.
 *
 * Async-only: `limiter.checkSync` throws (use `await limiter.check`).
 *
 * @example
 * ```ts
 * import { rateLimit, gcra } from "throttlekit";
 * import { DenoKvStore } from "throttlekit/deno";
 *
 * const kv = await Deno.openKv();
 * const limiter = rateLimit({
 *   strategy: gcra({ limit: 100, periodMs: 60_000, burst: 20 }),
 *   store: new DenoKvStore({ kv, prefix: "rl" }),
 * });
 * const d = await limiter.check(userId);
 * ```
 */
export class DenoKvStore implements Store {
  readonly #kv: DenoKvLike;
  readonly #prefix: string | undefined;
  readonly #clock: Clock;
  readonly #maxRetries: number;
  /** Per-key serialization tails: collapse same-isolate contention so the CAS only sees real races. */
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(options: DenoKvStoreOptions) {
    this.#kv = options.kv;
    this.#prefix = options.prefix;
    this.#clock = options.clock ?? systemClock;
    this.#maxRetries = options.maxRetries ?? 16;
  }

  #key(key: string): KvKeyLike {
    return this.#prefix !== undefined ? [this.#prefix, key] : [key];
  }

  /**
   * Serialize `fn` against other in-process calls for the same key via a promise chain. The tail is
   * dropped once it drains with nothing queued behind it, bounding the lock map by in-flight keys.
   */
  #withKeyLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(id) ?? RESOLVED;
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#locks.set(id, tail);
    void tail.then(() => {
      if (this.#locks.get(id) === tail) this.#locks.delete(id);
    });
    return run;
  }

  async apply<S, R>(key: string, transform: Transform<S, R>): Promise<R> {
    const kvKey = this.#key(key);
    return this.#withKeyLock(JSON.stringify(kvKey), () => this.#applyCas<S, R>(kvKey, transform));
  }

  /** Optimistic read-modify-write: read value + versionstamp, run the transform, commit iff unchanged. */
  async #applyCas<S, R>(kvKey: KvKeyLike, transform: Transform<S, R>): Promise<R> {
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      const now = this.#clock.now();
      const entry = await this.#kv.get<StoredValue>(kvKey);
      const stored = entry.value;
      // Lazy expiry on the injected clock: a past-expiry entry reads as absent (transform restarts),
      // but its versionstamp still gates the CAS so the stale entry is overwritten in place.
      const state = stored !== null && stored.e > now ? (JSON.parse(stored.s) as S) : undefined;

      const out = transform(state);
      if (!out.persist) return out.result;

      const ttl = Math.max(1, Math.ceil(out.ttlMs));
      const value: StoredValue = { s: JSON.stringify(out.state), e: now + ttl };
      const res = await this.#kv
        .atomic()
        .check({ key: kvKey, versionstamp: entry.versionstamp })
        .set(kvKey, value, { expireIn: ttl })
        .commit();

      // ok ⇒ the key was unchanged since our read and the write committed. Otherwise re-read.
      if (res.ok) return out.result;
    }
    throw new StoreUnavailableError(
      `DenoKvStore: optimistic concurrency exhausted ${this.#maxRetries} retries`,
    );
  }

  async reset(key: string): Promise<void> {
    await this.#kv.delete(this.#key(key));
  }
}
