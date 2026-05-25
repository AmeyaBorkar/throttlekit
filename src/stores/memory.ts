import { systemClock } from "../core/clock";
import type { ApplyOutcome, Clock, Store, Transform } from "../core/types";
import { TimingWheel } from "./timing-wheel";

interface Entry {
  state: unknown;
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
 */
export class MemoryStore implements Store {
  readonly #clock: Clock;
  readonly #map = new Map<string, Entry>();
  readonly #wheel: TimingWheel;
  readonly #maxKeys: number;
  #sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: MemoryStoreOptions = {}) {
    this.#clock = opts.clock ?? systemClock;
    this.#maxKeys = opts.maxKeys ?? Number.POSITIVE_INFINITY;
    this.#wheel = new TimingWheel(this.#clock.now(), {
      tickMs: opts.tickMs ?? 1000,
      wheelSize: opts.wheelSize ?? 512,
    });
    const sweep = opts.sweepIntervalMs ?? 5000;
    if (sweep > 0) {
      this.#sweepTimer = setInterval(() => {
        this.#wheel.advance(this.#clock.now(), (k) => this.#map.delete(k));
      }, sweep);
      // Do not keep the host process alive solely for cleanup (Node only).
      (this.#sweepTimer as { unref?(): void }).unref?.();
    }
  }

  /** Live key count (after sweeping at the current time). */
  get size(): number {
    return this.#map.size;
  }

  applySync<S, R>(key: string, transform: Transform<S, R>): R {
    const now = this.#clock.now();
    this.#wheel.advance(now, (k) => this.#map.delete(k));

    let entry = this.#map.get(key);
    if (entry !== undefined && this.#wheel.isExpired(key, now)) {
      this.#map.delete(key);
      this.#wheel.delete(key);
      entry = undefined;
    }

    const current = entry !== undefined ? (entry.state as S) : undefined;
    const out: ApplyOutcome<S, R> = transform(current);

    if (out.persist) {
      if (entry !== undefined) {
        entry.state = out.state;
      } else {
        if (this.#map.size >= this.#maxKeys) this.#evict();
        this.#map.set(key, { state: out.state });
      }
      this.#wheel.set(key, now + Math.max(0, out.ttlMs));
    }
    return out.result;
  }

  async apply<S, R>(key: string, transform: Transform<S, R>): Promise<R> {
    return this.applySync(key, transform);
  }

  resetSync(key: string): void {
    this.#map.delete(key);
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
  }

  /**
   * Evict one key to make room. Placeholder until CLOCK approximate-LRU lands; for now it drops
   * the oldest insertion (Map iteration order), which is a safe upper bound on memory.
   */
  #evict(): void {
    const oldest = this.#map.keys().next();
    if (!oldest.done) {
      this.#map.delete(oldest.value);
      this.#wheel.delete(oldest.value);
    }
  }
}
