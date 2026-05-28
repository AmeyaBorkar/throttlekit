# PostgresCoordinator — design (TK-1301 / 0.8.4)

> Status: design lock for TK-1301. Implementation lands in TK-1302.
> Target release: 0.8.4 (federation completion patch).
> Interface contract: `GlobalCoordinator` from `src/federation/types.ts`
> (shipped 0.8.3; identical semantics to `RedisCoordinator`).

This document specifies a Postgres-backed implementation of the
federation's `GlobalCoordinator` interface, locked in 0.8.3 and currently
served only by `RedisCoordinator`. The goal: open federation to operators
who run Postgres but not Redis, with identical correctness guarantees
(Δ = 0 under window-coupling; K-independent overshoot) and a documented
trade-off vs Redis on throughput / latency / HA.

---

## 1  Recap: the interface contract

From `src/federation/types.ts` (verbatim):

```ts
interface GlobalCoordinator {
  lease(key: string, tokens: number, expiresAt: number): Promise<number>;
  reconcile(key: string, leftover: number, windowStart: number): Promise<void>;
}
```

Load-bearing contracts:
- **`lease`** returns the granted amount in `[0, tokens]`. Partial grants
  are legitimate (race losers). MAY throw `StoreUnavailableError` on
  coordinator unreachability.
- **`expiresAt` is the window boundary** (epoch-ms). The coordinator MUST
  enforce expiry — leases past `expiresAt` are invalid. This is the
  load-bearing window-coupling commitment.
- **`reconcile` is idempotent on `windowStart`**. Duplicate calls within
  one window MUST be no-ops; retries through partition converge.

Per the `RedisCoordinator` precedent, the `expiresAt` argument is
**ignored**; the coordinator derives its own `expiresAt` from its
constructor `windowMs` + server clock. Same applies here.

---

## 2  Why Postgres? (positioning vs Redis)

| Axis | RedisCoordinator | PostgresCoordinator |
|---|---|---|
| Latency per lease | ~0.5–1 ms (sub-ms Lua EVALSHA) | ~1–3 ms (single SELECT FOR UPDATE + UPDATE) |
| Throughput cap | 100K+ leases/sec (Redis single-instance) | 5K–20K leases/sec (Postgres primary write throughput) |
| HA story | Sentinel / Cluster (best-effort) | Synchronous replication + automated failover (Patroni / pg_auto_failover) |
| Durability | RDB / AOF (configurable; AOF every-fsync is conservative) | WAL + sync replication (byte-durable by design) |
| Operational fit | Caching-shop default | Database-shop default; no extra infra |
| Observability | `INFO`, slowlog | Postgres `pg_stat_*` views, standard tooling |
| SPOF caveat | YES (single global Redis) — Cluster/Sentinel mitigate | YES (primary) — automated failover mitigates faster |
| Existing usage in ThrottleKit | `RedisStore` + `RedisCoordinator` | `PostgresStore` (per-strategy data store) |

**The user signal that motivates this:** operators in Postgres-heavy
shops who already have an HA Postgres cluster and don't want to add Redis
just for federation coordination. Latency is the trade-off: 1-3 ms per
cross-region lease vs Redis's sub-ms. With the federation's `batch`
mechanism, the per-request amortized cost is `(1-3 ms) / batch`. At
`batch = 16` and 1000 RPS per region this is ~80 ms/sec of coordinator
time per region — well within budget.

---

## 3  Schema

One table, two indices. Single row per key at any time.

```sql
CREATE TABLE tk_fed_state (
  key                 TEXT     NOT NULL,
  budget              BIGINT   NOT NULL,
  expires_at          BIGINT   NOT NULL,          -- epoch-ms; window boundary
  reconciled_markers  BIGINT[] NOT NULL DEFAULT '{}',  -- windowStart values
  updated_at          BIGINT   NOT NULL,          -- epoch-ms; for GC + observability
  PRIMARY KEY (key)
);

CREATE INDEX tk_fed_state_expires_idx
  ON tk_fed_state (expires_at);
```

**Design choices:**
- **PK = `(key)` not `(key, window_start)`.** At most one row per key at
  any time. When the window rolls, the same row is updated in place (its
  `expires_at` advances). Mirrors `RedisCoordinator`'s "one HASH per
  coordinator key" with PEXPIRE.
- **`reconciled_markers` as `BIGINT[]`** (Postgres array). Mirrors the
  Redis HASH's `rec_<windowStart>` fields. Bounded in size: at most one
  marker per concurrently-active windowStart (typically 1, plus the
  prior at window-roll time). GC: cleared when window rolls (see §4).
