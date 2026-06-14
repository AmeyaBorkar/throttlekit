/**
 * `PostgresCoordinator` — alternative production-ready `GlobalCoordinator`
 * backed by a single Postgres primary. Drop-in replacement for
 * `RedisCoordinator` (same interface, same semantics, same window-coupling
 * guarantee — see `research/postgres-coordinator/DESIGN.md` for the full
 * design + the lift argument from the federation TLA⁺ proof).
 *
 * Layout — one row per coordinator key in `tk_fed_state`:
 *
 *     key                 : `<prefix>:<key>` (PK)
 *     budget              : remaining global budget for the active window
 *     expires_at          : when the active window ends (epoch-ms)
 *     reconciled_markers  : bigint[] of windowStart's reconciled (idempotency)
 *     updated_at          : last-touch epoch-ms (debug + GC)
 *
 * Atomicity via single-transaction `INSERT ON CONFLICT … DO UPDATE` + `SELECT
 * FOR UPDATE` + `UPDATE`, all on one row. Window roll is handled in-place:
 * when `expires_at` differs from the stored value the budget resets to
 * `perKeyBudget` and reconciled markers clear. Mirrors the Redis HASH +
 * PEXPIRE pattern without needing a TTL primitive.
 *
 * Server-time anchoring via `clock_timestamp()` (NOT `current_timestamp` —
 * the latter returns the transaction's start time, which can drift if the
 * transaction is long-running). Equivalent to Redis's `TIME` command —
 * node clock skew is irrelevant for the bound.
 *
 * **SPOF.** A single Postgres primary IS a single point of failure.
 * Mitigations: synchronous replication + automated failover (Patroni,
 * pg_auto_failover); during the failover window, regions fall back to
 * fail-closed (the Δ = 0 bound is preserved).
 *
 * See `research/postgres-coordinator/DESIGN.md` §§3-10.
 */

import { StoreUnavailableError } from "../core/errors";
import type { PgPoolLike } from "../postgres/store";
import type { GlobalCoordinator } from "./types";

const DEFAULT_BUDGET = 1000;
const DEFAULT_TABLE = "tk_fed_state";
const DEFAULT_PREFIX = "tk:fed";
const DEFAULT_GC_INTERVAL_MS = 60_000;
const DEFAULT_GC_RETENTION_MS = 86_400_000; // 24h

/**
 * SQL identifier validator. Table names cannot be parameterized in SQL so
 * we accept only a conservative shape — alphanumeric + underscores. Throws
 * on anything that could carry a SQL fragment.
 */
function assertSafeIdentifier(name: string, what: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new RangeError(`${what} must match [a-zA-Z_][a-zA-Z0-9_]*, got ${JSON.stringify(name)}`);
  }
}

export interface PostgresCoordinatorOptions {
  /**
   * A `pg` (node-postgres) pool — or any object satisfying `PgPoolLike`
   * from `src/postgres/store.ts`. ThrottleKit holds the pool but does NOT
   * close it; call `pool.end()` in your shutdown hook.
   */
  pool: PgPoolLike;
  /**
   * Window length in ms — MUST match the strategy's `windowMs` you
   * federate. Used to derive the active window's `expiresAt` from server
   * time so reconcile can detect window roll and reinitialize.
   */
  windowMs: number;
  /** Default per-window budget for any key without an override. Default 1000. */
  budgetPerWindow?: number;
  /** Postgres table name (created on first use). Default `"tk_fed_state"`. */
  tableName?: string;
  /** Key prefix prepended to every coordinator key. Default `"tk:fed"`. */
  prefix?: string;
  /**
   * Background-GC sweep interval in ms. Default 60_000. Pass 0 to disable
   * the timer (useful in tests or when running pg_cron server-side).
   */
  gcIntervalMs?: number;
  /**
   * Dormancy threshold for GC: rows untouched for this long are deleted.
   * Default 86_400_000 (24h).
   */
  gcRetentionMs?: number;
  /**
   * Use Postgres `clock_timestamp()` for the `now` anchoring. Default
   * `true` — node clock skew is then irrelevant for the federation bound.
   * Set `false` in deterministic tests that pass an explicit `now` via
   * `setNowForTest`.
   */
  useServerTime?: boolean;
}

