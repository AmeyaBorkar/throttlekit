import { systemClock } from "../core/clock";
import { StoreUnavailableError } from "../core/errors";
import { prefixer } from "../core/key";
import type { Clock, Store, Transform } from "../core/types";

/**
 * The minimal slice of a Cloudflare **D1** database binding ThrottleKit needs. The `D1Database` your
 * Worker receives in `env` satisfies this structurally, so you pass it directly — no
 * `@cloudflare/workers-types` dependency. Any compatible binding (same method shapes) works too.
 */
export interface D1Like {
  /** Build a prepared statement for one SQL statement (D1 is single-statement per prepare). */
  prepare(query: string): D1PreparedStatementLike;
}

/** A D1 prepared statement: bind positional `?` params, then read one row or run the write. */
export interface D1PreparedStatementLike {
  /** Bind positional parameters, returning a bound statement (D1 returns a fresh statement). */
  bind(...values: unknown[]): D1PreparedStatementLike;
  /** Return the first row (or `null`) of a query. */
  first<T = Record<string, unknown>>(): Promise<T | null>;
  /** Execute a write and report how many rows changed via {@link D1ResultLike.meta}. */
  run(): Promise<D1ResultLike>;
}

/** The slice of a D1 run-result ThrottleKit reads: just the changed-row count from `meta`. */
export interface D1ResultLike {
  /** Number of rows the statement changed — `1` means our conditional write committed. */
  meta?: { changes?: number };
}

/** The row shape stored per key: JSON-encoded state, an epoch-ms expiry, and the CAS version. */
interface StoredRow {
  /** `JSON.stringify(state)` — same encoding as every other backend, for cross-backend bit-identity. */
  state: string;
  /** Epoch-ms at which the row expires (a past value reads as absent). */
  expires_at: number;
  /** Monotonic version bumped on every write; the optimistic-concurrency compare-and-set token. */
  version: number;
}

export interface D1StoreOptions {
  /** A Cloudflare `D1Database` binding (or compatible). ThrottleKit never closes a binding it is given. */
  db: D1Like;
  /**
   * Unquoted table identifier holding the limiter state. Validated against `^[A-Za-z_][A-Za-z0-9_]*$`
   * since identifiers cannot be parameterized. Default `"throttlekit"`.
   */
  table?: string;
  /** Storage key namespace, prefixed as `prefix:key`. */
  prefix?: string;
  /**
   * Create the table and its expiry index on first use. Default `true`. Set `false` when you manage
   * the schema via wrangler D1 migrations (see {@link D1Store} docs for the DDL).
   */
  autoCreate?: boolean;
  /**
   * Bounded retries for the optimistic-concurrency compare-and-set. Default `16`. In-process applies
   * to one key are coalesced (see {@link D1Store}), so retries are only ever spent on genuine
   * *cross-isolate* races; `16` tolerates heavy cross-isolate contention on a single hot key.
   */
  maxRetries?: number;
  /**
   * Time source for lazy expiry. Expired rows are filtered on read and reclaimed by {@link D1Store.sweep},
   * so this is the clock that decides "expired". Defaults to {@link systemClock}; inject a `ManualClock`
   * to drive expiry deterministically in tests.
   */
  clock?: Clock;
}

/** A plain SQL identifier (D1/SQLite table name); cannot be parameterized, so it is regex-validated. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A resolved, never-rejecting promise used to seed the per-key serialization chain. */
const RESOLVED: Promise<void> = Promise.resolve();

