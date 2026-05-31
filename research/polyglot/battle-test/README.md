# Polyglot battle test

A realistic, multi-process **distributed workload** that exercises every ThrottleKit axis end-to-end
across **both repos** — the Node core/server ([`throttlekit`](../../..) + [`server/`](../../../server))
and the Python client ([`throttlekit-py`](https://github.com/AmeyaBorkar/throttlekit-py)) — and asserts a
real-world invariant per phase.

It is **research/dev tooling**: committed to the repo but excluded from the published npm package (the
`files` allowlist), so it never ships in the wheel. It is not part of `npm test`; run it on demand.

## What it does

It stands up a **3-instance `throttlekit-server` fleet sharing one real Redis**, then drives load from the
Python client through **both delivery doors** at once:

```
                          ┌───────────────────────────────────────────────┐
   throttlekit-py         │   throttlekit-server fleet  (3 instances)      │
   (the workload)         │   ┌─────────┐  ┌─────────┐  ┌─────────┐        │
                          │   │ :p0     │  │ :p1     │  │ :p2     │  = the  │
   ServiceBackend ──gRPC──┼──▶│ core    │  │ core    │  │ core    │   Node  │
                          │   └────┬────┘  └────┬────┘  └────┬────┘   core  │
                          │        └───────────┬┴────────────┘  (one oracle)│
                          └────────────────────┼──────────────────────────-┘
                                               ▼
   RedisBackend ───────────────────────▶  shared Redis  ◀─── (vendored Lua, the same scripts)
   (vendored Lua, direct)                 (one keyspace)
```

Both doors compute decisions in the **one** Node core — the `ServiceBackend` over gRPC, the `RedisBackend`
by running the core's own vendored Lua straight against the same Redis. Phase C proves they share one
bucket bit-for-bit.

## Phases & invariants

| # | Phase | Real-world scenario | Invariant asserted |
|---|---|---|---|
| A | distributed rate cap | 3 servers, 1 shared limit, 1200 reqs over 3 keys | **exact** global count == calibrated cap (no fleet leak) |
| A2 | read surface | `peek` / `forecast` / `check_many` | peek non-consuming; a consuming check decrements; batch works |
| A3 | operational faults | wrong-axis ops + unknown policy | `admit`-on-rate / `check`-on-admitter → **UNIMPLEMENTED**; unknown → **NOT_FOUND** |
| B | direct door | all 5 strategies + Lua atomicity (16 threads) | exact cap per strategy; **no double-spend** under concurrency |
| C | one oracle, two doors | gRPC + direct Lua on the same key | **one shared bucket** (combined == cap, not 2×) |
| D | cost axis | 4 LLM-gateway tenants stream token debits | stops at budget; **isolated** per tenant; none admitted after deny |
| E | concurrency | 40 workers vs a pinned cap | in-flight **never exceeds** the cap, and **reaches** it |
| F | unified rate × concurrency | hold vs immediate-release loops | the **correct** axis binds, and `binding_axis` reports it |
| G | crash safety | SIGKILL a client holding a full cap | orphaned leases **reclaimed on TTL** |
| H | heartbeat | hold past the 2s lease TTL | heartbeat **keeps the slot**; freed on release |
| I | two-tier leased | 1500 reqs (3× budget) across the fleet | **windowCoupled overshoot bound**: total ≤ limit, fleet-size-independent |

## Latest run — 2026-05-31

`node v24.13.1`, `Python 3.13.12`, Redis 7 (Docker, `localhost:6380`), Windows 11. Full output in
[`logs/`](./logs).

**Cross-repo workload — [`logs/battletest.log`](./logs/battletest.log): 11/11 phases passed.**

| Phase | Result |
|---|---|
| A distributed rate | `allowed/key = [200, 200, 200]` over 1200 reqs (naive per-instance would leak up to 600/key) |
| B direct door | gcra 100 · tokenBucket 80 · fixedWindow 90 · slidingWindow 70 · slidingWindowLog 60; atomic **100/100** |
| C two doors, one bucket | combined **200** (service 100 + direct 100) on one key; two buckets would give 400 |
| D cost axis | 4 tenants, each stops at exactly **100000**, isolated |
| E concurrency | 40 workers vs cap 8 → max in-flight **8**, 596 granted / 8035 denied |
| F unified | concurrency binds (max 4, 2410 denials); rate binds (50 allowed, 70 rate-denials, 0 concurrency-denials) |
| G crash safety | child held 8/8, SIGKILL → reclaimed on TTL |
| H heartbeat | cap-1 hold survived 3.5s > 2s TTL, blocked a competitor, freed on release |
| I two-tier leased | 1500 reqs → total allowed **500** (windowCoupled bound; naive would admit 1500) |

**Core engine, native — [`logs/bench-core-engine.log`](./logs/bench-core-engine.log) + [`logs/bench-compare.log`](./logs/bench-compare.log):**

- In-process: gcra `checkSync` **176 ns/op (5.68M ops/s)**, tokenBucket 201 ns, fixedWindow 240 ns; concurrency acquire+release 291 ns.
- Redis path: strict gcra p50 **1.41 ms** (one round trip — Docker-on-Windows network-dominated) → **leased gcra 65.8k ops/s**, i.e. two-tier batching amortizes the round trip ~**90×**.
- Head-to-head (async, fair): throttlekit GCRA **3.35M ops/s** vs `rate-limiter-flexible` 2.85M; on Redis it's a dead heat (722 vs 723 ops/s) — but only throttlekit also offers the 90×-faster leased path.

## Run it yourself

Prerequisites:

1. **Build the server** (from the repo root): `cd server && npm install && npm run build`.
2. **Install the Python client** into a venv: `pip install throttlekit-py redis` (or `pip install -e .` in
   a `throttlekit-py` checkout). Run the harness with *that* interpreter.
3. **A reachable Redis.** Defaults to the repo's local test Redis at `redis://localhost:6380`; override
   with `THROTTLEKIT_REDIS_URL`.

```bash
THROTTLEKIT_REDIS_URL=redis://localhost:6380 python battletest.py
```

The harness allocates its own ports, namespaces every Redis key under a per-run prefix, tears the fleet
down, and deletes its keys on exit. Exit code is `0` iff all phases pass. Transient per-server logs go to
the system temp dir, not here.

## Scope — what this does *not* cover

Honest boundaries (each is covered by the repos' own suites, or needs infra this harness doesn't stand up):

- **Postgres** store/coordinator — needs a running Postgres (`tk-postgres:5433`); skipped here.
- **Federation** (cross-region L2 reconciliation) — needs a multi-cluster stand-up.
- **TLS/mTLS** on the service door — validated at smoke level, not under load.
- **Node framework adapters** (express/fastify/koa/hono/next/…) — Node-only middleware, not reachable
  from the Python client.
- The **cost** and **concurrency** axes are exercised **single-instance by design** (as documented — the
  token-budget meter and the concurrency guard are per-gateway primitives today); the fleet-coordinated
  ceiling is the separate `distributedAdaptiveConcurrency` path.

## A note on the A2 "decrements" tolerance

Phase A2 asserts a consuming `check` drops `remaining` by **1 or 2**, not exactly 1. On a non-monotonic
wall clock (notably Windows `Date.now()`) a sub-millisecond *backward* step between the `check` and the
following `peek` can knock gcra's `remaining` floor down one extra cell. The allow/deny **decision** is
unaffected — the 18s emission interval dwarfs any ms-scale jitter — so the exact-count phases (A/B/C)
stay exact; only this introspection field is boundary-sensitive. (This is the same "Windows `Date.now`"
caveat noted in [`BENCH.md`](../../../BENCH.md).)
