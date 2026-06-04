# 14 · gRPC server (`throttlekit-server`)

> Running the rate-limiting core as a network service so polyglot clients get decisions identical to an
> embedded Node library. Source: `server/`.

## Purpose

`throttlekit-server` exposes the frozen `throttlekit` core over gRPC behind a **pluggable store resolver**.
Point multiple instances at one shared store — `--redis`, `--postgres-url`, or `--dynamodb-table` — and you
have a coordinated fleet enforcing one shared limit (or run a single instance on in-process memory). It
depends only on the core's public, frozen API — it adds no surface to the core and keeps the
zero-runtime-dependency promise intact. (The core
is 1.0/frozen; the server evolves independently and is currently experimental/pre-1.0.)

## Architecture — three clean layers

**(i) The transport-agnostic service core** (`server/src/service.ts`). `createRateLimiterService` is a pure
*consumer* of the published core API. It holds a registry of named policies across one namespace, each of
exactly one kind:

- **limiters** — wrapped in the core's `createEnforcer` so a store outage resolves by `fail` mode instead of
  throwing;
- **meters** — token-budget policies, one `TokenBudgetMeter` per key, lazily created and FIFO-bounded by
  `maxKeys`;
- **admitters** — concurrency/unified policies, the first stateful surface, with a server-local **lease
  table**.

A policy name is a limiter **or** a meter **or** an admitter, never more than one — a collision throws at
construction. Because the service returns core `Decision`/`Forecast` objects directly, it is conformance-
testable against the golden vectors exactly as a port would be.

**The Doors / dispatch.** `check` runs the enforcer; `checkMany` batches at one consistent instant (pipelined
on Redis); `peek`/`forecast` gate on the strategy supporting them; `debit` runs the core's token-budget
primitive; `admit` runs the core's `unifiedAdmission` (the one oracle) and, on allow, mints an opaque
server-local lease id storing the core's `release` closure plus an `expiresAt`; `release` is idempotent (an
unknown id is a no-op); `heartbeat` renews leases and reports live vs reclaimed ids; `sweep` reclaims every
lease past its deadline via `release({ dropped: true })` — the **crash-reclaim via lease TTL**.

**(ii) The gRPC binding** (`server/src/grpc.ts`). Loads the proto **dynamically (no codegen)** via
`@grpc/proto-loader`. Every handler is a pure translation — proto request → core call → proto response — with
the only added logic being error→status mapping. `serve` binds, applies credentials (default **insecure**),
and starts an `unref`'d sweeper interval (cleared on close).

**(iii) Config + runtime wiring** (`server/src/config.ts`, `runtime.ts`, `bin.ts`). The config layer routes
each policy by shape: a `tokenBudget` block → a meter; a `concurrency` block → an admitter (wiring
`adaptiveConcurrency` + an optional rate `strategy` into `unifiedAdmission`); a `twoTier` block → a leased
two-tier limiter; a plain rate-limit policy is delegated unchanged to the core's `loadConfig`. The CLI flags
(`--config`, `--host`, `--port`, `--fail`, `--store`, `--redis`, `--redis-prefix`, `--postgres-url`,
`--postgres-table`, `--postgres-prefix`, `--dynamodb-table`, `--dynamodb-region`, `--dynamodb-endpoint`,
`--dynamodb-prefix`, `--dynamodb-create-table`, `--tls-cert/-key/-ca`) map to resources; `--store` selects
the shared backend (`memory|redis|postgres|dynamodb`), inferred from the connection signal when omitted
(`--redis` → redis, `--postgres-url` → postgres, `--dynamodb-table` → dynamodb, else per-policy in-process
memory). The CLI warns when serving insecure on a non-loopback host, and drains gracefully on
SIGINT/SIGTERM.

## Design decisions & rationale

- **A denial is a `Decision`, not an error.** A rate-limit denial is a *successful* RPC with `allowed:false`,
  so a client always inspects the decision. RPC errors are reserved for operational faults only: `NOT_FOUND`
  (unknown policy), `UNIMPLEMENTED` (unsupported op), `INTERNAL`. The returned `Decision` is always
  authoritative.
- **One oracle.** The service is a consumer of the frozen public API and the binding adds no decision logic,
  so the service is conformance-testable like a polyglot port — there is no second place a decision is
  derived.
- **Crash-reclaim via lease TTL.** A granted `admit` holds an in-flight slot that must be `Release`d, *or* the
  server reclaims it once the lease expires (`sweep` → `dropped:true`, the overload signal). This deliberately
  mirrors the core's node↔coordinator TTL + heartbeat + reclaim-on-crash contract, one layer out; the default
  lease TTL is twice the core heartbeat default, so one missed beat is tolerated.
- **Fail-open/closed has two scopes.** When the *service* is unreachable (transport error), the policy is the
  *client's* and never a proto field; when a *server-side store* outage occurs, it surfaces inside the
  returned `Decision` per the service's `fail` mode.
- **mTLS to protect a shared budget.** Anything that can talk to the service can poison a shared limit, so
  `--tls-ca` enables client-cert verification (mTLS); the default credentials are insecure (loopback/dev).
- **Dynamic proto load (no codegen)** keeps the binding a pure mapping and the proto the single contract.

## Caveats

- Default credentials are insecure; the CLI only *warns* (doesn't refuse) on a non-loopback insecure bind.
- Token-budget meters and the concurrency lease table are **single-instance per server process** today (the
  lease table lives in one process's memory; a fleet-shared budget is a future enhancement via the core's
  distributed primitives). Rate-limit decisions, by contrast, are coordinated through the configured shared
  store (`redis`/`postgres`/`dynamodb`), so they are fleet-wide.
- The joint-LP `hold`/`value` terms are flagged experimental.

## What proves it

- `server/test/service.test.ts` — in-process service-core conformance: replays every committed `rateLimit`
  suite field-for-field; `PolicyNotFoundError` on unknown; store outage resolves by fail mode.
- `server/test/grpc.test.ts` — **end-to-end over real gRPC**: a live in-process server (sharing a
  `ManualClock`) + a real client replay every golden-vector suite *over the wire*, asserting the decoded
  response equals the oracle field-for-field; plus the status mapping, `checkMany` order, non-consuming
  `peek`, and `debit` budget exhaustion.
- `server/test/{admission,tokenbudget,twotier,runtime}.test.ts`.

## Source map

`server/src/service.ts` (the core + Doors) · `grpc.ts` (the binding + `serve`) · `config.ts` (policy
routing) · `runtime.ts` (store/credentials) · `bin.ts` (CLI). Contract: `wire/throttlekit.proto`
([13](13-wire-protocol.md)).
