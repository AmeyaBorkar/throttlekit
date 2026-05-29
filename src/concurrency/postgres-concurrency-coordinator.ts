/**
 * `PostgresConcurrencyCoordinator` — a `ConcurrencyCoordinator` backed by a single Postgres
 * primary; the event-release sibling of the federation `PostgresCoordinator` (0.8.4) and a
 * drop-in alternative to `RedisConcurrencyCoordinator` (TK-1402).
 *
 * It runs the SAME heartbeat-aggregate-cap compute as the in-memory reference — the shared
 * pure {@link applyHeartbeat} (`heartbeat-core`) — inside one `pg_advisory_xact_lock`
 * transaction, so it is STRUCTURALLY conformant with `TestConcurrencyCoordinator` (not a
 * separate transcription). Per heartbeat: lock the key, load its node rows, run
 * `applyHeartbeat` (upsert self, evict expired, aggregate, TARGET, CAP, record), then persist
 * the post-state — delete the rows it evicted and upsert self. No other live node's row is
 * touched (the compute mutates only self + evictions), mirroring the Redis Lua's write shape.
 *
 * Layout — one row per `(key, node_id)` in `tk_conc_state`:
 *
 *     key, node_id          : PK
 *     l_local, inflight, expires_at, share : the live report + granted share
 *     committed_gen, max_seq, unacked_high : acknowledged-handoff bookkeeping (D-DAC-19)
 *     updated_at            : last-touch epoch-ms (GC)
 *
 * Server-time anchoring via `clock_timestamp()` (NOT `current_timestamp`, which is the txn
 * start time). **SPOF**: a single Postgres primary is a single point of failure — mitigate
 * with synchronous replication + automated failover; during failover, guards fall back to
 * their `onCoordinatorOutage` mode. See research/.../distributed-adaptive-concurrency/DESIGN.md
 * §5.3 + §14.2.
 */

import { StoreUnavailableError } from "../core/errors";
import type { PgPoolLike } from "../postgres/store";
import type { ConcurrencyCoordinator, ConcurrencyGrant, ConcurrencyReport } from "./coordinator";
import { type NodeRecord, applyHeartbeat } from "./heartbeat-core";

const DEFAULT_TABLE = "tk_conc_state";
const DEFAULT_PREFIX = "tk:fed";
const DEFAULT_GC_INTERVAL_MS = 60_000;
const DEFAULT_GC_RETENTION_MS = 86_400_000; // 24h

/** SQL identifier validator — table names can't be parameterized, so accept a conservative shape. */
function assertSafeIdentifier(name: string, what: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new RangeError(`${what} must match [a-zA-Z_][a-zA-Z0-9_]*, got ${JSON.stringify(name)}`);
  }
}

export interface PostgresConcurrencyCoordinatorOptions {
  /** A `pg` (node-postgres) pool — or any `PgPoolLike`. ThrottleKit holds it but never closes it. */
  pool: PgPoolLike;
  /**
   * Fleet-wide aggregation rule folding live nodes' `lLocal` into `L_global` (§7). `"median"`
   * (default) takes the lower median; `"min"` the minimum. Every node on a key MUST agree (D-DAC-8).
   */
  aggregate?: "min" | "median";
  /**
   * Capacity ALLOCATION rule (D-DAC-9 / D-DAC-22). `"equal-split"` (default) or
   * `"demand-proportional"` (skew-aware). All nodes/coordinators on a key MUST agree.
   */
  allocation?: "equal-split" | "demand-proportional";
  /**
   * ACKNOWLEDGED HANDOFF (D-DAC-19) — opt-in, default `false`. Reserves each peer's max
   * un-acknowledged grant, making `Σ inflight ≤ L_global` a hard async bound at a ramp-latency
   * cost. All nodes/coordinators on a key MUST agree; enable only once every guard echoes `appliedGen`.
   */
  acknowledgedHandoff?: boolean;
  /** Postgres table name (created on first use). Default `"tk_conc_state"`. */
  tableName?: string;
  /** Key prefix prepended to every coordinator key. Default `"tk:fed"`. */
  prefix?: string;
  /** Background-GC sweep interval in ms. Default 60_000. Pass 0 to disable the timer. */
  gcIntervalMs?: number;
  /** Dormancy threshold for GC: rows untouched + expired for this long are deleted. Default 24h. */
  gcRetentionMs?: number;
  /**
   * Use Postgres `clock_timestamp()` for eviction's `now`. Default `true` (node clock skew is
   * then irrelevant). Set `false` in deterministic tests that pin `expiresAt` far in the future.
   */
  useServerTime?: boolean;
}

export class PostgresConcurrencyCoordinator implements ConcurrencyCoordinator {
  readonly #pool: PgPoolLike;
  readonly #aggregate: "min" | "median";
  readonly #allocation: "equal-split" | "demand-proportional";
  readonly #handoff: boolean;
  readonly #tableName: string;
  readonly #prefix: string;
  readonly #useServerTime: boolean;
  readonly #gcIntervalMs: number;
  readonly #gcRetentionMs: number;
  #gcTimer: ReturnType<typeof setInterval> | null = null;
  #schemaInit: Promise<void> | null = null;
  #closed = false;

