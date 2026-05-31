# Phase 2 — the ThrottleKit service door

The polyglot design (`DESIGN.md`) reaches non-Node languages through **one core, one contract, two
doors**. Phase 1 built the contract (`wire/`). Phase 2 builds the **service door**: a process that runs
the Node core and answers `wire/throttlekit.proto` over gRPC, so a Python/Go client is a trivial RPC stub
that never touches the raw Lua wire. This is the door we lead with (the in-process 169 ns number doesn't
transfer to CPython; the network-bound door is where the value is).

## What landed — the `throttlekit-server` package (built + conformance-proven)

The whole service door, in the new standalone `server/` package (`throttlekit-server`), depending only on
published `throttlekit@^1.0.1` + `@grpc/grpc-js` + `@grpc/proto-loader`:

- **`service.ts`** — the transport-agnostic service core: `createRateLimiterService({ limiters, fail })`
  (a registry of named policies, each a `Limiter` wrapped in `createEnforcer` so a store outage resolves
  by `FailMode`), `createRateLimiterServiceFromConfig(text, { store, fail })` (straight from
  `.throttlekit.yaml`), and `check / checkMany / peek / forecast` returning the **core domain types**.
  `PolicyNotFoundError` (→ `NOT_FOUND`) and `OperationNotSupportedError` (→ `UNIMPLEMENTED`).
- **`grpc.ts`** — `serve()` binds `throttlekit.v1.RateLimiter` over the proto (dynamic proto-loader, no
  codegen). Every handler is a *pure translation* — proto request → core call → proto response; the only
  added logic is error → gRPC status. A denial is a normal `Decision`, never an RPC error.
- **`bin.ts`** — `throttlekit-server --config <yaml> [--port] [--host] [--fail]` (memory store; Redis
  wiring is a follow-up). **`index.ts`** re-exports the embeddable API.

**Conformance — two layers, both green:**
- `test/service.test.ts` replays every committed `golden-vectors.json` rateLimit suite *through the
  service core* (the server is a **consumer** of the artifact, exactly like a polyglot port).
- `test/grpc.test.ts` replays the same suites **over real gRPC** — a live in-process server + client,
  the limiters sharing a `ManualClock` the test advances — and asserts the decoded response equals the
  oracle field-for-field. This proves the *whole door* (serialize → dispatch → decode) reproduces an
  embedded library, which is the load-bearing invariant of the design.

The **core package is untouched** (the service core moved out of `src/`); the server dogfoods the frozen
1.0 public API. Root `biome` excludes `server/`; the server owns its own `tsconfig`/`biome`/`vitest`.

## The decision mapping (so the proto is honest)

| Core outcome | Returned `Decision` |
|---|---|
| admitted / denied | the real `Decision` from `limiter.check` |
| store outage, `fail: open` | synthesized: `allowed: true`, `limit` = strategy limit, `remaining` = limit, `resetAt`/`retryAfterMs` = 0 |
| store outage, `fail: closed` | synthesized: `allowed: false`, `remaining`/`resetAt`/`retryAfterMs` = 0 |

A returned `Decision` is always authoritative. **Service-unreachable** (a transport error) is a separate
concern the *client* settles by its own fail-open/closed policy — it is not a field in the proto. This
matches the library's `fail: open|closed` semantics; the one new row ("service unreachable") belongs in
`docs/FAILURE-MODES.md` when the door ships.

## DECISION — a standalone `throttlekit-server` package (this repo)

The service core is pure, but the **gRPC server binding needs `@grpc/grpc-js`** (and
`@grpc/proto-loader`) — the first runtime dependency anywhere near ThrottleKit, whose 1.0 core is
**frozen and sells "zero runtime dependencies."** So where the binding lives is a product decision.
**Decided (2026-05-31, user delegated "do what is better long term / robust / scalable"): a standalone
package `throttlekit-server` in this repo** — *not* a subpath of the core, *not* a workspaces relocation
of the core.

- **Why standalone over a core subpath:** keeps the core 1.0 **zero-dep + frozen + export-matrix
  untouched**; `@grpc/grpc-js`'s dependency/CVE surface never reaches a core consumer; the server
  versions, releases, and containerizes on its own pre-1.0 cadence.
- **Why this repo over its own repo:** the server is the **first consumer of the `wire/` contract** and
  runs the core directly, so proto/contract/server changes stay **atomic in one CI run**. That is the
  opposite of `throttlekit-py`, which is loosely coupled (different ecosystem, vendors the contract with
  a checksum gate) and rightly lives in its own repo. Coupled → same repo; decoupled → separate repo.
- **The boundary that makes it clean:** the server depends on **published `throttlekit@^1.0.1` and imports
  only its public API** (`createEnforcer`, `loadConfig`, the strategies, the core types — all already
  exported). The server *dogfoods the frozen 1.0 surface*; the core needs **no change at all** (not even
  a new export). Root tooling simply excludes `server/`.
- **The transport-agnostic service core moves into the server package** (`server/src/service.ts`), since
  "a service" is a server concept, not a core-library one. The core stays free of it.

**Proto binding:** dynamic **`@grpc/proto-loader`** over the committed `throttlekit.proto` — no codegen
step, no generated stubs to maintain. `keepCase:false` (the default) yields camelCase accessors that line
up with the core `Decision` field names, so the mapping is near-identity.

*Options considered and rejected: a `throttlekit/server` subpath with `@grpc/grpc-js` as an
`optionalDependency` (dilutes the zero-dep promise, grows the frozen export matrix, and the server
genuinely needs the dep); a CLI-only `throttlekit serve` (no embeddable `serve()`, deps still enter the
core tree); a full workspaces relocation of the core into `packages/*` (high blast radius on a frozen,
published, green 1.0 package for no benefit the standalone package doesn't already give).*

## Phase 2 status

1. ✅ The gRPC binding — `RateLimiter` (`Check`/`CheckMany`/`Peek`/`Forecast`) over the service core;
   errors → status codes (`NOT_FOUND`/`UNIMPLEMENTED`/`INTERNAL`; `RESOURCE_EXHAUSTED` is *not* used — a
   denial is a normal `Decision`).
2. ✅ `throttlekit-server` CLI — loads `.throttlekit.yaml` and serves; **memory + shared Redis** (`--redis`
   via ioredis ⇒ fleet mode), `--fail`, graceful drain. (`src/runtime.ts` makes store/creds testable.)
3. ✅ End-to-end contract test — a real in-process server + client replays the vectors, green.
4. ✅ **Auth (TLS + mTLS)** via `--tls-cert/--tls-key/--tls-ca` (insecure-on-non-loopback warning), a
   **Dockerfile** (repo-root context, bundles the single-source proto), and a failure-modes table incl.
   the "service unreachable" row — in the **server README** (keeps the core untouched). Remaining
   (optional): a shared-secret auth alternative; an Envoy RLS proto for mesh reach.
5. ⬜ Release posture: pick the npm name (`throttlekit-server` vs a `@throttlekit/*` scope), flip
   `private:false`, `prepack` bundles the proto. Independent pre-1.0 cadence from the frozen core.

## Open decisions (carried from DESIGN.md)

- The packaging fork above (the blocker for the binding slice).
- Whether to implement the Envoy RLS proto for Istio/Envoy mesh drop-in.
- When the direct `RedisBackend` (Phase 4) lands — that, not the service, is the single trigger to
  consider freezing the raw Lua wire (bet #78).
