# Performance follow-ups (deferred / blocked)

A performance optimization audit (find → adversarially-verify → land) swept core, server, and the Python
client. Most confirmed wins landed as small, byte-identical-safe commits behind benchmarks; the highest-value
was eliminating a per-decision `structuredClone` of immutable primitive state on the multi-dimension path
(~−31% / −35% on the 2-/3-dimension `multiRateLimit.checkSync` rows).

This note records the opportunities that were **deliberately not taken**, each with the reason and how to do it
safely if revisited. They are real, verified inefficiencies — held back on risk/reward, not because they are
wrong. Engineering-only; no API or wire change implied.

## Blocked by the frozen wire contract

### slidingWindow check: `HGETALL` instead of S+2 per-slot `HGET`
- **Where:** `src/algorithms/sliding-window.ts` (the atomic check Lua).
- **Win:** the script issues one `HGET` per ring slot (≈ S+2 `redis.call` dispatches) inside a single `EVAL`
  where one `HGETALL` would carry the whole ring — a few µs of Redis single-thread occupancy per decision for
  `slidingWindow` users, a max-throughput lever only near Redis saturation. Decisions stay byte-identical.
- **Why blocked:** this script is single-sourced into the **frozen, sha256-checksummed** polyglot wire
  artifacts (`wire/scripts/`) and pinned by conformance + golden vectors + the cross-language port contract.
  Changing the script bytes flips the checksum and breaks wire conformance — a hard-constraint violation under
  the 1.x freeze.
- **How to do it safely:** schedule into a deliberate wire-contract revision (`npm run wire:scripts`, reviewed
  diff, re-pin vectors + checksums). Do **not** fork the script for a one-off.

## Research item — proposed mechanism is unsafe as-specified

### Postgres decision: collapse the 5 sequential round-trips
- **Where:** `src/postgres/store.ts` (the per-decision apply).
- **Win:** the apply spends ~5 sequential round-trips; in principle the read side could fold a trip.
- **Why deferred:** the naive `WITH lk AS MATERIALIZED (SELECT pg_advisory_xact_lock(...))` CTE is **doubly
  broken** — an unreferenced plain `SELECT` CTE may be pruned (the lock is never acquired), and `MATERIALIZED`
  does not guarantee lock-before-read execution order. The advisory-lock-before-read ordering is the
  load-bearing invariant behind the formally-proven `admitted ≤ Limit` bound, and it is pinned only by a
  **store-gated** concurrency test that is absent from the store-less CI gate — so a regression could ship
  silently. The `BEGIN` trip also cannot be removed with stock `node-postgres`.
- **How to do it safely:** treat as a research task. Any attempt must (a) prove lock-before-read order holds,
  and (b) first add storeful concurrency coverage to the blocking gate so the proof can't regress unseen.

## Deferred — niche reward vs new API surface + lifecycle risk

### RedisStore OCC connection pool
- **Where:** `src/redis/store.ts` `#applyOcc` (the optimistic-concurrency fallback).
- **Win:** OCC opens and tears down a fresh duplicated connection per `apply`; a small bounded pool would
  amortize the TCP handshake/AUTH/SELECT.
- **Why deferred:** the OCC path is reached **only** by custom strategies that ship **no** Lua form — every
  built-in strategy (incl. the default GCRA) takes the single-`EVALSHA` branch and never hits it, so the
  real-world reward is small. Worse, pooling adds **public API** (`RedisStore.close()`) to a released store and
  a lifecycle regression: a caller-provided store would leak idle sockets unless the new `close()` is called,
  versus today's clean per-call teardown. New API surface + a leak footgun on a shipped store, for a niche
  path, fails the risk/reward bar.
- **How to do it safely:** if revisited, prefer a bounded pool whose idle connections are **reaped on a TTL**
  (so there is no leak without an explicit `close()`), keep WATCH's per-in-flight-apply connection isolation,
  and disconnect (never pool) any connection that threw mid-transaction. Gate on a live-Redis concurrent-OCC
  dual-path run.