  constructor(options: PostgresConcurrencyCoordinatorOptions) {
    const tableName = options.tableName ?? DEFAULT_TABLE;
    assertSafeIdentifier(tableName, "tableName");
    this.#pool = options.pool;
    this.#aggregate = options.aggregate ?? "median";
    this.#allocation = options.allocation ?? "equal-split";
    this.#handoff = options.acknowledgedHandoff ?? false;
    this.#tableName = tableName;
    this.#prefix = options.prefix ?? DEFAULT_PREFIX;
    this.#useServerTime = options.useServerTime ?? true;
    this.#gcIntervalMs = options.gcIntervalMs ?? DEFAULT_GC_INTERVAL_MS;
    this.#gcRetentionMs = options.gcRetentionMs ?? DEFAULT_GC_RETENTION_MS;
    if (this.#gcIntervalMs > 0) this.#startGc();
  }

  async heartbeat(report: ConcurrencyReport): Promise<ConcurrencyGrant> {
    await this.#ensureSchema();
    const pgKey = `${this.#prefix}:${report.key}`;
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize all heartbeats for this key (the txn-scoped lock auto-releases at COMMIT) —
      // the SQL analog of the Redis single-EVALSHA atomicity.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [pgKey]);

      const now = await this.#readNow(client);

      // Load all rows for the key (incl. possibly-expired self, so applyHeartbeat can carry
      // its prior share) into the shared compute's state map.
      const res = await client.query(
        `SELECT node_id, l_local, inflight, expires_at, share, committed_gen, max_seq, unacked_high
           FROM ${this.#tableName} WHERE key = $1`,
        [pgKey],
      );
      const state = new Map<string, NodeRecord>();
      for (const r of res.rows as RawRow[]) {
        state.set(r.node_id, {
          lLocal: Number(r.l_local),
          inflight: Number(r.inflight),
          expiresAt: Number(r.expires_at),
          share: Number(r.share),
          committedGen: Number(r.committed_gen),
          maxSeq: Number(r.max_seq),
          unackedHigh: Number(r.unacked_high),
        });
      }

      // THE compute — identical to TestConcurrencyCoordinator (shared source of truth).
      const grant = applyHeartbeat(state, report, now, {
        aggregate: this.#aggregate,
        allocation: this.#allocation,
        handoff: this.#handoff,
      });

      // Persist the post-state: drop the rows applyHeartbeat evicted (expires_at < now), then
      // upsert self (the only record it mutated). Other live nodes are unchanged → no write.
      await client.query(`DELETE FROM ${this.#tableName} WHERE key = $1 AND expires_at < $2`, [
        pgKey,
        now,
      ]);
      const self = state.get(report.nodeId)!;
      await client.query(
        `INSERT INTO ${this.#tableName}
           (key, node_id, l_local, inflight, expires_at, share, committed_gen, max_seq, unacked_high, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (key, node_id) DO UPDATE SET
           l_local = EXCLUDED.l_local, inflight = EXCLUDED.inflight, expires_at = EXCLUDED.expires_at,
           share = EXCLUDED.share, committed_gen = EXCLUDED.committed_gen, max_seq = EXCLUDED.max_seq,
           unacked_high = EXCLUDED.unacked_high, updated_at = EXCLUDED.updated_at`,
        [
          pgKey,
          report.nodeId,
          self.lLocal,
          self.inflight,
          self.expiresAt,
          self.share,
          self.committedGen,
          self.maxSeq,
          self.unackedHigh,
          now,
        ],
      );

      await client.query("COMMIT");
      return grant;
    } catch (err) {
      await this.#safeRollback(client);
      throw new StoreUnavailableError(
        `PostgresConcurrencyCoordinator.heartbeat failed for key "${report.key}": ${(err as Error).message}`,
        { cause: err },
      );
    } finally {
      client.release();
    }
  }

  async leave(args: { key: string; nodeId: string }): Promise<void> {
    await this.#ensureSchema();
    const pgKey = `${this.#prefix}:${args.key}`;
    try {
      await this.#pool.query(`DELETE FROM ${this.#tableName} WHERE key = $1 AND node_id = $2`, [
        pgKey,
        args.nodeId,
      ]);
    } catch (err) {
      throw new StoreUnavailableError(
        `PostgresConcurrencyCoordinator.leave failed for key "${args.key}": ${(err as Error).message}`,
        { cause: err },
      );
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
    if (row === undefined) throw new Error("internal: clock_timestamp() returned no row");
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
    if (this.#schemaInit === null) this.#schemaInit = this.#createSchema();
    return this.#schemaInit;
  }

  async #createSchema(): Promise<void> {
    await this.#pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.#tableName} (
         key           TEXT   NOT NULL,
         node_id       TEXT   NOT NULL,
         l_local       BIGINT NOT NULL,
         inflight      BIGINT NOT NULL,
         expires_at    BIGINT NOT NULL,
         share         BIGINT NOT NULL,
         committed_gen BIGINT NOT NULL DEFAULT 0,
         max_seq       BIGINT NOT NULL DEFAULT 0,
         unacked_high  BIGINT NOT NULL DEFAULT 0,
         updated_at    BIGINT NOT NULL,
         PRIMARY KEY (key, node_id)
       )`,
    );
    await this.#pool.query(
      `CREATE INDEX IF NOT EXISTS ${this.#tableName}_expires_idx ON ${this.#tableName} (expires_at)`,
    );
  }

  #startGc(): void {
    const t = setInterval(() => {
      void this.#runGcSweep();
    }, this.#gcIntervalMs);
    if (typeof (t as { unref?: () => void }).unref === "function") {
      (t as { unref: () => void }).unref();
    }
    this.#gcTimer = t;
  }

  async #runGcSweep(): Promise<void> {
    if (this.#closed || this.#schemaInit === null) return;
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

/** Raw Postgres row shape (bigints arrive as strings via node-postgres). */
interface RawRow {
  node_id: string;
  l_local: string | number;
  inflight: string | number;
  expires_at: string | number;
  share: string | number;
  committed_gen: string | number;
  max_seq: string | number;
  unacked_high: string | number;
}
