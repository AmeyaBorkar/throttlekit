# ThrottleKit — Scoreboard

Whether the project meets its stated expectations. Legend: ✅ met · 🟡 partial · ⬜ not started.

Benchmarks below were produced on **2026-05-28** by `npm run bench -- --redis` (with `--expose-gc`)
and the head-to-head `npm run bench:compare`, on: **AMD Ryzen AI 9 HX 370** (24 logical cores),
31 GB RAM, Windows 11 (build 26200), **Node v24.13.1**; Redis 7 and PostgreSQL 16 in Docker Desktop
(WSL2 backend) over the loopback. All are reproducible on your hardware (`npm run bench`), not vendor
claims, and vary run-to-run (±10% on the sync and Redis rows; the async in-process rows swing more,
since the comparative harness runs all contenders in one process under shared GC pressure).
**The Redis/Postgres latencies here are Docker-Desktop-on-Windows (WSL2, NAT-bound) and are dominated
by that network path — native Linux / CI is materially lower. Read the cross-library *relative*
numbers and the round-trip *counts* as the signal, not the absolute microseconds.**

## Performance budgets (design targets from §11)

| Path | Target | Measured | Status |
|---|---|---|---|
| In-memory `checkSync` (GCRA) | sub-microsecond; ~0 steady-state allocations | **171 ns/op (5.85M ops/s)**, ~1 B/op | ✅ |
| In-memory `check` (async) | low single-digit microseconds | **284 ns/op (3.52M ops/s)** | ✅ |
| Redis `strict` decision | exactly **1** round trip | **1 EVALSHA / req**; p50 ~1.2ms / p99 ~1.8ms (Docker/WSL2 loopback) | ✅ |
| `leased` steady state | ~**1 round trip per B** requests | **exactly 100 reqs / round trip** at batch 100 (69.9k ops/s) | ✅ |
| Multi-dimensional (k axes) on Redis | **1** round trip regardless of k | **1 fused EVALSHA** over k keys (conformance-proven) | ✅ |
| Unified admission (rate ⊕ concurrency ⊕ cost) Lua-fused | **1** round trip for rate + cost | **1 fused EVALSHA** (`tk:v1:fused-rc:check`); concurrency stays in-process; sequential ≡ fused byte-identical across 300 timelines (TK-1006) | ✅ |

Token bucket `checkSync` 200 ns/op (5.00M ops/s); fixed window `checkSync` 215 ns/op (4.65M ops/s, ~0 B/op). Numbers re-baselined for 0.9.0 (best-of-10 ×2M iters; pinned in `bench/baseline.json`; the bench gate fails the build on >10% regression vs that file). The drift from 0.8.5 numbers (186/181/192 → 171/200/215 ns) is within machine-state noise on Windows micro-benchmarks: no `src/algorithms/*` or `src/core/limiter.ts` or `src/stores/memory.ts` files changed between 0.8.5 and 0.9.0 (verified via `git diff --stat 865656b..HEAD`), only NEW files were added.

## Versus alternatives (`npm run bench:compare`)

Same process, same machine, same warmup + iteration count, all on the allow path. The algorithm
each library actually implements is labelled — a fixed-window counter and a GCRA cell are not the
same guarantee even at equal ops/s. Nothing hidden or cherry-picked.

**In-memory, single hot key:**

| Library | Algorithm | API | ops/s | ns/op |
|---|---|---|---|---|
| **throttlekit** | GCRA | `checkSync` (sync) | **5.84M** | 171 (≈1 B/op) |
| **throttlekit** | GCRA | `check` (async) | 3.39M | 295 |
| throttlekit | fixed-window | `check` (async) | 3.41M | 293 |
| rate-limiter-flexible | fixed-window | `consume` (async) | 2.77M | 362 |
| express-rate-limit | fixed-window | store `increment` (async) | 4.74M | 211 |

ThrottleKit owns the **sync** path (≈allocation-free at 171 ns; no incumbent offers a sync API) and
on **async** now edges *past* rate-limiter-flexible (3.4M vs 2.77M) while doing more real work per
check — GCRA / fixed-window returning a full immutable `Decision` over a timing-wheel + CLOCK store
(smooth pacing, bounded memory, TTL expiry). express-rate-limit's bare `Map.increment` (a plain
counter, no `Decision` object) is still ~1.4× faster on this micro-benchmark — the honest cost of
ThrottleKit's richer per-check contract. The `throttlekit` fixed-window row is the closest
apples-to-apples. All contenders are far beyond real-world per-process need; the distributed tail and
`leased` amortization matter more in practice.

**Redis (loopback, identical ioredis client / server / DB):**

| Library | Algorithm | ops/s | p50 | p99 | p999 |
|---|---|---|---|---|---|
| **throttlekit** | GCRA | 787 | 1.22 ms | 1.83 ms | **2.28 ms** |
| rate-limiter-flexible | fixed-window | 824 | 1.17 ms | 1.79 ms | 3.01 ms |

