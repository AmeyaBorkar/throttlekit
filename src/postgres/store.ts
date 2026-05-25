import { systemClock } from "../core/clock";
import type { Clock, Store, Transform } from "../core/types";

/**
 * The minimal slice of a `pg` (node-postgres) connection pool ThrottleKit needs. A `pg.Pool`
 * satisfies this structurally, so you pass one directly — no adapter. Any compatible pool (same
 * method shapes) works too.
 */
export interface PgPoolLike {
  /** Acquire a dedicated client for a multi-statement transaction. */
  connect(): Promise<PgClientLike>;
  /** Run a single statement on a pooled connection (used for schema setup, reset, and sweeps). */
  query(text: string, values?: unknown[]): Promise<PgQueryResultLike>;
}

/** A checked-out pool client. Mirrors `pg`'s `PoolClient`. */
export interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<PgQueryResultLike>;
  /** Return the client to the pool. Pass a truthy arg to destroy a broken connection. */
  release(err?: unknown): void;
}

/** The slice of a `pg` query result we read: just the rows. */
export interface PgQueryResultLike {
  rows: unknown[];
}

export interface PostgresStoreOptions {
  /** A `pg.Pool` (or compatible). ThrottleKit never ends a pool it does not own. */
  pool: PgPoolLike;
  /**
   * Unquoted table identifier holding the limiter state. Validated against
   * `^[A-Za-z_][A-Za-z0-9_]*$` (optionally `schema.table`) since identifiers cannot be
   * parameterized. Default `"throttlekit"`.
   */
  table?: string;
  /** Storage key namespace, prefixed as `prefix:key`. */
  prefix?: string;
  /** Create the table and its expiry index on first use. Default `true`. */
  autoCreate?: boolean;
  /**
   * Interval in ms for the background sweep that reclaims expired rows. `0` disables it (rely on
   * lazy expiry — expired rows are already invisible to reads). Default `60_000`.
   */
  sweepIntervalMs?: number;
  /**
   * Time source for expiry. Expired rows are filtered on read and reclaimed by the sweep, so this
   * is the clock that decides "expired". Defaults to {@link systemClock}; inject a `ManualClock` to
   * drive expiry deterministically in tests.
   */
  clock?: Clock;
}

/** A `schema.table` or bare `table` identifier, each part a plain SQL identifier. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 * Distributed store backed by PostgreSQL — no Redis required.
 *
 * Every backend implements one primitive, {@link Store.apply}: an atomic read-modify-write. This
 * store runs the limiter's **existing pure JS transform** (the same code the in-memory store runs;
 * there is no Postgres-specific algorithm to keep in sync) inside a transaction, serialized per key
 * by a transaction-scoped **advisory lock**:
 *
 * ```text
 *   BEGIN
 *   SELECT pg_advisory_xact_lock(hashtextextended(key, 0))   -- per-key critical section
 *   SELECT state WHERE key = $1 AND expires_at > now          -- lazy expiry on read
 *   <run transform(state) in JS>
 *   INSERT .. ON CONFLICT (key) DO UPDATE                     -- persist if the transform asks
 *   COMMIT                                                    -- releases the advisory lock
 * ```
 *
 * The advisory lock (not `SELECT … FOR UPDATE`) is deliberate: `FOR UPDATE` cannot lock a row that
 * does not exist yet, so two first-touch transactions on a new key could race; an advisory lock
 * keyed by the key's hash serializes them whether or not the row exists, and auto-releases at
 * `COMMIT`/`ROLLBACK` so an error can never leak it. (Hash collisions only over-serialize unrelated
 * keys very rarely — correctness is unaffected.) This makes concurrent applies on one key atomic:
 * N concurrent increments land exactly N, like Redis.
 *
 * **State** is stored as the same JSON text the Redis optimistic-concurrency path writes, so a
 * double round-trips as the exact IEEE-754 value and decisions stay bit-identical across backends.
 *
 * **Expiry** mirrors how Redis actually behaves: expiry is keyed off this store's {@link Clock}
 * (Redis uses its *server* clock), independent of the limiter's `now`. That is safe because every
 * built-in strategy is idempotent w.r.t. stale state — a TAT in the past clamps to `now`, a bucket
 * refills, a window resets — so a slightly-late expiry can never change a decision. Expired rows
 * are invisible to reads immediately; the sweep just reclaims their space.
 *
 * Async-only: there is no `applySync`, so `limiter.checkSync` throws (use `await limiter.check`).
 */
