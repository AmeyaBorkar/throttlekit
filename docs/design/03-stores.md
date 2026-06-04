# 03 · Storage layer

> Every backend reduces to one atomic primitive. This is how each one satisfies it — and the consistency
> class, atomicity mechanism, and failure behavior of each. Source: `src/stores/`, `src/redis/`,
> `src/postgres/`, `src/dynamodb/`, `src/deno/`, `src/cloudflare/`.

## Purpose

A store's entire job is to run a pure read-modify-write `transform` **atomically per key** and persist
the result with a TTL iff asked (the `apply` contract from [01](01-core-model.md)). Because that is the
*only* primitive, the N-algorithms × M-backends matrix collapses to N + M: algorithms are pure functions
of state, backends are pure transport for one atomic RMW, and no backend ever contains rate-limiting math.

Two encoding disciplines run through the whole layer:

- **MemoryStore keeps native values** (a number, a small object) — no serialization on the hottest path.
- **Every distributed store JSON-encodes state**, so a `double` round-trips as the exact IEEE-754 value
  and decisions stay bit-identical across backends; combined with integer-only `Decision` fields, the JS
  and Lua paths are byte-equal.

| Store | Consistency | Atomicity mechanism | Sync? | Status |
|---|---|---|---|---|
| Memory | Exact, single-process | single-threaded RMW (no lock) | ✅ | stable core |
| Redis | Exact, distributed | Lua `EVALSHA` (built-ins) / `WATCH`-`MULTI` OCC (custom) | ❌ | stable core |
| Postgres | Exact, distributed | `pg_advisory_xact_lock` + `ON CONFLICT` upsert | ❌ | shipped |
| DynamoDB | Exact, distributed | conditional `PutItem` CAS on a `version` attr | ❌ | shipped |
| Deno KV | Exact, distributed | `atomic().check(versionstamp).commit()` CAS | ❌ | shipped |
| Durable Object | Exact, distributed | `blockConcurrencyWhile` serialization (no retry) | ❌ | shipped |
| D1 | Exact, distributed | version CAS via conditional `UPDATE` | ❌ | shipped |
| Workers KV | **Approximate**, eventual | none — last-write-wins | ❌ | shipped, **not contract-conformant** |

## MemoryStore — exact, single-process, the default

**Atomicity is free.** Node is single-threaded, so a synchronous read→transform→write with no `await`
inside it cannot interleave; `applySync` needs no locks at all (`src/stores/memory.ts:135`). The async
`apply` simply resolves `applySync`.

**O(1)-amortized expiry via a timing wheel.** Keys are bucketed into `wheelSize` slots by expiry tick;
advancing the wheel processes only the slots that have come due, so expiry costs O(due keys), not O(all
keys) like a map scan (`src/stores/timing-wheel.ts`). Correctness on read comes from a per-entry `exp`
checked inline (no second map lookup); the wheel only does *bulk* reclamation. The wheel owns no timer —
the store drives it on access and via an optional background sweep whose interval timer is `unref`'d (so
it never keeps a process alive, and can be disabled outright on edge runtimes).

**Adversarial-key-flood defense.** With `maxKeys` set, cardinality is bounded by an approximate-LRU
**CLOCK / second-chance** ring: each access sets a reference bit; a hand clears bits and evicts the first
key whose bit is already clear, bounded to one sweep (`src/stores/memory.ts:97`). This is deliberately
*approximate* rather than exact LRU — a true LRU touches a linked list on every read, which is both a hot-
path cost and itself an attack surface. The CLOCK ring stays O(1) and reorder-free while still bounding
memory against a flood of unique (e.g. spoofed-IP) keys.

## RedisStore — exact, distributed, the flagship

**Two atomicity paths.**

- *Lua `EVALSHA` (built-in strategies).* When the transform carries a `.lua` rider, `apply` runs the
  script via `EVALSHA`, falling back to `EVAL` + re-cache on a `NOSCRIPT` error (the cache was flushed by
  a restart/failover) (`src/redis/store.ts:78`). A single server-side Lua execution is atomic by Redis's
  command model — no client round trips inside the critical section, no `WATCH` retry loop.
- *Optimistic concurrency (custom strategies).* A strategy without a Lua form falls back to
  `WATCH`/`GET`/`MULTI`/`EXEC` with bounded retries; `EXEC` returning `null` is exactly the "a watched key
  changed" signal that triggers a retry (`src/redis/store.ts:105`). This is what lets *any* user-authored
  pure strategy run correctly on Redis without anyone writing Lua.