- **`updated_at`** is a debug + GC aid; not load-bearing.
- **No version column.** Concurrency control via row-level locks
  (`SELECT FOR UPDATE`), not optimistic CAS — simpler, and Postgres
  primary-write serialization at this row-count is not the bottleneck.

### 3.1 Schema initialization

The coordinator runs `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT
EXISTS` on first call (idempotent). This matches `PostgresStore`'s
pattern (`src/postgres/store.ts`).

---

## 4  `lease(key, tokens, expiresAt_ignored)` algorithm

All three steps run inside ONE transaction. Postgres row-level locking
guarantees atomicity (no other lessee can intervene between SELECT FOR
UPDATE and the UPDATE that follows).

```sql
BEGIN;

-- 1. Compute the active window from server clock + configured windowMs.
--    server_now_ms = extract(epoch from clock_timestamp())::bigint * 1000
--    window_start  = (server_now_ms / windowMs) * windowMs
--    expires_at    = window_start + windowMs

-- 2. Upsert: initialize the row, OR roll the window if expires_at has changed.
INSERT INTO tk_fed_state (key, budget, expires_at, reconciled_markers, updated_at)
  VALUES ($1, $per_key_budget, $expires_at, '{}', $server_now_ms)
  ON CONFLICT (key) DO UPDATE
    SET
      budget = CASE
        WHEN tk_fed_state.expires_at <> EXCLUDED.expires_at
          THEN EXCLUDED.budget       -- window rolled → reset to L
        ELSE tk_fed_state.budget    -- same window → keep accumulated state
      END,
      expires_at = EXCLUDED.expires_at,
      reconciled_markers = CASE
        WHEN tk_fed_state.expires_at <> EXCLUDED.expires_at
          THEN '{}'::bigint[]        -- window rolled → drop stale markers
        ELSE tk_fed_state.reconciled_markers
      END,
      updated_at = EXCLUDED.updated_at;

-- 3. Lock + read the now-fresh budget.
SELECT budget FROM tk_fed_state WHERE key = $1 FOR UPDATE INTO :current_budget;

-- 4. Compute granted; decrement.
:granted := LEAST($tokens, :current_budget);
UPDATE tk_fed_state
  SET budget = budget - :granted,
      updated_at = $server_now_ms
  WHERE key = $1;

COMMIT;

RETURN :granted;
```

### 4.1 Correctness notes

- **Window-roll path.** When `expires_at` differs from the stored value,
  the ON CONFLICT branch resets budget to `per_key_budget` and clears
  markers. This is the atomic equivalent of Redis's `DEL` + rebuild.
- **Server-time anchoring.** Use `clock_timestamp()` (NOT
  `current_timestamp` — that returns the transaction start time, which
  can shift `expires_at` if the transaction is long). Convert to
  epoch-ms once at transaction start; reuse for all derived values.
- **Race between two regions.** Both regions land their transactions;
  Postgres serializes via `FOR UPDATE` on the same row. The
  loser-to-arrive sees the leader's decrement and grants the residue.
  Just like the Redis Lua atomicity.
- **No-op on `tokens == 0`.** Skip the round trip; return 0 directly.

### 4.2 Performance notes

- **Index hit.** `tk_fed_state` PK lookup on `(key)` is a single index
  scan + row read; ~0.1 ms for a hot key.
- **Lock contention.** Per-key serialization. Under high contention on
  one key, throughput drops to `1 / latency_per_lease`. The federation's
  `batch` parameter is the user-side knob for this — large batch → fewer
  trips → less contention.
- **No advisory locks needed** at this design. `FOR UPDATE` suffices.
  Could be added later if profiling shows lock-acquisition overhead
  matters.

---

## 5  `reconcile(key, leftover, windowStart)` algorithm

```sql
BEGIN;

-- 1. Compute current window boundaries from server clock.
-- 2. Check idempotency: is windowStart already in reconciled_markers?

WITH ensure_row AS (
  INSERT INTO tk_fed_state (key, budget, expires_at, reconciled_markers, updated_at)
    VALUES ($1, $per_key_budget, $current_expires_at, '{}', $server_now_ms)
    ON CONFLICT (key) DO UPDATE
      SET
        budget = CASE
          WHEN tk_fed_state.expires_at <> EXCLUDED.expires_at
            THEN EXCLUDED.budget
          ELSE tk_fed_state.budget
        END,
        expires_at = EXCLUDED.expires_at,
        reconciled_markers = CASE
          WHEN tk_fed_state.expires_at <> EXCLUDED.expires_at
            THEN '{}'::bigint[]
          ELSE tk_fed_state.reconciled_markers
        END,
        updated_at = EXCLUDED.updated_at
)
SELECT
  budget,
  $windowStart::bigint = ANY(reconciled_markers) AS already_reconciled
FROM tk_fed_state
WHERE key = $1
FOR UPDATE
INTO :current_budget, :already_reconciled;

-- 3. If already reconciled this windowStart in the current window, no-op.
IF :already_reconciled THEN
  COMMIT;
  RETURN;
END IF;

-- 4. Add leftover to budget; cap at per_key_budget; record marker.
:new_budget := LEAST($per_key_budget, :current_budget + $leftover);
UPDATE tk_fed_state
  SET
    budget = :new_budget,
    reconciled_markers = array_append(reconciled_markers, $windowStart),
    updated_at = $server_now_ms
  WHERE key = $1;

COMMIT;
```

