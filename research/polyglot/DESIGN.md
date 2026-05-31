# Polyglot expansion — design & wiring

**Status:** Phases 1–4 landed. Phase 1 = the contract foundation in this repo (the golden-vector
behavioral lock `wire/vectors/`, the extracted-Lua byte lock `wire/scripts/*.lua` + `manifest.json`
sha256-pinned, the human spec `wire/WIRE-PROTOCOL.md`, the service-door gRPC contract
`wire/throttlekit.proto`). Phase 2 = the **service door** (`server/`, the `throttlekit-server` package;
see `PHASE2-SERVICE.md`). Phase 3 = the **`throttlekit-py`** client with `ServiceBackend`. Phase 4 = the
direct **`RedisBackend`** (experimental), proven bit-for-bit against the full golden vectors via real
Redis (see `PHASE4-REDIS-BACKEND.md`). Both doors now serve a polyglot client. **Nothing is frozen** —
the wire freeze (#78) remains **deferred** pending explicit reauthorization (DR-78). This doc records the
decided architecture so it survives across sessions.

## The decision: a layered hybrid, not a second library

Serve polyglot through **one core, one contract, two delivery doors, thin clients** — *not* by porting
the whole library per language.

```
              ┌──────────────────────────────────────────────────┐
              │ ONE CORE — Node/TS (this repo · 1.0 · API frozen) │
              │ algorithms · Lua twin · stores · createEnforcer() │
              │   ── the ONLY place a Decision is ever computed ──│
              └───────────────┬──────────────────────────────────┘
                              │ produces (Phase 1, in this repo)
                              ▼
              ┌──────────────────────────────────────────────────┐
              │ CONTRACT (shared yardstick + interfaces)          │
              │ WIRE-PROTOCOL.md · *.lua · golden-vectors.json ·  │
              │ throttlekit.proto · manifest(sha256) · version    │
              └──────┬──────────────────┬────────────────┬────────┘
         consumed by │   implemented by │     consumed by │
                     ▼                  ▼                 ▼
               Node lib (embed)   ThrottleKit SERVICE   throttlekit-py (thin)
               [exists]           core + gRPC adapter    pluggable backend:
                                  owns Redis/PG + Lua     ├ ServiceBackend → gRPC
                                  speaks the proto        └ RedisBackend  → vendored Lua
                                  (+ optional Envoy RLS)   + optional L1 lease over either
```

### The load-bearing invariant

> **Exactly one thing computes a `Decision`: the Node core** — directly, as Lua-in-Redis, or inside the
> service. Everything else is a *pipe*, validated against the golden vectors. No surface re-derives the
> math. Hold this and the hybrid can't sprawl; lose it and you maintain N rate limiters. A future
> in-process language *port* is the one exception — gated by the same vectors and flagged as a distinct
> drift-risk implementation, explicitly outside the default hybrid.

## Why a service door at all (the key insight)

The decision math runs **server-side in Lua** for Redis, but **client-side in the JS transform** for
Postgres and in-memory (`src/postgres/store.ts` runs `transform(state)` in JS inside a txn). So a Redis
library client inherits the proof for free, but a Postgres/in-process client would require a real
algorithm **port** (with float-determinism risk). A **service** sidesteps that entirely: the core runs
in one place, clients are trivial RPC stubs, and you freeze a **protobuf** (designed to evolve) instead
of brittle Lua internals. It also kills the cross-language drift problem and, via the **Envoy RLS**
proto, drops into any Istio/Envoy mesh. Cost: an extra hop (mitigated by a co-located sidecar), running
a service, and the in-process speed lever moving into the service (recovered with a leased/batch RPC).

CPython reality: the **169 ns** sync number does **not** transfer (~µs in CPython), so the in-process
Python value prop is weak — another reason to lead with the (network-bound) distributed doors.

## Contract artifacts

| Artifact | Produced by | Consumed by | Freeze posture |
|---|---|---|---|
| `golden-vectors.json` | core oracle (`wire/`) | every surface's CI | **append-only** behavioral contract (**done**) |
| `*.lua` (extracted) | single-sourced from the lib (`wire/scripts/extract.ts`) | lib, service, `RedisBackend` | **done** — byte-locked, not frozen (frozen only when `RedisBackend` goes public) |
| `WIRE-PROTOCOL.md` | hand-written (`wire/`) | humans, `RedisBackend` | **done** — documented, not frozen |
| `throttlekit.proto` (`throttlekit.v1`) | hand-written (`wire/`) | service, `ServiceBackend` | **done** — versioned + additive, the comfortable freeze |
| `manifest.json` sha256 + `contractVersion` | `npm run wire:scripts` | the drift gate (`test/wire/`) | **done** — pinned, regen-checked in CI |

## Runtime flows

| Path | Hops | Decision computed in | Needs the raw wire? |
|---|---|---|---|
| Node embeds the lib | 1 | Lua-in-Redis (or in-proc) | n/a |
| Py → service (sidecar) | 2 | the service (= the core) | **no** — only the proto |
| Py → direct Redis | 1 | Lua-in-Redis (same script) | **yes** — vendored Lua |
| Either + L1 lease | ~0 (local) | local serving; refill via Lease/Redis | per backend |
| Envoy/Istio mesh | 1 | the service | no (Envoy RLS proto) |

## The freeze posture (and the single trigger)

- **Core API**: frozen (1.0).
- **Proto**: `throttlekit.v1`, additive-evolvable — safe to stabilize from day one.
- **Golden vectors**: append-only; a changed `expect` ⇒ `contractVersion` bump.
- **Raw Lua wire**: documented + behavior-locked here, **NOT declared frozen** until the direct
  `RedisBackend` is promoted to a supported, externally-pinned surface. **That promotion is the only
  trigger to freeze the wire.** Until then the whole hybrid (service + `ServiceBackend` client) ships
  with only the proto + vectors as commitments.

### DR-78 — wire freeze evaluated and **DECLINED** (2026-05-31)

With Phases 1–3 shipped (service door + `ServiceBackend`, the polyglot loop proven end-to-end with **no**
wire commitment), the freeze was re-evaluated at the user's delegation and **deliberately declined — hold
the wire unfrozen.** Reasoning:

- **Reversibility asymmetry.** Not-freezing is free and reversible; freezing is an irreversible promise.
  The option value of waiting dominates because the cost of waiting is ~zero (the service door already
  serves every polyglot client).
- **No consumer.** No `RedisBackend` exists yet, so freezing would pin a contract nothing uses — *before*
  the trigger the strategy itself defined (a shipped client proving demand).
- **Preserves core freedom.** The Lua is the core's *internal implementation* (1.0 freezes the API, not
  the scripts). Freezing the wire would convert it into a public contract and forfeit future script
  optimizations (fused scripts, tighter encodings, TTL changes).