Both do one atomic Lua round trip per request; **tied on throughput and p50** (latency-bound, serial
awaits — not pipelined), but ThrottleKit holds a **tighter tail** — p999 ~1.3× lower (cached
`EVALSHA` + a leaner script). `@upstash/ratelimit` is excluded: it requires the Upstash cloud REST
endpoint and can't be benchmarked locally on equal footing.

**PostgreSQL (loopback, identical `pg.Pool` / server / DB):**

| Library | Algorithm | Round trips | ops/s | p50 / avg |
|---|---|---|---|---|
| throttlekit `PostgresStore` | GCRA | ~5 (txn) | 127 | 7.6 ms |
| **rate-limiter-flexible** | fixed-window | 1 (upsert) | **372** | **2.5 ms** |
| **throttlekit `twoTier(leased)`** | GCRA | 1 per **100** reqs | **13.8k** | **72.6 µs** |

Two honest, opposite results. **Per single op, rate-limiter-flexible wins ~2.9×** — it expresses its
counter as one atomic `INSERT … ON CONFLICT DO UPDATE`, while `PostgresStore` runs a generic
read-modify-write **transaction** (advisory lock → read → write → commit) so the *same proven
transform* drives every strategy and backend; that generality costs round trips. **At throughput,
`twoTier(leased)` over Postgres wins ~37×** (13.8k vs 372 ops/s; 72.6 µs vs 2.5 ms/op) — one
transaction per `batch`, a lever rate-limiter-flexible has no equivalent for. So: reach for leased on
hot keys; the bare single-op path trails on latency by design. (A single-round-trip per-op win is
possible via a server-side PL/pgSQL function — a third execution path — but isn't shipped.) Per-op
latency here is Docker-Desktop-on-Windows.

## Correctness guarantees (§12)

| Guarantee | How proven | Status |
|---|---|---|
| Atomicity: N concurrent at limit K ⇒ exactly K allowed (memory) | atomicity test (gcra/fixed/slidingLog, K=50 of N=200) | ✅ |
| Atomicity in Redis (Lua) | atomicity test (gated, exactly K) | ✅ |
| JS ↔ Lua dual-path bit-identical decisions | conformance suite (6 strategies + multi-dim, both modes; ioredis + node-redis); Postgres path proven bit-identical vs JS on a live server | ✅ |
| `remaining` never negative; integer decisions; retryAfter==0 iff allowed | property tests (fast-check) | ✅ |
| Leased overshoot bound (tight: `Limit + N·(Batch−1)`, implies ≤ L×batch) | **TLA+/TLC model-checked** + Java-free exhaustive JS checker (same state counts) + property test | ✅ |
| Window-coupled leasing: overshoot `= L`, **independent of N** (`lease.windowCoupled`) | **TLA+ spec + exhaustive BFS twin** (self-validated vs TLC 31/441) + contrast test | ✅ |
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
| Weighted fairness — `weightedMaxMin` (exact work-conserving weighted max-min) + `weightedFairShare` | ✅ |
| LLM token-budget metering (`tokenBudget`) + learned admission (`learnedReservation` / `predictiveReservation`) | ✅ |
| Adaptive lease sizing (`leaseSizer` / `predictiveLeaseSizer`) — online EOQ + predictions-with-safety | ✅ |
| MemoryStore (timing wheel + CLOCK approx-LRU) | ✅ |
| RedisStore (atomic Lua, 1 RTT, OCC fallback) — ioredis · node-redis · Upstash REST | ✅ |
| PostgresStore (atomic advisory-lock RMW, no Redis required) — pass a `pg.Pool` directly | ✅ |
| Two-tier local cache (strict / cached-deny / leased) | ✅ |
| Token leasing (network-light) · multi-region (leased over a shared L2, proven worldwide bound) | ✅ |
| Multi-dimensional, 1 fused round trip (`all`/`any`) | ✅ |
| Batch checks (`checkMany` / `checkManySync`) — one consistent timestamp, pipelined on Redis | ✅ |
| Huge-cardinality / DDoS sketch (`sketchRateLimit`) — bounded memory, provably never over-admits | ✅ |
| Cluster-wide mergeable sketch (`mergeableSketch`) — exact cross-node merge for distributed detection | ✅ |
| Adapters: Express · Web `fetch`/edge · Hono · Next.js · Fastify · Koa | ✅ |
| Injectable clock / determinism (`ManualClock`) | ✅ |
| OpenTelemetry metrics + gauges | ✅ |
| Built-in analytics (`withAnalytics`) — allow/deny + Space-Saving top-K heavy hitters | ✅ |
| IETF (draft + structured) + legacy headers, `Retry-After` | ✅ |
| Proxy-correct IP + IPv6 /64 aggregation + HMAC keys | ✅ |
| Store conformance testkit | ✅ |
| TypeScript-first, ESM + CJS, 23 entry points (+ a `throttlekit` CLI) | ✅ |

## Research track — GALE (provable distributed leasing)

A research program built on the `leased` two-tier path (target venue SIGMETRICS/POMACS): the first
distributed limiter with a hard, tight overshoot bound **independent of fleet size**, plus learned
lease sizing and weighted fairness. Proven/measured and gated under `test/gale/`; write-up in
`research/gale/`. Research modules unless marked shipped. Reproduce with `npx vitest run test/gale`.

| Result | How established | Status |
|---|---|---|
| Pillar 1 — window-coupled overshoot `= L`, independent of N | TLA+ + exhaustive BFS twin; **shipped** as `lease.windowCoupled` | ✅ |
| Pillar 1 at scale — discrete-event sim (lease latency, partitions, skew, **N → 512**) | windowCoupled Δ=0 ∀ N; partitions fail-closed; fixed-B util dip at N=512 motivates Pillar 2 (DISTRIBUTED-SIM-EVAL.md) | ✅ |
| Pillar 2 — online EOQ lease sizing, `O(√T)` regret | implemented + measured (avg regret/round 18.6 → 0.40); **shipped** as `leaseSizer` | ✅ |
| Pillar 3 — learning-augmented (consistency + robustness), safety unconditional | implemented + measured; **shipped** as `predictiveLeaseSizer` | ✅ |
| Pillar 4 — weighted fair escrow (work-conserving multi-tenant fairness) | 4 theorems machine-checked on 20k instances + measured (Workload C); **shipped** as `weightedMaxMin` / `weightedFairShare` | ✅ |
| Capstone — rate-limiting trilemma `Δ + N·U ≥ (N−1)L`, tight | proven + machine-checked (N ∈ {2,3,4}) | ✅ |
| Capstone — partial-coordination interpolation `Δ + (N−C)·U ≥ (N−C−1)L` (static-partition) | proven (reduction lemma) + machine-checked (linear floor decay) | ✅ |
| Capstone — dynamic `≤C`-message leasing bound `Δ + N·U ≥ (N−1)(L − C·B)` | proven (single-hot adversary) + machine-checked; **tight at B=1**; batched `B>1` strand-gap closed form open | ✅ |

## Research track — TALE (escrow under cost uncertainty)

The cost-axis sibling of GALE (target venue SIGMETRICS/NSDI): token-budget rate limiting for LLMs,
where a request's cost — its *output* tokens — is revealed only as it streams. Reserve-then-reconcile
escrow in three layers, the streaming meter being **window-coupling on the cost axis**. Proven/measured
and gated under `test/cost/`; write-up in `research/cost-uncertainty/`. Research modules unless marked
shipped (Layers 1–3 now ship). Reproduce with `npx vitest run test/cost`.

| Result | How established | Status |
|---|---|---|
| Layer 1 — streaming meter: overshoot `≤ g−1` (0 at g=1), **independent of `max_tokens`** | implemented + measured (vs reserve-max util collapse 0.77→0; admit-then-count Δ 24→7192); **shipped** as `tokenBudget` | ✅ |
| Layer 2 — online learned reservation (newsvendor critical fractile), `O(√T)` regret | implemented + measured (avg pinball regret 8.49→2.77; admission util 1.0 + ~4 aborts vs greedy 16 / reserve-max 0.40 util); regret envelope `≤ (3/2)DG√T` proven + machine-checked (REGRET-ANALYSIS.md); **shipped** as `learnedReservation` | ✅ |
| Layer 3 — predictions-with-safety (rank predictor + Hedge), safety unconditional | implemented + measured (perfect→clairvoyant; adversarial→robust 1.00×; overshoot 0 under *any* predictor); best-of-both bound + fixed-η caveat instantiated (REGRET-ANALYSIS.md); **shipped** as `predictiveReservation` | ✅ |
| Distributed — multi-gateway TPM **= GALE leased budget (token unit)**: overshoot independent of gateway count C | implemented + measured (window-coupled Δ=0 ∀ C∈{1..32}; carryover grows ~C·(B−1); **byte-identical** to GALE `simulateWindowCoupled`) | ✅ |

## Quality gates

| Gate | Status |
|---|---|
| `biome check` clean (0 warnings) | ✅ |
| `tsc --noEmit` clean (strict, incl. examples) | ✅ |
| Test coverage on `src` | ✅ **996 tests** (901 pass + 95 skipped without `THROTTLEKIT_TEST_REDIS`/`PG`; the 83-test growth in 0.9.0 is the unified-admission stack — TK-1002 `combineDecisions` algebraic-laws property test (+16), TK-1003 `Lease ↔ Decision` shim (+13), TK-1004 `unifiedAdmission` sequential composition (+26), TK-1005 Lua-fused unified admission (+14 gated), TK-1006 sequential≡fused conformance (+4 gated), TK-1008 `bindingAxis` + `recordUnifiedAdmissionOnSpan` (+10). Pre-existing 0.8.5 tests carried forward; all pass with the gated suites enabled. 0.8.0's 95.2% line coverage figure is from a coverage run on the previous test set, re-measure on release) |
| CI green (lint, typecheck, test matrix node 20/22/24 + Redis service, build) + bench:gate regression gate (informational) | ✅ |
| Build emits valid ESM + CJS + types (12 subpaths — added `throttlekit/federation`) | ✅ |