**The server clock is the source of truth.** When `useServerTime` is on, the store passes `now = 0` and
the Lua derives `now` from `redis.call('TIME')` (`wire/scripts/gcra.check.lua:1`). Multiple app nodes with
skewed clocks would otherwise write inconsistent state into the *same* shared key; anchoring on the Redis
server clock makes node skew irrelevant. Only the absolute `resetAt` is affected; duration fields are
skew-free regardless.

**Redis Cluster co-location.** A strategy declares the keys its script touches via `buildKeys(key)`. Only
the substring inside the first `{...}` is hashed by Redis Cluster, so a multi-key script wraps its subject
in a hash tag to land all keys on one slot (avoiding `CROSSSLOT`); independent keys distribute normally.

**Client adapters.** `RedisStore` speaks one internal shape (the `ioredis` flattened `evalsha`); thin
adapters translate `node-redis` and Upstash REST into it so the store and every Lua script are unchanged
across all three clients. Upstash REST has no transactional `WATCH`, so its OCC methods throw a clear
`StoreUnavailableError` rather than corrupt state silently — custom (non-Lua) strategies therefore require
`ioredis`/`node-redis`.

## The distributed-CAS family — Postgres, DynamoDB, Deno KV, D1

These four reach exactness without a Redis, each via the strongest primitive its backend offers. All run
the *same* pure JS transform — there is no backend-specific algorithm to keep in sync — and all encode
state as the same JSON text for cross-backend bit-identity.

> **Deployment note:** of these four, **Postgres and DynamoDB** can back a Node `throttlekit-server` (via
> `--store postgres|dynamodb`); **Deno KV and D1** are edge-runtime-only — reachable from inside their
> runtimes, not through the Node service door.

- **Postgres** wraps the RMW in a transaction guarded by `pg_advisory_xact_lock(hash(key))`, then upserts
  with `INSERT … ON CONFLICT (key) DO UPDATE` (`src/postgres/store.ts:152`). *Why an advisory lock and not
  `SELECT … FOR UPDATE`:* `FOR UPDATE` can't lock a row that doesn't exist yet, so two first-touch
  transactions on a new key could race; an advisory lock keyed by the key's hash serializes them whether
  or not the row exists and auto-releases at `COMMIT`/`ROLLBACK`, so an error can never leak it. Net: N
  concurrent increments land exactly N, like Redis.
- **DynamoDB** does a consistent `GetItem`, runs the transform, then a conditional `PutItem` with
  `ConditionExpression = "version = :v"` (or `attribute_not_exists` on first touch) — a compare-and-set;
  a `ConditionalCheckFailedException` is the lost-race signal and triggers a re-read (`src/dynamodb/store.ts:182`).
- **Deno KV** uses the platform's first-class `atomic().check(versionstamp).commit()` — a true CAS where
  `commit` succeeds iff the key is still at the read versionstamp (`src/deno/store.ts:168`).
- **D1** (edge SQLite) does a version CAS via `UPDATE … WHERE key = ? AND version = ?`, with
  `res.meta.changes === 1` as the commit signal (`src/cloudflare/d1.ts:223`).

**In-process CAS coalescing.** DynamoDB, Deno KV, and D1 all add a per-key promise chain so that
*same-process* applies to one hot key serialize into one clean version bump, leaving the CAS retries to
reconcile only genuine *cross-process* races (`src/dynamodb/store.ts:162`). Without this, a single hot key
would CAS-contend with itself and burn write-billed retries (and, on D1, per-row billing).

**Expiry is always lazy and clock-injected.** Every distributed store decides "expired" on read from a
logical `expires_at`/`e` field on the store's injected `Clock`; native TTL (DynamoDB TTL, Deno
`expireIn`, KV `expirationTtl`) and background sweeps only *reclaim space* and are best-effort. This is
safe because every built-in strategy is idempotent w.r.t. stale state (a past TAT clamps to `now`, a
bucket refills, a window resets), so a late physical delete can never change a decision.

## Cloudflare Durable Object — exact, no retry loop

