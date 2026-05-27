import { systemClock } from "../core/clock";
import { prefixer } from "../core/key";
import type { Clock, Store, Transform } from "../core/types";

/**
 * The slice of a Cloudflare **Workers KV** namespace ThrottleKit uses. The real `KVNamespace`
 * satisfies it structurally — no `@cloudflare/workers-types` dependency.
 */
export interface KVNamespaceLike {
  /** Read a key's text value (`null` if absent). */
  get(key: string): Promise<string | null>;
  /** Write a key; `expirationTtl` is seconds (Cloudflare enforces a 60s minimum). */
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  /** Delete a key. */
  delete(key: string): Promise<void>;
}

export interface KVStoreOptions {
  /** The bound KV namespace (e.g. `env.RATELIMIT`). */
  kv: KVNamespaceLike;
  /** Key namespace, so one KV can back many limiters. */
  prefix?: string;
  /** Injected clock (epoch-ms). Defaults to the system clock. */
  clock?: Clock;
}

/** Cloudflare KV's minimum `expirationTtl`, in seconds — values below this are rejected by the API. */
const KV_MIN_TTL_SECONDS = 60;

/** Stored shape: the JSON-encoded strategy state plus a logical expiry (epoch-ms). */
interface StoredValue {
  /** JSON-encoded strategy state. */
  s: string;
  /** Logical expiry (epoch-ms); a read past this treats the key as absent. */
  e: number;
}

/**
 * **Best-effort, approximate** rate-limit store on Cloudflare Workers KV.
 *
 * ⚠️ Unlike every other ThrottleKit store, this one is **NOT exact**. Workers KV is eventually
 * consistent and offers **no atomic compare-and-set**, so concurrent checks on the same key
 * read-modify-write over each other (lost updates) and a write may not be visible to a read on
 * another edge location for some seconds. Both effects mean it can **over-admit** under load. It is
 * therefore intentionally *not* run through the atomic store-conformance suite, and it does not honor
 * the strict `Store` guarantee the limiter normally relies on.
 *
 * Use it only where occasional over-admission is acceptable — coarse, cheap edge protection where you
 * have no Durable Object or D1 binding. **For correctness on Cloudflare, prefer `DurableObjectStore`
 * (single-threaded, exact) or `D1Store` (version-CAS, exact).** See the Distributed page.
 *
 * Notes:
 * - **Async only** (`checkSync` throws): every check is a network read + write.
 * - **Sub-minute windows are coarse:** KV's `expirationTtl` floor is 60s, so a key physically lingers
 *   up to a minute. A *logical* expiry is stored alongside the state and enforced on read, so the
 *   limiter's own window math stays correct — but cleanup of idle keys is no faster than 60s.
 */
export class KVStore implements Store {
  readonly #kv: KVNamespaceLike;
  readonly #prefixKey: (key: string) => string;
  readonly #clock: Clock;

  constructor(options: KVStoreOptions) {
    this.#kv = options.kv;
    this.#prefixKey = prefixer(options.prefix);
    this.#clock = options.clock ?? systemClock;
  }

  async apply<S, R>(key: string, transform: Transform<S, R>): Promise<R> {
    const k = this.#prefixKey(key);
    const now = this.#clock.now();

    // Read current state, honoring the logical expiry (KV's 60s TTL floor can't be trusted for it).
    let state: S | undefined;
    const raw = await this.#kv.get(k);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as StoredValue;
      if (parsed.e > now) state = JSON.parse(parsed.s) as S;
    }

    // Last-write-wins: no CAS is available, so this RMW is not atomic across concurrent callers.
    const out = transform(state);
    if (out.persist) {
      const ttlMs = Math.max(1, out.ttlMs);
      const stored: StoredValue = { s: JSON.stringify(out.state), e: now + ttlMs };
      const expirationTtl = Math.max(KV_MIN_TTL_SECONDS, Math.ceil(ttlMs / 1000));
      await this.#kv.put(k, JSON.stringify(stored), { expirationTtl });
    }
    return out.result;
  }

  async reset(key: string): Promise<void> {
    await this.#kv.delete(this.#prefixKey(key));
  }
}