/**
 * The Postgres-backed `GlobalCoordinator`. Mirrors `RedisCoordinator`'s
 * surface 1:1 — same `lease` / `reconcile` semantics, same `setBudget`
 * override knob. The only operational difference is `close()`, which stops
 * the background GC interval (no analog on the Redis side because PEXPIRE
 * handles cleanup).
 */
export class PostgresCoordinator implements GlobalCoordinator {
  readonly #pool: PgPoolLike;
  readonly #defaultBudget: number;
  readonly #tableName: string;
  readonly #prefix: string;
  readonly #windowMs: number;
  readonly #useServerTime: boolean;
  readonly #gcIntervalMs: number;
  readonly #gcRetentionMs: number;
  readonly #perKeyBudget = new Map<string, number>();
  #gcTimer: ReturnType<typeof setInterval> | null = null;
  #schemaInit: Promise<void> | null = null;
  #closed = false;

  constructor(options: PostgresCoordinatorOptions) {
    if (!Number.isFinite(options.windowMs) || options.windowMs < 1) {
      throw new RangeError(
        `windowMs must be a finite number >= 1, got ${String(options.windowMs)}`,
      );
    }
    if (
      options.budgetPerWindow !== undefined &&
      (!Number.isFinite(options.budgetPerWindow) || options.budgetPerWindow < 1)
    ) {
      throw new RangeError(
        `budgetPerWindow must be a finite number >= 1, got ${String(options.budgetPerWindow)}`,
      );
    }
    const tableName = options.tableName ?? DEFAULT_TABLE;
    assertSafeIdentifier(tableName, "tableName");

    this.#pool = options.pool;
    this.#windowMs = options.windowMs;
    this.#defaultBudget = options.budgetPerWindow ?? DEFAULT_BUDGET;
    this.#tableName = tableName;
    this.#prefix = options.prefix ?? DEFAULT_PREFIX;
    this.#useServerTime = options.useServerTime ?? true;
    this.#gcIntervalMs = options.gcIntervalMs ?? DEFAULT_GC_INTERVAL_MS;
    this.#gcRetentionMs = options.gcRetentionMs ?? DEFAULT_GC_RETENTION_MS;

    if (this.#gcIntervalMs > 0) {
      this.#startGc();
    }
  }

  /** Override the per-window budget for a specific key. In-memory only. */
  setBudget(key: string, budgetPerWindow: number): void {
    if (!Number.isFinite(budgetPerWindow) || budgetPerWindow < 1) {
      throw new RangeError(
        `budgetPerWindow must be a finite number >= 1, got ${String(budgetPerWindow)}`,
      );
    }
    this.#perKeyBudget.set(key, budgetPerWindow);
  }

  /** The configured per-key budget (override > default). */
  budgetFor(key: string): number {
    return this.#perKeyBudget.get(key) ?? this.#defaultBudget;
  }

