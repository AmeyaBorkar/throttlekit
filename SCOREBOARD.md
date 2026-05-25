# ThrottleKit — Scoreboard

Whether the project meets its stated expectations. Legend: ✅ met · 🟡 partial · ⬜ not started.

Benchmarks below were produced by `npm run bench -- --redis` (with `--expose-gc`) on the dev
machine — Windows 11, Node v24.13.1, single-node Redis 7 in Docker over the loopback. They are
reproducible on your hardware, not vendor claims. Redis latency here is loopback-Docker-on-Windows
(NAT-bound); native Linux / CI is lower.

## Performance budgets (design targets from §11)

| Path | Target | Measured | Status |
|---|---|---|---|
| In-memory `checkSync` (GCRA) | sub-microsecond; ~0 steady-state allocations | **319 ns/op (3.13M ops/s)**, ~5 B/op (fixedWindow 0 B/op) | ✅ |
| In-memory `check` (async) | low single-digit microseconds | **1.6 µs/op (608k ops/s)** | ✅ |
| Redis `strict` decision | exactly **1** round trip | **1 EVALSHA / req**; p50 1.4ms / p99 2.1ms (loopback) | ✅ |
| `leased` steady state | ~**1 round trip per B** requests | **exactly 100 reqs / round trip** at batch 100 | ✅ |
| Multi-dimensional (k axes) on Redis | **1** round trip regardless of k | **1 fused EVALSHA** over k keys (conformance-proven) | ✅ |

Token bucket `checkSync` 372 ns/op (2.69M ops/s); fixed window `checkSync` 480 ns/op (2.08M ops/s, 0 B/op).

## Correctness guarantees (§12)

| Guarantee | How proven | Status |
|---|---|---|
| Atomicity: N concurrent at limit K ⇒ exactly K allowed (memory) | atomicity test (gcra/fixed/slidingLog, K=50 of N=200) | ✅ |
| Atomicity in Redis (Lua) | atomicity test (gated, exactly K) | ✅ |
| JS ↔ Lua dual-path bit-identical decisions | conformance suite (6 strategies + multi-dim, both modes) | ✅ |
| `remaining` never negative; integer decisions; retryAfter==0 iff allowed | property tests (fast-check) | ✅ |
| Leased overshoot ≤ L×batch | property test (multi-node, refill boundary) | ✅ |
| Clock-jump safety (negative elapsed clamped) | unit tests | ✅ |
| Defined fail-open / fail-closed on store error | adapter unit tests | ✅ |
| `ttl ≥ 1` under extreme params (ULP edge) | found by bench, guarded JS+Lua | ✅ |

## Feature matrix (§18 differentiators)

| Capability | Status |
|---|---|
| GCRA (single-timestamp) default | ✅ |
| Token bucket · Fixed window | ✅ |
| Sliding window counter (sub-bucketed) · Sliding window log (exact) | ✅ |
| Leaky bucket / queueing (`schedule`/`reserve`) | ✅ |
| Adaptive concurrency (gradient2 + aimd) | ✅ |
| MemoryStore (timing wheel + CLOCK approx-LRU) | ✅ |
| RedisStore (atomic Lua, 1 RTT, OCC fallback) | ✅ |
| Two-tier local cache (strict / cached-deny / leased) | ✅ |
| Token leasing (network-light) | ✅ |
| Multi-dimensional, 1 fused round trip (`all`/`any`) | ✅ |
| Express adapter · Web `fetch`/edge adapter | ✅ |
| Injectable clock / determinism (`ManualClock`) | ✅ |
| OpenTelemetry metrics + gauges | ✅ |
| IETF (draft + structured) + legacy headers, `Retry-After` | ✅ |
| Proxy-correct IP + IPv6 /64 aggregation + HMAC keys | ✅ |
| Store conformance testkit | ✅ |
| TypeScript-first, ESM + CJS, 6 entry points | ✅ |

## Quality gates

| Gate | Status |
|---|---|
| `biome check` clean (0 warnings) | ✅ |
| `tsc --noEmit` clean (strict, incl. examples) | ✅ |
| Test coverage on `src` | ✅ **96.8% lines**, 96.5% funcs, 83.4% branch (220 tests) |
| CI green (lint, typecheck, test matrix node 20/22/24 + Redis service, build) | ✅ |
| Build emits valid ESM + CJS + types (6 subpaths) | ✅ |