### 5.1 Correctness notes

- **Idempotency.** Mirror of `RedisCoordinator`'s `rec_<windowStart>`
  HEXISTS check. The marker lives in the current row; when window rolls,
  the array is cleared along with the budget reset.
- **Late-reconcile after window roll.** Suppose reconcile for
  `windowStart = N` arrives after window N+2 has started. The current
  row's `reconciled_markers` is empty (cleared at N→N+1 roll, again at
  N+1→N+2 roll). The reconcile credits leftover into the N+2 window's
  budget. This is `RedisCoordinator`'s exact behavior — credit-late is
  benign (bounded by leftover per call) and is the cost of liveness
  under partition.
- **Cap at `per_key_budget`.** Prevents reconcile from pushing budget
  above the limit (e.g., if two regions both reconcile leftover
  exceeding the budget — bug elsewhere, but bound here).

---

## 6  Garbage collection (stale rows)

Postgres has no TTL primitive. Three options:

| Option | Mechanics | Verdict |
|---|---|---|
| Opportunistic deletion in lease/reconcile | After upsert: `DELETE FROM tk_fed_state WHERE expires_at < server_now_ms - retention_ms` | Adds work to hot path; rejected |
| Background cron job | `setInterval(() => pool.query("DELETE ..."), 60_000)` | Selected — simple, off hot path |
| `pg_cron` extension | Server-side scheduled job | Optional; if `pg_cron` is installed, prefer it; otherwise fall back to JS-side cron |

**MVP:** background interval in the JS process, configurable via
`gcIntervalMs` (default 60_000). Documented opt-out via
`gcIntervalMs: 0`.

Retention: stale rows are only those whose `expires_at` is in the past
AND not yet reused (window-roll keeps the row alive). After window
expiry, the row sits dormant until a new lease re-initializes it. GC
deletes rows that have been dormant for `gcRetentionMs` (default
24h) — cheap insurance against table bloat for keys that go quiet.

---

## 7  Failure modes (vs RedisCoordinator)

| Failure | RedisCoordinator behavior | PostgresCoordinator behavior |
|---|---|---|
| Coordinator unreachable | `StoreUnavailableError` thrown; FederatedStore handles per `onCoordinatorOutage` | Same — wrap `pg` error in `StoreUnavailableError` |
| Primary failover (Postgres) | n/a | In-flight queries fail; once new primary accepts, retries succeed. Federation `fail-closed` mode keeps regional traffic safe during the failover window |
| Network partition between regions and coordinator | Regions fail-closed; reconcile retries on heal (idempotent) | Same |
| Coordinator clock skew | Lua reads Redis TIME; node clock ignored | Postgres `clock_timestamp()`; node clock ignored — **same skew immunity** |
| Transaction deadlock under contention | n/a (single Lua script) | Possible if app does cross-key transactions; mitigated by single-row-per-transaction design here |

### 7.1 Postgres-specific concerns

- **Long-running transactions** can hold row locks too long. The
  lease/reconcile transactions here are 3 statements each; well under
  10 ms even under contention. Set `statement_timeout` server-side
  (recommended 5s) as defense in depth.
- **HOT updates.** With `fillfactor` < 100, Postgres can do
  heap-only-tuple updates (no index update). Worth a follow-up perf
  pass; not blocking for MVP.

---

## 8  Server-time anchoring

```sql
SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms;
```

`clock_timestamp()` returns the *wall* time at the moment of the call,
not the transaction start. This is the Postgres analog to Redis's
`TIME` command. Node clock skew is irrelevant for the federation
bound, exactly as in the Redis coordinator.

Done once at the top of each lease/reconcile transaction; reused for
all derived values within the transaction.

---

## 9  Public API

