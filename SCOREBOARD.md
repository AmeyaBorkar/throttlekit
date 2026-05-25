# ThrottleKit — Scoreboard

Whether the project meets its stated expectations. Legend: ✅ met · 🟡 partial · ⬜ not started.

Benchmarks below were produced by `npm run bench -- --redis` (with `--expose-gc`) on the dev
machine — Windows 11, Node v24.13.1, single-node Redis 7 in Docker over the loopback. The
head-to-head numbers come from `npm run bench:compare`. All are reproducible on your hardware, not
vendor claims, and vary ±10% run-to-run. Redis latency here is loopback-Docker-on-Windows
(NAT-bound); native Linux / CI is lower.

## Performance budgets (design targets from §11)

| Path | Target | Measured | Status |
|---|---|---|---|
| In-memory `checkSync` (GCRA) | sub-microsecond; ~0 steady-state allocations | **316 ns/op (3.17M ops/s)**, ~4 B/op (fixedWindow 0 B/op) | ✅ |
| In-memory `check` (async) | low single-digit microseconds | **608 ns/op (1.64M ops/s)** — 2.7× faster after the sync-store fast path | ✅ |
| Redis `strict` decision | exactly **1** round trip | **1 EVALSHA / req**; p50 1.4ms / p99 2.1ms (loopback) | ✅ |
| `leased` steady state | ~**1 round trip per B** requests | **exactly 100 reqs / round trip** at batch 100 | ✅ |
| Multi-dimensional (k axes) on Redis | **1** round trip regardless of k | **1 fused EVALSHA** over k keys (conformance-proven) | ✅ |

Token bucket `checkSync` 382 ns/op (2.62M ops/s); fixed window `checkSync` 465 ns/op (2.15M ops/s).

## Versus alternatives (`npm run bench:compare`)

Same process, same machine, same warmup + iteration count, all on the allow path. The algorithm
each library actually implements is labelled — a fixed-window counter and a GCRA cell are not the
same guarantee even at equal ops/s. Nothing hidden or cherry-picked.

**In-memory, single hot key:**

| Library | Algorithm | API | ops/s | ns/op |
|---|---|---|---|---|
| **throttlekit** | GCRA | `checkSync` (sync) | **3.2M** | 312 |
| **throttlekit** | GCRA | `check` (async) | 1.67M | 599 |
| throttlekit | fixed-window | `check` (async) | 1.53M | 652 |
| rate-limiter-flexible | fixed-window | `consume` (async) | 2.89M | 346 |
| express-rate-limit | fixed-window | store `increment` (async) | 4.17M | 240 |

ThrottleKit owns the **sync** path (allocation-free; no incumbent offers a sync API) and is
competitive on async — all contenders are in the millions/sec, far beyond real-world need. The
incumbents' async edge is a bare fixed-window counter; ThrottleKit's headline path is GCRA over a
timing-wheel + CLOCK store (smooth pacing, bounded memory), so its richer per-check work is the
trade. The `throttlekit` fixed-window row is the apples-to-apples comparison.

**Redis (loopback, identical ioredis client / server / DB):**

| Library | Algorithm | ops/s | p50 | p99 |
|---|---|---|---|---|
| **throttlekit** | GCRA | ~640 | ~1.5 ms | ~2.3 ms |
| rate-limiter-flexible | fixed-window | ~645 | ~1.5 ms | ~2.5 ms |

Both do one atomic Lua round trip per request; statistically tied (latency-bound, serial awaits —
not pipelined). `@upstash/ratelimit` is excluded: it requires the Upstash cloud REST endpoint and
can't be benchmarked locally on equal footing.

## Correctness guarantees (§12)

| Guarantee | How proven | Status |
|---|---|---|
| Atomicity: N concurrent at limit K ⇒ exactly K allowed (memory) | atomicity test (gcra/fixed/slidingLog, K=50 of N=200) | ✅ |
| Atomicity in Redis (Lua) | atomicity test (gated, exactly K) | ✅ |
| JS ↔ Lua dual-path bit-identical decisions | conformance suite (6 strategies + multi-dim, both modes; ioredis + node-redis) | ✅ |
| `remaining` never negative; integer decisions; retryAfter==0 iff allowed | property tests (fast-check) | ✅ |
| Leased overshoot bound (tight: `Limit + N·(Batch−1)`, implies ≤ L×batch) | **TLA+/TLC model-checked** + Java-free exhaustive JS checker (same state counts) + property test | ✅ |
| Clock-jump safety (negative elapsed clamped) | unit tests | ✅ |
| Defined fail-open / fail-closed on store error | adapter unit tests (all 6 adapters) | ✅ |
| `ttl ≥ 1` under extreme params (ULP edge) | found by bench, guarded JS+Lua | ✅ |

## Feature matrix (§18 differentiators)

| Capability | Status |
|---|---|
| GCRA (single-timestamp) default | ✅ |
| Token bucket · Fixed window | ✅ |
| Sliding window counter (sub-bucketed) · Sliding window log (exact) | ✅ |
| Leaky bucket / queueing (`schedule`/`reserve`) | ✅ |
| Adaptive concurrency (gradient2 + aimd) | ✅ |
| Adaptive load-shedding (`adaptiveThrottle`, SRE) + cross-tenant fairness (`fairShare`) | ✅ |
| MemoryStore (timing wheel + CLOCK approx-LRU) | ✅ |
| RedisStore (atomic Lua, 1 RTT, OCC fallback) — ioredis · node-redis · Upstash REST | ✅ |
| Two-tier local cache (strict / cached-deny / leased) | ✅ |
| Token leasing (network-light) | ✅ |
| Multi-dimensional, 1 fused round trip (`all`/`any`) | ✅ |
| Huge-cardinality / DDoS sketch (`sketchRateLimit`) — bounded memory, provably never over-admits | ✅ |
| Adapters: Express · Web `fetch`/edge · Hono · Next.js · Fastify · Koa | ✅ |
| Injectable clock / determinism (`ManualClock`) | ✅ |
| OpenTelemetry metrics + gauges | ✅ |
| Built-in analytics (`withAnalytics`) — allow/deny + Space-Saving top-K heavy hitters | ✅ |
| IETF (draft + structured) + legacy headers, `Retry-After` | ✅ |
| Proxy-correct IP + IPv6 /64 aggregation + HMAC keys | ✅ |
| Store conformance testkit | ✅ |
| TypeScript-first, ESM + CJS, 10 entry points | ✅ |

## Quality gates

| Gate | Status |
|---|---|
| `biome check` clean (0 warnings) | ✅ |
| `tsc --noEmit` clean (strict, incl. examples) | ✅ |
| Test coverage on `src` | ✅ **96.9% lines**, 95.2% funcs, 86.4% branch (355 tests) |
| CI green (lint, typecheck, test matrix node 20/22/24 + Redis service, build) | ✅ |
| Build emits valid ESM + CJS + types (10 subpaths) | ✅ |