/**
 * Distributed store backed by **Cloudflare D1** (edge SQLite) — the right SQL backend for limiting on
 * Workers when you are not using a Durable Object.
 *
 * Unlike Postgres (transaction-scoped advisory lock) or a Durable Object (single-threaded actor), D1
 * exposes neither a per-key lock nor an interactive transaction across `await` points, so the atomic
 * read-modify-write {@link Store.apply} demands is built from **optimistic concurrency** with a
 * version compare-and-set:
 *
 * ```text
 *   SELECT state, expires_at, version WHERE key = ?     -- read; lazy-expire in JS
 *   <run transform(state) in JS>                        -- the same pure code every backend runs
 *   UPDATE ... SET version = version + 1 WHERE key = ? AND version = ?   -- commit iff unchanged
 *   -- (or INSERT ... ON CONFLICT DO NOTHING on first touch); changes = 0 ⇒ lost the race ⇒ retry
 * ```
 *
 * The version check makes the write conditional: if another isolate wrote between our read and our
 * write, the `WHERE version = ?` matches nothing (`changes = 0`) and we re-read and retry. So N
 * concurrent increments across the fleet land exactly N — like Redis `INCR` — without ever holding a
 * lock. An expired row is overwritten in place by that same CAS (its stale version still matches what
 * we read), so expiry needs no separate delete on the hot path.
 *
 * **In-process coalescing.** D1 has no Lua/atomic-command path, so *every* apply takes the CAS loop —
 * and a hot key hammered from one isolate would otherwise CAS-contend with itself and burn retries
 * (and D1 bills per row read/written). So applies to the same key *from this isolate* are serialized
 * behind a per-key promise chain: each runs a single clean version bump, zero wasted retries. The CAS
 * still guarantees correctness across *other* isolates; coalescing just collapses self-contention. The
 * chain entry is dropped once it drains, so the lock map stays bounded by in-flight keys.
 *
 * **Expiry** is lazy: a row past its `expires_at` reads as absent (the next apply starts fresh),
 * keyed off this store's {@link Clock} exactly like the Redis/Postgres backends. Workers are
 * ephemeral, so there is no background sweep timer; call {@link D1Store.sweep} from a
 * [Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/) to reclaim
 * space. Lazy expiry already keeps every read correct without one.
 *
 * **State** is the same JSON text the Redis optimistic-concurrency and Postgres paths write, so a
 * value round-trips as the exact IEEE-754 double and decisions stay bit-identical across backends.
 *
 * **Schema** (auto-created unless {@link D1StoreOptions.autoCreate} is `false`):
 * ```sql
 * CREATE TABLE IF NOT EXISTS throttlekit (
 *   key TEXT PRIMARY KEY, state TEXT NOT NULL, expires_at INTEGER NOT NULL, version INTEGER NOT NULL);
 * CREATE INDEX IF NOT EXISTS throttlekit_expires_idx ON throttlekit (expires_at);
 * ```
 *
 * Async-only: there is no `applySync`, so `limiter.checkSync` throws (use `await limiter.check`).
 *
 * @example
 * ```ts
 * import { rateLimit, gcra } from "throttlekit";
 * import { D1Store } from "throttlekit/cloudflare";
 *
 * export default {
 *   async fetch(req: Request, env: { DB: D1Database }) {
 *     const limiter = rateLimit({
 *       strategy: gcra({ limit: 100, periodMs: 60_000, burst: 20 }),
 *       store: new D1Store({ db: env.DB }),
 *     });
 *     const d = await limiter.check(new URL(req.url).pathname);
 *     return Response.json(d, { status: d.allowed ? 200 : 429 });
 *   },
 * };
 * ```
 */
export class D1Store implements Store {
  readonly #db: D1Like;
  readonly #prefixKey: (key: string) => string;
  readonly #clock: Clock;
  readonly #autoCreate: boolean;
  readonly #maxRetries: number;
  /** Pre-built statements (the table name is a validated identifier, interpolated once). */
  readonly #sqlSelect: string;
  readonly #sqlCas: string;
  readonly #sqlInsert: string;
  readonly #sqlDelete: string;
  readonly #sqlSweep: string;
  readonly #sqlCreateTable: string;
  readonly #sqlCreateIndex: string;
  /** Memoized schema setup so auto-create runs at most once per store. */
  #ready: Promise<void> | undefined;
  /** Per-key serialization tails: collapse same-isolate contention so the CAS only sees real races. */
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(options: D1StoreOptions) {
    const table = options.table ?? "throttlekit";
    if (!IDENT.test(table)) {
      throw new Error(`D1Store: invalid table identifier ${JSON.stringify(table)}`);
    }
    this.#db = options.db;
    this.#prefixKey = prefixer(options.prefix);
    this.#clock = options.clock ?? systemClock;
    this.#autoCreate = options.autoCreate ?? true;
    this.#maxRetries = options.maxRetries ?? 16;

    const t = table;
    this.#sqlSelect = `SELECT state, expires_at, version FROM ${t} WHERE key = ?`;
    this.#sqlCas = `UPDATE ${t} SET state = ?, expires_at = ?, version = version + 1 WHERE key = ? AND version = ?`;
    this.#sqlInsert = `INSERT INTO ${t} (key, state, expires_at, version) VALUES (?, ?, ?, 0) ON CONFLICT(key) DO NOTHING`;
    this.#sqlDelete = `DELETE FROM ${t} WHERE key = ?`;
    this.#sqlSweep = `DELETE FROM ${t} WHERE expires_at <= ?`;
    this.#sqlCreateTable = `CREATE TABLE IF NOT EXISTS ${t} (key TEXT PRIMARY KEY, state TEXT NOT NULL, expires_at INTEGER NOT NULL, version INTEGER NOT NULL)`;
    this.#sqlCreateIndex = `CREATE INDEX IF NOT EXISTS ${t}_expires_idx ON ${t} (expires_at)`;
  }

