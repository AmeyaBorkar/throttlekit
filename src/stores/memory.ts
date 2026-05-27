import { systemClock } from "../core/clock";
import type { ApplyOutcome, Clock, Store, Transform } from "../core/types";
import { TimingWheel } from "./timing-wheel";

interface Entry {
  state: unknown;
  /** CLOCK reference bit: set on access, cleared by the hand (only used when bounded). */
  ref: boolean;
  /** Index into the CLOCK ring, or -1 when the store is unbounded. */
  slot: number;
  /** Epoch-ms expiry, checked inline on read so the hot path needs no second (wheel) Map lookup. */
  exp: number;
}

export interface MemoryStoreOptions {
  /** Injected clock. Defaults to the system clock. */
  clock?: Clock;
  /**
   * Maximum number of distinct keys before approximate-LRU (CLOCK) eviction kicks in. Unbounded
   * when omitted — set this on public endpoints so a flood of unique keys can't grow the map
   * without limit.
   */
  maxKeys?: number;
  /**
   * Background sweep interval (ms) that expires idle keys even without traffic. `0` disables the
   * timer entirely (cleanup becomes purely access-driven), which is the right choice on edge
   * runtimes. Default 5000. The timer is `unref`'d so it never keeps a Node process alive.
   */
  sweepIntervalMs?: number;
  /** Timer-wheel tick resolution in ms. Default 1000. */
  tickMs?: number;
  /** Timer-wheel slot count. Default 512. */
  wheelSize?: number;
}

/**
 * In-process store. Atomicity is free: Node is single-threaded, so a synchronous
 * read-modify-write cannot interleave — {@link MemoryStore.applySync} needs no locks. The async
 * {@link MemoryStore.apply} simply resolves the same synchronous result, composing with code that
 * awaits stores. State is kept as native values (no JSON) so the hot path never serializes.
 *
 * When `maxKeys` is set, a CLOCK (second-chance) policy bounds the key cardinality: each access
 * sets a reference bit, and the hand evicts the first key it finds with the bit clear — O(1)
 * amortized, with no per-read map reordering, so an adversarial flood of unique keys can't OOM.
 */
export class MemoryStore implements Store {
  readonly #clock: Clock;
  readonly #map = new Map<string, Entry>();
  readonly #wheel: TimingWheel;
  readonly #maxKeys: number;
  readonly #bounded: boolean;
  /** CLOCK ring of keys (or `undefined` tombstones); only populated when bounded. */
  readonly #ring: (string | undefined)[] = [];
  #hand = 0;
  #sweepTimer: ReturnType<typeof setInterval> | undefined;
  /** Pre-bound sweep callback, so the per-call `applySync` hot path allocates no closure. */
  readonly #dropBound = (k: string): void => this.#drop(k);

  constructor(opts: MemoryStoreOptions = {}) {
    this.#clock = opts.clock ?? systemClock;
    this.#maxKeys = opts.maxKeys ?? Number.POSITIVE_INFINITY;
    this.#bounded = Number.isFinite(this.#maxKeys);
    this.#wheel = new TimingWheel(this.#clock.now(), {
      tickMs: opts.tickMs ?? 1000,
      wheelSize: opts.wheelSize ?? 512,
    });
    const sweep = opts.sweepIntervalMs ?? 5000;
    if (sweep > 0) {
      this.#sweepTimer = setInterval(() => {
        this.#wheel.advance(this.#clock.now(), this.#dropBound);
      }, sweep);
      // Do not keep the host process alive solely for cleanup (Node only).
      (this.#sweepTimer as { unref?(): void }).unref?.();
    }
  }

  /** Live key count (after sweeping at the current time). */
  get size(): number {
    return this.#map.size;
  }

  /** Whether `key` is present and unexpired at the current time. */
  has(key: string): boolean {
    const entry = this.#map.get(key);
    return entry !== undefined && entry.exp > this.#clock.now();
  }

  /** Remove a key from the map and release its CLOCK ring slot (does not touch the wheel). */
  #drop(key: string): void {
    const entry = this.#map.get(key);
    if (entry === undefined) return;
    if (this.#bounded && entry.slot >= 0) this.#ring[entry.slot] = undefined;
    this.#map.delete(key);
  }

  /** Find a free ring slot, evicting one unreferenced live key if the ring is full (CLOCK). */
  #evictSlot(): number {
    const n = this.#ring.length;
    // At most one full sweep to clear bits + one to find a victim ⇒ bounded work.
    for (let i = 0; i <= n * 2; i++) {
      const slot = this.#hand;
      this.#hand = (this.#hand + 1) % n;
      const k = this.#ring[slot];
      if (k === undefined) return slot; // tombstone: free
      const entry = this.#map.get(k);
      if (entry === undefined) return slot; // stale: free
      if (entry.ref) {
        entry.ref = false; // second chance
        continue;
      }
      // Evict this key.
      this.#map.delete(k);
      this.#wheel.delete(k);
      return slot;
    }
    return this.#hand; // unreachable in practice
  }

  #insert(key: string, state: unknown, exp: number): void {
    if (!this.#bounded) {
      this.#map.set(key, { state, ref: false, slot: -1, exp });
      return;
    }
    let slot: number;
    if (this.#ring.length < this.#maxKeys) {
      slot = this.#ring.length;
      this.#ring.push(key);
    } else {
      slot = this.#evictSlot();
      this.#ring[slot] = key;
    }
    this.#map.set(key, { state, ref: false, slot, exp });
  }

  applySync<S, R>(key: string, transform: Transform<S, R>, now = this.#clock.now()): R {
    this.#wheel.advance(now, this.#dropBound);

    let entry = this.#map.get(key);
    // Lazy expiry inline off the entry's own `exp` — no second (wheel) Map lookup on the hot path.
    if (entry !== undefined && entry.exp <= now) {
      this.#drop(key);
      this.#wheel.delete(key);
      entry = undefined;
    }

    if (entry !== undefined && this.#bounded) entry.ref = true; // CLOCK: mark accessed
    const current = entry !== undefined ? (entry.state as S) : undefined;
    const out: ApplyOutcome<S, R> = transform(current);

    if (out.persist) {
      const exp = now + Math.max(0, out.ttlMs);
      if (entry !== undefined) {
        entry.state = out.state;
        entry.exp = exp;
      } else {
        this.#insert(key, out.state, exp);
      }
      this.#wheel.set(key, exp);
    }
    return out.result;
  }

  async apply<S, R>(key: string, transform: Transform<S, R>): Promise<R> {
    return this.applySync(key, transform);
  }

  resetSync(key: string): void {
    this.#drop(key);
    this.#wheel.delete(key);
  }

  async reset(key: string): Promise<void> {
    this.resetSync(key);
  }

  async close(): Promise<void> {
    if (this.#sweepTimer !== undefined) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = undefined;
    }
    this.#map.clear();
    this.#ring.length = 0;
  }
}
