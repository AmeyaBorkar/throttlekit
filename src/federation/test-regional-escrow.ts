/**
 * `TestRegionalEscrow` — an in-memory, deterministic {@link RegionalEscrow}
 * for tests + examples. Models the same window-coupled L2 semantics that
 * {@link RedisRegionalEscrow} implements atomically in Lua: window-coupled
 * balance keyed on `source_lease`; additive refills within a window;
 * idempotent release at window roll.
 *
 * Mirrors {@link TestCoordinator} one layer down — no timers, no I/O,
 * deterministic under an injected clock. Tests typically wire both:
 *
 *     const clock = new ManualClock(0);
 *     const coord = new TestCoordinator({ budgetPerWindow: 100 });
 *     const l2 = new TestRegionalEscrow({ windowMs: 60_000, clock });
 *     const fed = federate({ coordinator: coord, regionalEscrow: l2, ... });
 */

import { systemClock } from "../core/clock";
import { StoreUnavailableError } from "../core/errors";
import type { Clock } from "../core/types";
import type { RegionalEscrow } from "./types";

/** Options for {@link TestRegionalEscrow}. */
export interface TestRegionalEscrowOptions {
  /** Window length in ms — MUST match the strategy's `windowMs` you federate. */
  windowMs: number;
  /** Injected clock for deterministic tests. Defaults to {@link systemClock}. */
  clock?: Clock;
  /**
   * When `false`, `lease()` / `refill()` / `release()` reject with
   * `StoreUnavailableError`. Useful for simulating regional Redis outage.
   * Defaults to `true`.
   */
  healthy?: boolean;
}

/** One L2 entry per key. */
interface Entry {
  balance: number;
  /** The coordinator window this balance is from. */
  sourceLease: number;
  /** Epoch-ms when this entry's window ends. */
  expiresAt: number;
}

export class TestRegionalEscrow implements RegionalEscrow {
  readonly #windowMs: number;
  readonly #clock: Clock;
  readonly #entries = new Map<string, Entry>();
  #healthy: boolean;

  constructor(options: TestRegionalEscrowOptions) {
    if (!Number.isFinite(options.windowMs) || options.windowMs < 1) {
      throw new RangeError(
        `windowMs must be a finite number >= 1, got ${String(options.windowMs)}`,
      );
    }
    this.#windowMs = options.windowMs;
    this.#clock = options.clock ?? systemClock;
    this.#healthy = options.healthy ?? true;
  }

  /** Simulate a regional Redis partition. Operations throw until `setHealthy(true)`. */
  setHealthy(healthy: boolean): void {
    this.#healthy = healthy;
  }

  /** For tests: snapshot the current balance of `key` (0 if no entry or expired). */
  balanceFor(key: string): number {
    const e = this.#entries.get(key);
    if (e === undefined) return 0;
    if (this.#clock.now() >= e.expiresAt) return 0;
    return e.balance;
  }

  async lease(key: string, tokens: number): Promise<number> {
    if (!this.#healthy) {
      throw new StoreUnavailableError(`TestRegionalEscrow partitioned (lease "${key}")`);
    }
    if (!Number.isFinite(tokens) || tokens < 0) {
      throw new RangeError(
        `lease tokens must be a non-negative finite number, got ${String(tokens)}`,
      );
    }
    if (tokens === 0) return 0;

    const now = this.#clock.now();
    const e = this.#entries.get(key);
    if (e === undefined || now >= e.expiresAt) return 0;

    const granted = Math.min(tokens, e.balance);
    if (granted <= 0) return 0;
    e.balance -= granted;
    return granted;
  }

  async refill(key: string, granted: number, sourceWindowStart: number): Promise<boolean> {
    if (!this.#healthy) {
      throw new StoreUnavailableError(`TestRegionalEscrow partitioned (refill "${key}")`);
    }
    if (!Number.isFinite(granted) || granted < 0) {
      throw new RangeError(
        `refill granted must be a non-negative finite number, got ${String(granted)}`,
      );
    }
    if (!Number.isFinite(sourceWindowStart) || sourceWindowStart < 0) {
      throw new RangeError(
        `refill sourceWindowStart must be a non-negative finite number, got ${String(sourceWindowStart)}`,
      );
    }
    if (granted === 0) return true;

    const now = this.#clock.now();
    const expiresAt = sourceWindowStart + this.#windowMs;

    // Window-coupled: drop refills for already-expired windows.
    if (now >= expiresAt) return false;

    const e = this.#entries.get(key);
    if (e === undefined || e.sourceLease !== sourceWindowStart) {
      this.#entries.set(key, { balance: granted, sourceLease: sourceWindowStart, expiresAt });
    } else {
      e.balance += granted;
      e.expiresAt = expiresAt;
    }
    return true;
  }

  async release(key: string, sourceWindowStart: number): Promise<number> {
    if (!this.#healthy) {
      throw new StoreUnavailableError(`TestRegionalEscrow partitioned (release "${key}")`);
    }
    if (!Number.isFinite(sourceWindowStart) || sourceWindowStart < 0) {
      throw new RangeError(
        `release sourceWindowStart must be a non-negative finite number, got ${String(sourceWindowStart)}`,
      );
    }

    const e = this.#entries.get(key);
    if (e === undefined || e.sourceLease !== sourceWindowStart) return 0;

    const leftover = e.balance;
    this.#entries.delete(key);
    return leftover;
  }

  async isHealthy(): Promise<boolean> {
    return this.#healthy;
  }
}