  async lease(key: string, tokens: number, _expiresAt: number): Promise<number> {
    if (!Number.isFinite(tokens) || tokens < 0) {
      throw new RangeError(
        `lease tokens must be a non-negative finite number, got ${String(tokens)}`,
      );
    }
    if (tokens === 0) return 0;
    return (await this.#leaseImpl(key, tokens)).granted;
  }

  /**
   * Lease + return the authoritative window boundary the budget drained against (the
   * `clock_timestamp()`-derived `expiresAt`, NOT a node-clock value), so a Tier-2 client discards leftover
   * credits at exactly that instant — closing the node↔store skew gap {@link lease}'s ignored `expiresAt` leaves.
   */
  async leaseWindowed(
    key: string,
    tokens: number,
  ): Promise<{ granted: number; expiresAt: number }> {
    if (!Number.isFinite(tokens) || tokens < 0) {
      throw new RangeError(
        `lease tokens must be a non-negative finite number, got ${String(tokens)}`,
      );
    }
    return this.#leaseImpl(key, tokens);
  }

  async #leaseImpl(key: string, tokens: number): Promise<{ granted: number; expiresAt: number }> {
    await this.#ensureSchema();

    const pgKey = `${this.#prefix}:${key}`;
    const perKeyBudget = this.budgetFor(key);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");

      const nowMs = await this.#readNow(client);
      const windowStart = Math.floor(nowMs / this.#windowMs) * this.#windowMs;
      const expiresAt = windowStart + this.#windowMs;

      // Upsert: initialize OR roll the window in place.
      await client.query(
        `INSERT INTO ${this.#tableName} (key, budget, expires_at, reconciled_markers, updated_at)
         VALUES ($1, $2, $3, '{}'::bigint[], $4)
         ON CONFLICT (key) DO UPDATE
           SET budget = CASE
                 WHEN ${this.#tableName}.expires_at <> EXCLUDED.expires_at
                   THEN EXCLUDED.budget
                 ELSE ${this.#tableName}.budget
               END,
               expires_at = EXCLUDED.expires_at,
               reconciled_markers = CASE
                 WHEN ${this.#tableName}.expires_at <> EXCLUDED.expires_at
                   THEN '{}'::bigint[]
                 ELSE ${this.#tableName}.reconciled_markers
               END,
               updated_at = EXCLUDED.updated_at`,
        [pgKey, perKeyBudget, expiresAt, nowMs],
      );

      // Lock + read the now-fresh budget.
      const lockResult = await client.query(
        `SELECT budget FROM ${this.#tableName} WHERE key = $1 FOR UPDATE`,
        [pgKey],
      );
      const row = lockResult.rows[0] as { budget: string | number } | undefined;
      if (row === undefined) {
        // Cannot happen — the upsert above guarantees a row. Defensive.
        throw new Error("internal: tk_fed_state row missing after upsert");
      }
      const currentBudget = Number(row.budget);

      const granted = Math.min(tokens, currentBudget);
      if (granted > 0) {
        await client.query(
          `UPDATE ${this.#tableName}
           SET budget = budget - $2, updated_at = $3
           WHERE key = $1`,
          [pgKey, granted, nowMs],
        );
      }

      await client.query("COMMIT");
      return { granted, expiresAt };
    } catch (err) {
      await this.#safeRollback(client);
      throw new StoreUnavailableError(
        `PostgresCoordinator.lease failed for key "${key}": ${(err as Error).message}`,
        { cause: err },
      );
    } finally {
      client.release();
    }
  }

