/**
 * `TestCoordinator` — an in-memory, deterministic `GlobalCoordinator` for
 * tests + examples. Models the same window-coupled lease semantics the
 * RedisCoordinator will (TK-906): leases granted up to a per-key per-window
 * budget; expired leases discarded at the window boundary; idempotent
 * reconciliation on `windowStart`.
 *
 * Intentionally separate from `MemoryStore` (the regional store) because
 * they serve different roles — MemoryStore plays the regional L2; this
 * plays the cross-region coordinator. Tests typically wire them together:
 *
 *     const regional = new MemoryStore({ ... });
 *     const coordinator = new TestCoordinator({ budgetPerWindow: 1000 });
 *     const fed = new FederatedStore({ regional, coordinator, region: "us-east" });
 *
 * No timers; no I/O. Deterministic under an injected clock.
 */

import { StoreUnavailableError } from "../core/errors";
import type { GlobalCoordinator } from "./types";

/** Options for {@link TestCoordinator}. */
export interface TestCoordinatorOptions {
  /**
   * Default global budget granted per window for any key with no override.
   * The coordinator's safety check: any `lease()` may at most drain this
   * budget to zero. Set per-key budgets via {@link TestCoordinator.setBudget}.
   */
  budgetPerWindow?: number;
  /**
   * When `false`, `lease()` and `reconcile()` reject with
   * `StoreUnavailableError`. Useful for simulating coordinator partitions.
   * Defaults to `true`.
   */
  healthy?: boolean;
  /**
   * Window length in ms. When set, {@link TestCoordinator.reconcile} models the production
   * **window-coupling** guard (`RedisCoordinator`/`PostgresCoordinator`): leftover is credited back ONLY
   * if it belongs to the still-active window (`windowStart === activeExpiresAt − windowMs`); leftover from
   * an already-rolled window is FORFEIT, exactly as the formal `Roll` expires escrow — so a rolled window's
   * leftover can never inflate a later window past `budgetPerWindow` cumulative admissions. When omitted,
   * reconcile keeps the legacy unconditional credit (for unit tests that don't model window boundaries).
   */
  windowMs?: number;
}

/** One window's mutable state per key, keyed on the window's `expiresAt`. */
interface WindowState {
  expiresAt: number;
  budgetRemaining: number;
  /** Window starts the coordinator has already reconciled (for idempotency). */
  reconciledWindowStarts: Set<number>;
}

const DEFAULT_BUDGET = 1000;

export class TestCoordinator implements GlobalCoordinator {
  #healthy: boolean;
  #defaultBudget: number;
  readonly #windowMs: number | undefined;
  /** Per-key budget overrides; falls back to `#defaultBudget` when absent. */
  readonly #perKeyBudget = new Map<string, number>();
  /** key -> current-window state. Replaced wholesale when expiresAt advances. */
  readonly #windows = new Map<string, WindowState>();

  constructor(options: TestCoordinatorOptions = {}) {
    this.#defaultBudget = options.budgetPerWindow ?? DEFAULT_BUDGET;
    this.#healthy = options.healthy ?? true;
    this.#windowMs = options.windowMs;
  }

  /** Override the per-window budget for a specific key. */
  setBudget(key: string, budgetPerWindow: number): void {
    this.#perKeyBudget.set(key, budgetPerWindow);
    // If the key already has an active window, retroactively widen/shrink it
    // (tests sometimes set the budget after the first lease lands).
    const existing = this.#windows.get(key);
    if (existing !== undefined) {
      existing.budgetRemaining = Math.min(existing.budgetRemaining, budgetPerWindow);
    }
  }

  /** Simulate a coordinator partition. New leases throw until `setHealthy(true)`. */
  setHealthy(healthy: boolean): void {
    this.#healthy = healthy;
  }

  /** For tests: snapshot the remaining budget of `key`'s active window. */
  remainingFor(key: string, now: number): number {
    const w = this.#windows.get(key);
    if (w === undefined || now >= w.expiresAt) {
      // Window has rolled or never existed — fresh budget.
      return this.#budgetFor(key);
    }
    return w.budgetRemaining;
  }

  async lease(key: string, tokens: number, expiresAt: number): Promise<number> {
    if (!this.#healthy) {
      throw new StoreUnavailableError(`TestCoordinator partitioned (lease "${key}")`);
    }
    if (!Number.isFinite(tokens) || tokens < 0) {
      throw new RangeError(
        `lease tokens must be a non-negative finite number, got ${String(tokens)}`,
      );
    }
    if (tokens === 0) return 0;

    const state = this.#windowFor(key, expiresAt);
    const granted = Math.min(tokens, state.budgetRemaining);
    state.budgetRemaining -= granted;
    return granted;
  }

  async reconcile(key: string, leftover: number, windowStart: number): Promise<void> {
    if (!this.#healthy) {
      throw new StoreUnavailableError(`TestCoordinator partitioned (reconcile "${key}")`);
    }
    if (!Number.isFinite(leftover) || leftover < 0) {
      throw new RangeError(`reconcile leftover must be non-negative, got ${String(leftover)}`);
    }

    const state = this.#windows.get(key);
    if (state === undefined) {
      // No active window — nothing to reconcile against. Idempotent no-op.
      return;
    }
    // Window-coupling: leftover may be credited back ONLY into the window it was leased from, and only
    // while that window is still the active one. Leftover from an already-rolled window is FORFEIT (the
    // formal `Roll` expires escrow) — otherwise refilling a later, already-draining window lets cumulative
    // admissions exceed the budget. Modeled only when windowMs is configured (else legacy unconditional).
    if (this.#windowMs !== undefined && windowStart !== state.expiresAt - this.#windowMs) {
      return; // leftover belongs to a rolled window — forfeit, don't credit a later window
    }
    if (state.reconciledWindowStarts.has(windowStart)) {
      // Already reconciled this windowStart — strict idempotence (required for
      // partition recovery per DESIGN.md §3.1 / §5.5).
      return;
    }
    state.reconciledWindowStarts.add(windowStart);
    state.budgetRemaining = Math.min(state.budgetRemaining + leftover, this.#budgetFor(key));
  }

  async isHealthy(): Promise<boolean> {
    return this.#healthy;
  }

  #budgetFor(key: string): number {
    return this.#perKeyBudget.get(key) ?? this.#defaultBudget;
  }

  #windowFor(key: string, expiresAt: number): WindowState {
    const existing = this.#windows.get(key);
    if (existing !== undefined && existing.expiresAt === expiresAt) return existing;
    // Window rolled (different expiresAt) OR first lease for this key — start fresh.
    const fresh: WindowState = {
      expiresAt,
      budgetRemaining: this.#budgetFor(key),
      reconciledWindowStarts: new Set(),
    };
    this.#windows.set(key, fresh);
    return fresh;
  }
}