```ts
import type { PgPoolLike } from "../postgres/store"; // reuse existing pool interface
import type { GlobalCoordinator } from "./types";

export interface PostgresCoordinatorOptions {
  /** A `pg` (node-postgres) pool. Use the existing `PgPoolLike` from `src/postgres/store.ts`. */
  pool: PgPoolLike;
  /** Window length in ms — MUST match the strategy's `windowMs` you federate. */
  windowMs: number;
  /** Default per-window budget for any key without an override. Default 1000. */
  budgetPerWindow?: number;
  /** Postgres table name. Default `"tk_fed_state"`. */
  tableName?: string;
  /** GC sweep interval in ms. Default 60_000. Pass 0 to disable. */
  gcIntervalMs?: number;
  /** GC retention for dormant rows in ms. Default 86_400_000 (24h). */
  gcRetentionMs?: number;
}

export class PostgresCoordinator implements GlobalCoordinator {
  constructor(options: PostgresCoordinatorOptions);
  setBudget(key: string, budgetPerWindow: number): void;
  budgetFor(key: string): number;
  lease(key: string, tokens: number, expiresAt: number): Promise<number>;
  reconcile(key: string, leftover: number, windowStart: number): Promise<void>;
  /** Stop the GC interval. Call before process exit. */
  close(): void;
}
```

API parity with `RedisCoordinator` — same construction shape, same
methods. Drop-in replacement.

---

## 10  Test plan (TK-1302)

Three layers, all running against `tk-postgres` on port `5433` per
`memory/local-test-postgres.md`:

1. **Unit-style** (`test/federation/postgres-coordinator.test.ts`).
   - lease happy path (sufficient budget)
   - lease partial grant (race)
   - lease zero tokens → 0 (no round trip)
   - reconcile happy path
   - reconcile idempotency (same windowStart → no-op)
   - reconcile after window roll (credits into current)
   - reconcile cap at per_key_budget
   - window-roll path (budget resets on new expires_at)
   - GC sweep removes stale rows

2. **Property-based dual-path** (`test/federation/postgres-property.test.ts`).
   - Mirror `test/federation/property.test.ts` (TK-908) but driven against
     `PostgresCoordinator`.
   - Fast-check generates `(regionIdx, cost)` timelines × K ∈ {2, 3, 4}.
   - Assert: `RedisCoordinator ≡ PostgresCoordinator` decision streams.
   - Gated on `THROTTLEKIT_TEST_POSTGRES`.

3. **Cross-region failure modes** (`test/federation/postgres-failure.test.ts`).
   - Coordinator outage simulation (pool closed mid-test)
   - Reconcile retry after partition heal
   - Δ = 0 invariant under each failure shape

### 10.1 Test infrastructure reuse

- Reuse `PgPoolLike` from `src/postgres/store.ts` (no new pool wrapper).
- Reuse `tk-postgres:5433` (already set up per memory).
- Schema setup via `CREATE TABLE IF NOT EXISTS` at first call (no
  external migration tool).
- Test cleanup: each test file uses a unique table-name suffix
  (`tk_fed_state_${random_suffix}`) and drops the table in `afterAll`.

---

## 11  Out of scope (for 0.8.4)

- **Advisory locks** for further perf optimization (would shave ~10-20%
  off lease latency under contention; not the bottleneck for MVP).
- **`pg_cron` integration** for server-side GC.
- **Multi-primary Postgres setups** (Citus, Bidirectional replication).
  The MVP assumes single-primary; documented in §7.
- **Schema migration tooling.** `CREATE TABLE IF NOT EXISTS` is enough;
  any future schema change ships as a separate migration task.

---

## 12  Definition of done (TK-1302)

- `src/federation/postgres-coordinator.ts` exists; implements
  `GlobalCoordinator`; matches the API in §9.
- `test/federation/postgres-coordinator.test.ts` covers the §10.1 cases;
  passes against `tk-postgres:5433`.
- `test/federation/postgres-property.test.ts` runs ≥ 50 fast-check
  timelines × K ∈ {2, 3, 4} with `RedisCoordinator ≡ PostgresCoordinator`
  bit-identical decision streams; gated on `THROTTLEKIT_TEST_POSTGRES`.
- No new runtime dependency (the `pg` import is already a peer in the
  existing `src/postgres/store.ts`).
- `npm run check` green at 845+ tests.

---

## 13  References

- `src/federation/redis-coordinator.ts` — the precedent; Lua scripts at
  `LEASE_LUA` / `RECONCILE_LUA`.
- `src/federation/types.ts` — the `GlobalCoordinator` interface contract.
- `src/postgres/store.ts` — the `PgPoolLike` interface to reuse.
- `research/bigger-bets/federation/DESIGN.md` — the federation system
  design (the lift argument and Δ-bound proof).
- `spec/GaleFederatedLeasing.tla` — the formal model; PostgresCoordinator
  satisfies the same abstract interface, so the bound transfers.
- `memory/local-test-postgres.md` — `tk-postgres` on port 5433.