A Durable Object is a single-threaded actor with strongly-consistent transactional storage. The RMW is
wrapped in `blockConcurrencyWhile`, which serializes it against every other handler in the object, so
`apply` is atomic with **no optimistic-retry loop**: N concurrent increments land exactly N
(`src/cloudflare/durable-object.ts:112`). *Why a DO and not Workers KV:* KV is eventually consistent with
no atomic compare-and-set — it cannot honor the `Store` contract and would silently over-admit. Throughput
is bounded by the single object's serialization rate, which is the cost of exactness when a budget is
shared through one object.

## Workers KV — the one approximate store (by design)

`KVStore` is explicitly **not exact**. Workers KV is eventually consistent and offers no CAS, so
concurrent checks read-modify-write over each other (lost updates) and it can over-admit under load
(`src/cloudflare/kv.ts:38`). It is intentionally *not* run through the atomic store-conformance suite. Use
it only where occasional over-admission is acceptable — coarse, cheap edge protection where you have no
Durable Object or D1 binding. A logical epoch-ms expiry keeps the limiter's window math correct, but KV's
60 s `expirationTtl` floor means idle keys physically linger up to a minute. For correctness on
Cloudflare, prefer the Durable Object (exact) or D1 (version-CAS, exact).

## The conformance kit — how a new backend earns "correct"

`runStoreConformance` (`src/testkit/index.ts`) is a reusable, runner-agnostic suite that pins the exact
contract the limiter relies on. It fires two probe transforms (an atomic `counter` and a non-mutating
`readCount`, each with a Lua form so Lua-capable stores exercise their real single-round-trip path) and
asserts five properties: persists-and-mutates, isolates independent keys, `reset` clears, expires after
TTL (skipped for stores on an uncontrollable server clock), and — the load-bearing one — **applies
atomically**: 200 concurrent applies on one key must read back exactly 200. A non-atomic RMW interleaves
and drops writes; an atomic store lands exactly N. Every shipped store registers this suite (the KV
variant omits the atomic assertion, since it is best-effort by design).

## Design decisions & rationale

- **One atomic primitive is the whole store surface** — the lever that makes algorithms and backends
  orthogonal.
- **Same pure transform on every backend** — there is no per-backend algorithm to keep in sync; a store is
  proven correct the moment the conformance suite is green.
- **JSON encoding on distributed stores, native values in memory** — cross-backend bit-identity where it's
  needed, zero serialization where it's hot.
- **Lazy, clock-injected expiry everywhere** — leans on strategy idempotence so late physical deletion is
  always safe and expiry is deterministic under a `ManualClock`.
- **Server clock as authority (Redis)** — defends shared state against node clock skew.
- **In-process CAS coalescing** — spends OCC retries only on real cross-process races (and saves per-row
  billing on D1).
- **Approximate CLOCK-LRU in memory** — an O(1), reorder-free OOM defense against adversarial key floods.

## Caveats & failure behavior

- A distributed store outage makes `apply` reject; the limiter's `fail: "open" | "closed"` (decided at the
  adapter, [09](09-adapters.md)) turns that into admit-vs-deny. Nothing is implicit.
- OCC/CAS stores can exhaust their retry budget under extreme single-key contention → `StoreUnavailableError`.
- Async-only stores throw on `checkSync` by design.
- Workers KV over-admits under concurrency and reclaims idle keys no faster than 60 s — by design.

## What proves it

- `src/testkit/index.ts` registered by `test/testkit/store-testkit.test.ts` (Memory + Redis),
  `test/postgres/store.test.ts`, `test/dynamodb/store.test.ts`, `test/deno/store.test.ts`,
  `test/cloudflare/{durable-object,d1,kv}.test.ts` — the per-store contract.
- `test/concurrency/atomicity.test.ts` — through `rateLimit`, fires 200 concurrent checks at limit 50 and
  asserts **exactly 50 allowed, never 51 (lost update) nor 49 (over-eager deny)** for Memory and Redis.
- `test/conformance/conformance.test.ts` + `test/conformance/lua-property.test.ts` — the bit-identical
  JS-vs-Lua dual-path proof and its property-based fuzzer.
- `docs/FAILURE-MODES.md` — the per-store outage/recovery table.

## Source map

`src/stores/memory.ts`, `timing-wheel.ts` · `src/redis/store.ts`, `clients.ts` · `src/postgres/store.ts` ·
`src/dynamodb/store.ts` · `src/deno/store.ts` · `src/cloudflare/durable-object.ts`, `d1.ts`, `kv.ts` ·
`src/testkit/index.ts` · Lua: `wire/scripts/*.lua` (see [13](13-wire-protocol.md)).