The trigger is unchanged and the guard stands: **a future freeze still needs explicit reauthorization.**
A direct `RedisBackend` may still be built **experimentally** (vendored Lua + the sha256 drift-gate,
shipped `frozen:false` / may-change) *without* freezing — the freeze is the support *promise*, not a
prerequisite for the code. Building that experimental client is what would generate the real demand
signal a future freeze should wait on.

## Phases

1. **Contract foundation** *(this repo, reversible, Node-valuable)* — **DONE**: golden vectors + the
   behavior lock; extracted Lua to single-sourced `wire/scripts/*.lua` + the byte lock; `manifest.json`
   (sha256-pinned); `WIRE-PROTOCOL.md`; `throttlekit.proto`. `npm run wire` regenerates everything.
2. **The service** *(this repo: the `throttlekit-server` package + container)* — **mostly DONE**:
   `createEnforcer()` + gRPC over the proto, policies from `.throttlekit.yaml`, end-to-end contract test
   ≡ vectors (green). Standalone package depending on published `throttlekit` (core untouched, zero-dep
   preserved). Remaining: distributed-store CLI wiring, auth (mTLS), container, optional Envoy RLS. See
   `research/polyglot/PHASE2-SERVICE.md`.
3. **`throttlekit-py`** *(new repo)* — **DONE**: scaffold + `sync_contract` + drift gate; `ServiceBackend`
   (the cheapest real polyglot MVP); marked experimental.
4. **`RedisBackend`** (direct Lua) + cross-client conformance — **DONE** (experimental, in `throttlekit-py`).
   The full, time-parametrized golden vectors replay through Python → vendored Lua → real Redis and match
   the Node oracle **bit-for-bit on all five reply fields** (`check`-only; `peek`/`forecast` stay on the
   service door to preserve the one-oracle invariant). This shipped the demand signal a freeze should wait
   on, but per **DR-78 the wire stays unfrozen** — experimental shipping is not the trigger (promotion to a
   *supported* surface is), and a future freeze still needs reauthorization. See `PHASE4-REDIS-BACKEND.md`.
5. **L1 lease loop** over either backend; more languages on demand (same vectors).

## Details that bite if skipped

- **Shared clock** — distributed paths must derive window boundaries from Redis server time
  (`useServerTime`), or a Python and a Node client skew on the same limit.
- **Key scheme** is part of the contract (clients sharing a limit must agree on the prefix/layout).
- **Failure semantics** carry through: `fail: open|closed` everywhere; one extra row for
  "service unreachable" in `docs/FAILURE-MODES.md`.
- **Service auth** (mTLS / shared secret) is table-stakes so nothing can poison the budget.
- **Observability is a contract** — the service emits the same OTel attributes + Prometheus names so a
  polyglot fleet has one dashboard.

## Open decisions for later

- Repo topology: single `throttlekit-py` vs. `+ throttlekit-contract` vs. service-in-this-repo.
  *(Lean: contract + service live here; clients in `throttlekit-py`.)*
- Whether/when to authorize the wire freeze (gated on a shipped experimental client proving demand).
- Whether to implement the Envoy RLS proto for mesh reach.