  /** Create the table + index once (memoized). No-op when {@link D1StoreOptions.autoCreate} is false. */
  #ensureSchema(): Promise<void> {
    if (!this.#autoCreate) return RESOLVED;
    if (this.#ready === undefined) {
      this.#ready = (async (): Promise<void> => {
        await this.#db.prepare(this.#sqlCreateTable).run();
        await this.#db.prepare(this.#sqlCreateIndex).run();
      })().then(undefined, (err: unknown) => {
        // A failed create leaves the store un-initialized; let the next apply retry.
        this.#ready = undefined;
        throw err;
      });
    }
    return this.#ready;
  }

  /**
   * Serialize `fn` against other in-process calls for the same key via a promise chain, so two
   * applies from this isolate never CAS-contend with each other. The chain tail is dropped once it
   * drains with nothing queued behind it, bounding the lock map by in-flight keys.
   */
  #withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(key) ?? RESOLVED;
    const run = prev.then(fn, fn); // run after prev settles, regardless of its outcome
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#locks.set(key, tail);
    void tail.then(() => {
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    });
    return run;
  }

  async apply<S, R>(key: string, transform: Transform<S, R>): Promise<R> {
    await this.#ensureSchema();
    const fullKey = this.#prefixKey(key);
    return this.#withKeyLock(fullKey, () => this.#applyCas(fullKey, transform));
  }

  /** Optimistic read-modify-write: read state + version, run the transform, commit iff unchanged. */
  async #applyCas<S, R>(fullKey: string, transform: Transform<S, R>): Promise<R> {
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      const now = Math.floor(this.#clock.now());
      const row = await this.#db.prepare(this.#sqlSelect).bind(fullKey).first<StoredRow>();

      // `version` is defined iff a row physically exists (live or expired) — it drives CAS vs INSERT
      // and is the compare token. An expired row yields `undefined` state so the transform restarts,
      // but is still overwritten in place via its stale version (no separate delete).
      let state: S | undefined;
      let version: number | undefined;
      if (row !== null) {
        version = row.version;
        state = row.expires_at > now ? (JSON.parse(row.state) as S) : undefined;
      }

      const out = transform(state);
      if (!out.persist) return out.result;

      const ttl = Math.max(1, Math.ceil(out.ttlMs));
      const expiresAt = now + ttl;
      const encoded = JSON.stringify(out.state);

      const res =
        version !== undefined
          ? await this.#db.prepare(this.#sqlCas).bind(encoded, expiresAt, fullKey, version).run()
          : await this.#db.prepare(this.#sqlInsert).bind(fullKey, encoded, expiresAt).run();

      // changes === 1 ⇒ our conditional write committed. 0 ⇒ another isolate beat us; re-read.
      if ((res.meta?.changes ?? 0) === 1) return out.result;
    }
    throw new StoreUnavailableError(
      `D1Store: optimistic concurrency exhausted ${this.#maxRetries} retries`,
    );
  }

  async reset(key: string): Promise<void> {
    await this.#ensureSchema();
    await this.#db.prepare(this.#sqlDelete).bind(this.#prefixKey(key)).run();
  }

  /**
   * Delete every row already past its expiry, returning how many were reclaimed. Lazy expiry keeps
   * reads correct without this; call it from a Cron Trigger only to reclaim storage. Best-effort —
   * a failure just delays reclamation.
   */
  async sweep(): Promise<number> {
    await this.#ensureSchema();
    const res = await this.#db.prepare(this.#sqlSweep).bind(Math.floor(this.#clock.now())).run();
    return res.meta?.changes ?? 0;
  }
}