  async reconcile(key: string, leftover: number, windowStart: number): Promise<void> {
    if (!Number.isFinite(leftover) || leftover < 0) {
      throw new RangeError(`reconcile leftover must be non-negative, got ${String(leftover)}`);
    }
    if (leftover === 0) return;

    await this.#ensureSchema();

    const pgKey = `${this.#prefix}:${key}`;
    const perKeyBudget = this.budgetFor(key);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");

      const nowMs = await this.#readNow(client);
      const currentWindowStart = Math.floor(nowMs / this.#windowMs) * this.#windowMs;
      const currentExpiresAt = currentWindowStart + this.#windowMs;

      // Window-coupling guard: forfeit leftover whose window has already rolled — crediting it into a
      // later, already-draining window would let cumulative admissions exceed the budget (breaking the
      // federation's admitted <= Limit bound). Only an in-window reconcile (windowStart === current, a
      // boundary/skew race) restores budget. Matches the formal Roll expiring escrow. A pure no-op.
      if (windowStart !== currentWindowStart) {
        await client.query("COMMIT");
        return;
      }

      // Upsert: initialize OR roll the window — same shape as lease().
      await client.query(
        `INSERT INTO ${this.#tableName} (key, budget, expires_at, reconciled_markers, updated_at)
         VALUES ($1, $2, $3, '{}'::bigint[], $4)
         ON CONFLICT (key) DO UPDATE
           SET budget = CASE
                 WHEN ${this.#tableName}.expires_at <> EXCLUDED.expires_at
                   THEN EXCLUDED.budget
                 ELSE ${this.#tableName}.budget
               END,
               expires_at = EXCLUDED.expires_at,
               reconciled_markers = CASE
                 WHEN ${this.#tableName}.expires_at <> EXCLUDED.expires_at
                   THEN '{}'::bigint[]
                 ELSE ${this.#tableName}.reconciled_markers
               END,
               updated_at = EXCLUDED.updated_at`,
        [pgKey, perKeyBudget, currentExpiresAt, nowMs],
      );

      // Lock + read budget + idempotency check.
      const lockResult = await client.query(
        `SELECT budget, $2::bigint = ANY(reconciled_markers) AS already
         FROM ${this.#tableName} WHERE key = $1 FOR UPDATE`,
        [pgKey, windowStart],
      );
      const row = lockResult.rows[0] as { budget: string | number; already: boolean } | undefined;
      if (row === undefined) {
        throw new Error("internal: tk_fed_state row missing after upsert");
      }
      if (row.already) {
        await client.query("COMMIT");
        return;
      }
      const currentBudget = Number(row.budget);
      const newBudget = Math.min(perKeyBudget, currentBudget + leftover);

      await client.query(
        `UPDATE ${this.#tableName}
         SET budget = $2,
             reconciled_markers = array_append(reconciled_markers, $3::bigint),
             updated_at = $4
         WHERE key = $1`,
        [pgKey, newBudget, windowStart, nowMs],
      );

      await client.query("COMMIT");
    } catch (err) {
      await this.#safeRollback(client);
      throw new StoreUnavailableError(
        `PostgresCoordinator.reconcile failed for key "${key}": ${(err as Error).message}`,
        { cause: err },
      );
    } finally {
      client.release();
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.#pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  /** Stop the background GC interval. Idempotent. */
  close(): void {
    this.#closed = true;
    if (this.#gcTimer !== null) {
      clearInterval(this.#gcTimer);
      this.#gcTimer = null;
    }
  }

  // ---- internals ----

  async #readNow(client: { query: PgPoolLike["query"] }): Promise<number> {
    if (!this.#useServerTime) return Date.now();
    const result = await client.query(
      "SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms",
    );
    const row = result.rows[0] as { now_ms: string | number } | undefined;
    if (row === undefined) {
      throw new Error("internal: clock_timestamp() returned no row");
    }
    return Number(row.now_ms);
  }

  async #safeRollback(client: { query: PgPoolLike["query"] }): Promise<void> {
    try {
      await client.query("ROLLBACK");
    } catch {
      // already aborted or connection lost — nothing to do
    }
  }

  async #ensureSchema(): Promise<void> {
    if (this.#schemaInit === null) {
      this.#schemaInit = this.#createSchema();
    }
    return this.#schemaInit;
  }

  async #createSchema(): Promise<void> {
    await this.#pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.#tableName} (
         key                TEXT     PRIMARY KEY,
         budget             BIGINT   NOT NULL,
         expires_at         BIGINT   NOT NULL,
         reconciled_markers BIGINT[] NOT NULL DEFAULT '{}'::bigint[],
         updated_at         BIGINT   NOT NULL
       )`,
    );
    await this.#pool.query(
      `CREATE INDEX IF NOT EXISTS ${this.#tableName}_expires_idx
         ON ${this.#tableName} (expires_at)`,
    );
  }

  #startGc(): void {
    const t = setInterval(() => {
      void this.#runGcSweep();
    }, this.#gcIntervalMs);
    // Don't block process exit on the GC timer.
    if (typeof (t as { unref?: () => void }).unref === "function") {
      (t as { unref: () => void }).unref();
    }
    this.#gcTimer = t;
  }

  async #runGcSweep(): Promise<void> {
    if (this.#closed) return;
    if (this.#schemaInit === null) return; // schema not yet initialized — nothing to GC
    try {
      const cutoff = Date.now() - this.#gcRetentionMs;
      await this.#pool.query(
        `DELETE FROM ${this.#tableName} WHERE updated_at < $1 AND expires_at < $1`,
        [cutoff],
      );
    } catch {
      // GC failures are non-fatal — try again next interval.
    }
  }
}