export class PostgresStore implements Store {
  readonly #pool: PgPoolLike;
  readonly #prefix: string;
  readonly #clock: Clock;
  readonly #autoCreate: boolean;
  /** Pre-built statements (table name is a validated identifier, interpolated once). */
  readonly #sqlSelect: string;
  readonly #sqlUpsert: string;
  readonly #sqlDelete: string;
  readonly #sqlSweep: string;
  readonly #sqlCreate: string;
  /** Memoized schema setup so auto-create runs at most once per store. */
  #ready: Promise<void> | undefined;
  #sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: PostgresStoreOptions) {
    const table = options.table ?? "throttlekit";
    if (!IDENT.test(table)) {
      throw new Error(`PostgresStore: invalid table identifier ${JSON.stringify(table)}`);
    }
    this.#pool = options.pool;
    this.#prefix = options.prefix ?? "";
    this.#clock = options.clock ?? systemClock;
    this.#autoCreate = options.autoCreate ?? true;

    const t = table;
    const idx = `${table.replace(".", "_")}_expires_idx`;
    this.#sqlCreate = `CREATE TABLE IF NOT EXISTS ${t} (key TEXT PRIMARY KEY, state TEXT NOT NULL, expires_at BIGINT NOT NULL); CREATE INDEX IF NOT EXISTS ${idx} ON ${t} (expires_at)`;
    this.#sqlSelect = `SELECT state FROM ${t} WHERE key = $1 AND expires_at > $2`;
    this.#sqlUpsert = `INSERT INTO ${t} (key, state, expires_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET state = EXCLUDED.state, expires_at = EXCLUDED.expires_at`;
    this.#sqlDelete = `DELETE FROM ${t} WHERE key = $1`;
    this.#sqlSweep = `DELETE FROM ${t} WHERE expires_at <= $1`;

    const sweepMs = options.sweepIntervalMs ?? 60_000;
    if (sweepMs > 0) {
      this.#sweepTimer = setInterval(() => {
        void this.#sweep();
      }, sweepMs);
      // Don't keep the event loop alive just for sweeps.
      this.#sweepTimer.unref?.();
    }
  }

  #key(key: string): string {
    return this.#prefix.length > 0 ? `${this.#prefix}:${key}` : key;
  }

  /** Create the table + index once (memoized). No-op when {@link PostgresStoreOptions.autoCreate} is false. */
  #ensureSchema(): Promise<void> {
    if (!this.#autoCreate) return Promise.resolve();
    if (this.#ready === undefined) {
      this.#ready = this.#pool.query(this.#sqlCreate).then(
        () => undefined,
        (err: unknown) => {
          // A concurrent CREATE … IF NOT EXISTS can still collide; let the next apply retry.
          this.#ready = undefined;
          throw err;
        },
      );
    }
    return this.#ready;
  }

  async apply<S, R>(key: string, transform: Transform<S, R>): Promise<R> {
    await this.#ensureSchema();
    const fullKey = this.#key(key);
    const now = Math.floor(this.#clock.now());

    const client = await this.#pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      // Per-key critical section; released automatically when the transaction ends.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [fullKey]);

      const sel = await client.query(this.#sqlSelect, [fullKey, now]);
      const row = sel.rows[0] as { state: string } | undefined;
      const state = row !== undefined ? (JSON.parse(row.state) as S) : undefined;

      const out = transform(state);

      if (out.persist) {
        const ttl = Math.max(1, Math.ceil(out.ttlMs));
        await client.query(this.#sqlUpsert, [fullKey, JSON.stringify(out.state), now + ttl]);
      }

      await client.query("COMMIT");
      return out.result;
    } catch (err) {
      // Roll back the aborted transaction. If even ROLLBACK fails the connection is broken, so
      // mark it for destruction on release rather than returning a poisoned client to the pool.
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true;
      }
      throw err;
    } finally {
      // release(truthy) destroys the connection; release(undefined) returns it to the pool.
      client.release(
        broken ? new Error("throttlekit: discarding connection after failed rollback") : undefined,
      );
    }
  }

  async reset(key: string): Promise<void> {
    await this.#ensureSchema();
    await this.#pool.query(this.#sqlDelete, [this.#key(key)]);
  }

  /** Delete every row already past its expiry. Best-effort; errors are swallowed. */
  async #sweep(): Promise<void> {
    try {
      await this.#ensureSchema();
      await this.#pool.query(this.#sqlSweep, [Math.floor(this.#clock.now())]);
    } catch {
      // A failed sweep only delays space reclamation; lazy expiry keeps reads correct.
    }
  }

  /** Stop the background sweep. Does not end the pool (ThrottleKit does not own it). */
  async close(): Promise<void> {
    if (this.#sweepTimer !== undefined) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = undefined;
    }
  }
}
