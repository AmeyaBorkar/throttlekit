# 15 · Python client (`throttlekit-py`)

> Reaching the one Node core from Python through two pluggable backends, both proven against the same golden
> vectors. Source: the `throttlekit-py` repository (`AmeyaBorkar/throttlekit-py`).

## Purpose

A Python service should get the *same proven core* a Node fleet does, not a second rate limiter to keep in
sync. `throttlekit-py` (dist name `throttlekit-py`, import name `throttlekit`) is a client — it implements
**no** rate-limiting math. Every decision it returns comes from the one Node core, reached through one of two
doors and proven bit-for-bit against the same golden vectors the wire contract is built from.

## One oracle, two doors

**Door 1 — `ServiceBackend`** (gRPC). The lead door; full surface (`check`, `check_many`, `peek`, `forecast`,
`debit`, `admit`). It decodes proto → `Decision`/`Forecast` and does no math — the core *inside the service*
computes every decision. An `Admission` is a context-manager lifecycle handle (`held`/`allowed`/`reclaimed`,
an idempotent `release(dropped=...)`, and an `__exit__` that releases with `dropped = (an exception
propagated)` but never suppresses the exception). An optional daemon heartbeat pump renews long-lived leases
in one batched `Heartbeat` and surfaces a server-reclaimed lease as `reclaimed`.

**Door 2 — `RedisBackend`** (direct Lua). Talks to the *same* Redis a Node fleet uses and runs the *same*
vendored Lua the core ships, so decisions are bit-identical to an embedded Node library. It re-implements no
math — the decision is computed server-side, in Lua. It is client-agnostic (any object with `evalsha`/`eval`),
resolves the vendored script by `(strategy, "check")`, builds ARGV by resolving each manifest ARGV *name*
against `{now, cost, **strategy.params()}`, applies the *same* `prefix:key` join as the core, and runs
`EVALSHA` with an `EVAL` fallback on `NOSCRIPT`. `now=None` sends the sentinel `0` ⇒ the Redis server clock
(the skew-free fleet default).

## The contract is consumed, never re-derived

- **Strategies** are pure configuration: each declares its wire `kind` and a `params()` dict keyed by the
  **manifest ARGV names**; the ARGV *order* is read from the vendored manifest at call time, never hard-coded,
  so a core reordering flows through on re-vendoring with no client change.
- **The contract loader** reads the vendored `manifest.json` + `*.lua` from *inside the package* (so it
  resolves identically in a checkout and an installed wheel), exposing the source, ordered ARGV names, and the
  sha1 Redis caches by.
- **`Decision`/`Forecast`** are frozen dataclasses mirroring the five frozen core fields (snake_case).
- **Error mapping**: gRPC status → exception (`NOT_FOUND` → `PolicyNotFoundError`, `UNIMPLEMENTED` →
  `OperationNotSupportedError`, `UNAVAILABLE` → `ServiceUnavailableError`, else `ThrottleKitError`); the errors
  are grpc-free so they import without the stubs.
- **Checksum-pinning / vendoring**: a sync script vendors the contract from the core by audience — dev/test
  artifacts (`throttlekit.proto`, `golden-vectors.json`) sha256-pinned in a manifest, and the runtime Lua +
  its manifest into the package — enumerated from the core's own scripts manifest (no globbing). The Python
  client is a consumer of the contract exactly like every other surface.

## Design decisions & rationale

- **A service, not a native port.** The core's ~169 ns/op in-process speed does not transfer to CPython, and
  re-porting the algorithms would create a second place the decision is derived — which the design forbids. So
  both doors *reach* the existing oracle: `ServiceBackend` over gRPC, `RedisBackend` by running the core's own
  vendored Lua. Decisions are proven, not asserted.
- **A denial is a `Decision`, not an exception** — only operational gRPC faults map to exceptions.
- **`ServiceBackend` gets the full surface; `RedisBackend` is `check`-only — by design.** `peek`/`forecast`/
  `check_many`/`debit`/`admit` route through the service door where the core computes them; reproducing them
  in `RedisBackend` would mean porting read→decision math client-side, re-deriving a decision in a second place.
- **ARGV order from the manifest, not hard-coded** — a core reordering is absorbed on re-vendoring; a typo is
  caught structurally by the drift-gate.
- **Crash-reclaim via lease TTL, client side** — `release` is best-effort; a lost `Release` is backstopped by
  the server reclaiming the slot on lease expiry, and the heartbeat pump surfaces that reclamation.
- **mTLS to protect a shared budget** — `credentials=None` is insecure (loopback/dev only).

## Caveats

- Experimental / alpha; the underlying raw Lua wire is `frozen: false`.
- `RedisBackend` is `check`-only — the cost/concurrency Doors need the service backend (and the server's
  meters/lease table are single-instance).
- The gRPC stubs are git-ignored build artifacts — a source checkout must regenerate them before
  `ServiceBackend` imports (a `pip install` ships them, built at wheel time from the vendored proto).

## What proves it

- `tests/test_contract.py` — the **drift-gate** (pure Python, no gRPC): vendored artifacts match the pinned
  sha256s; the golden vectors carry the expected contract version and decision fields; **every shipped `.lua`
  matches the sha256 in the vendored manifest** (the byte-lock the Node side enforces, now on the vendored
  copy); the reply tuple agrees with the vectors.
- `tests/test_redis_backend.py` — the **cross-language vector replay** (the capstone proof): Python → vendored
  Lua → real Redis ≡ the Node oracle, the full time-parametrized vectors, all five reply fields asserted; also
  proves the client's sha1 matches the Redis script cache (cross-language cache sharing). Redis-gated.
- `tests/test_service_backend.py` — **end-to-end gRPC conformance** (Python `ServiceBackend` ↔ the Node
  server): cold-burst, independent keys, leased two-tier via plain `check`, token-budget `debit`, the
  concurrency `admit`/`release`/context-manager/`reclaimed` lifecycle, unified binding on the concurrency
  axis, the `UNIMPLEMENTED`/`NOT_FOUND` mappings, and heartbeat keeping a long hold alive past the lease TTL.
- `tests/test_strategies.py` — each strategy's `params()` ∪ `{now,cost}` exactly equals the manifest's check
  ARGV names.

## Source map

`src/throttlekit/{__init__,service_backend,redis_backend,strategies,_contract,decision,errors}.py` ·
`scripts/sync_contract.py` · `contract/manifest.sha256` · `tests/`. The contract it consumes lives in the
core's `wire/` ([13](13-wire-protocol.md)); the service it talks to is [14](14-grpc-server.md).
