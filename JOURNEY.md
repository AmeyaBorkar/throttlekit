# ThrottleKit — Build Journey

A running, dated log of how ThrottleKit is built: decisions, dead-ends, and the
reasoning behind them. Newest entries at the top.

---

## 2026-05-26 — Benchmark sweep, and a deliberately-declined optimization

Re-measured the full comparative suite (memory / Redis / Postgres) and audited the docs for drift.
Where we land, honestly:

- **In-process:** `checkSync` ~320 ns (≈allocation-free) beats rate-limiter-flexible's async-only API;
  on the async *counter* path the bare-counter incumbents are ~2–3× faster — inherent, since GCRA over
  a timing-wheel + CLOCK-eviction store is more work than `Map++`.
- **Redis:** tied on p50/throughput (both one atomic round trip); **we win the tail** (p999 ~1.6×
  tighter — cached `EVALSHA` + a leaner script).
- **Postgres:** two opposite truths. rate-limiter-flexible wins the **bare single op ~3×** (its counter
  is one atomic UPSERT; our generic RMW is a ~5-round-trip transaction), but **`twoTier(leased)` over
  Postgres wins throughput ~34×** — measured 12.6k vs 366 ops/s, 79.7 µs vs 2.6 ms/op (one transaction
  per batch; no incumbent equivalent).

Chased the Postgres per-op gap into the implementation. A single-statement SQL fast-path **can't**
safely win here: "deny-doesn't-consume" can't both skip the write *and* return the deny decision from
one `INSERT … ON CONFLICT … RETURNING`, and first-touch concurrency loses updates without the advisory
lock (which needs the transaction). The clean 1-round-trip path is a **server-side PL/pgSQL function**
— a *third* execution path with its own bit-identical conformance, float-exactness risk, and DB
function lifecycle. **Declined on purpose:** Postgres per-op latency only bites at high volume, and at
high volume you use `leased` (already winning 34×), so the function would buy a corner case that barely
exists, at permanent maintenance cost. Honest ROI over a vanity benchmark row.

Net: we win or tie on every axis that matters for real workloads; the only outright losses are
async in-process micro-throughput (vs a feature-less counter) and Postgres bare-single-op — both
corner cases. SCOREBOARD/README synced; `bench:compare` now covers all three tiers + the leased row.

## 2026-05-26 — Tested latency, and Postgres as a first-class backend

Measured the latency story end-to-end (this machine, Node 24, Redis + Postgres in Docker), and
closed the biggest concrete gap vs the incumbents: **backend breadth.**

**Latency, measured (not claimed).** In-process `gcra checkSync` is **~290–350 ns/op** (2–5 B/op);
async `check` ~580–685 ns. The pure-counter incumbents are faster on the *async* memory path
(express-rate-limit 199 ns, rate-limiter-flexible 344 ns) — honestly, because a GCRA cell over a
store that does TTL expiry + CLOCK eviction is more work than `count++` in a Map; our `checkSync`
(293 ns) still beats rate-limiter-flexible's async. On **Redis we tie on p50 and win the tail
decisively** — p99 2461 vs 3045 µs, **p999 6.7 vs 18.5 ms** (tighter tails from `EVALSHA` + leaner
Lua). The ~1.2 ms absolute p50 is a Docker-Desktop-on-Windows loopback artifact, common-mode to both
contenders. **Leased mode is the latency lever**: 100 reqs/round trip ⇒ ~14 µs effective.

**PostgresStore (`throttlekit/postgres`).** A Postgres-only shop previously couldn't adopt us without
standing up Redis. Now there's a fully distributed Postgres backend — and the design keeps the whole
correctness story intact: it runs the **same pure JS transform** the in-memory store runs (no new
algorithm path to verify), inside a transaction serialized per key by a **transaction-scoped advisory
lock**. The advisory lock (not `SELECT … FOR UPDATE`) is the crux: `FOR UPDATE` can't lock a row that
doesn't exist yet, so two first-touch transactions on a new key could race; `pg_advisory_xact_lock`
keyed by the key's hash serializes them regardless, and auto-releases at COMMIT/ROLLBACK. State is
stored as the **same JSON text** the Redis OCC path writes, so decisions are bit-identical across
backends. Expiry is clock-driven (lazy read-filter + background sweep), which is safe precisely
because every built-in strategy is idempotent w.r.t. stale state — the same property the Redis
conformance leans on; injecting the clock even lets the **TTL-expiry conformance test run** here
(Redis has to skip it). Proven on a live server: the full conformance kit, **exactly-K under 200
concurrent checks**, and dual-path equivalence to the JS executor for gcra/tokenBucket/slidingWindow.
A `pg.Pool` is accepted directly (structurally typed — no adapter); `pg` is an optional peer.

Isolation note for future me: tests use a dedicated **`tk-postgres` on 5433**, never the unrelated
`sarva-postgres` on 5432 (mirrors the `tk-redis` 6380 vs `sarva-redis` 6379 split).

**Status:** every gate green — **379 tests** (95.2% lines), lint + strict types clean, build emits
**11 subpaths** (added `/postgres`), `publint` clean, all pushed in small commits. Two more roadmap
items landed the
same day: **`checkMany` / `checkManySync`** (batch checks at one consistent timestamp; an ordered
loop with no per-key promise on a sync store, concurrent on async stores → one round trip on
auto-pipelining clients; threaded through `twoTier` and the analytics/OTel wrappers so batches are
counted too), and the **multi-region story** — which turned out to need *no new engine*: it's
`twoTier` leased over a shared L2, where the already-proven bound caps worldwide overshoot at
`Limit + regions·(batch−1)`. Documented with a runnable example (~50 requests served per cross-region
hop).

The frontier item landed too: **`mergeableSketch`** — a Count-Min Sketch for *cluster-wide*
heavy-hitter detection. CMS counters are linear, so merging per-node sketches (shipped as compact
bytes) is **exact** — counter-for-counter the union sketch — which means a low-and-slow distributed
attacker that hides under every single node's threshold is caught once the views merge, all in fixed
~7.4 KiB per node. Scoped honestly: eventually-consistent *detection* / best-effort shedding, not a
strongly-consistent global limit (that's what the Redis/Postgres stores and `twoTier` are for). The
exact-merge property and byte round-trip are unit-proven. That closes the post-0.2.0 ROI roadmap.

## 2026-05-26 — Past v0.1.0: reach, parity, and a formally-verified frontier

A second push after the publish, aimed at "the go-to package, eyes closed" and then beyond SOTA.
Two threads of background research first (competitive landscape + the algorithmic frontier),
sourced and verified, then execution — ROI-ordered, each feature parallelized to a background agent
on a disjoint file set, reviewed against the code, and gated (lint + strict types + tests + build)
before commit.

**Reach & parity (so it drops into anyone's stack):**

- **Any Redis client.** The store was `ioredis`-only; added `fromNodeRedis` / `fromUpstash` /
  `fromIoredis` adapters, so it now runs on the official node-redis client and the **Upstash REST**
  client — the serverless/edge audience (Cloudflare, Vercel, Deno, Bun) it previously couldn't reach.
  Proven bit-identical to the JS path on a live server via node-redis.
- **Four framework adapters** on a shared core (extracted from Express/fetch): **Hono, Next.js,
  Fastify, Koa** — ten subpath exports now, each an npm-search entry point.
- **Comparative benchmark** vs `rate-limiter-flexible` and `express-rate-limit` on one fair harness.
  It earned its keep immediately: it surfaced that async `check()` ran ~5× slower than `checkSync`
  for no structural reason on an in-memory store. Fixed it (a synchronous-store fast path that
  skips the async store frame + per-call closure) — **596.9k → 1.64M ops/s, a 2.7× win** — keeping
  `checkSync` allocation-free at ~3.2M. We own the sync path, tie on Redis, and report the async
  numbers honestly (the counter libs are faster there; we run GCRA over a bounded-memory store).
- **Trust + DX:** SECURITY policy, code of conduct, issue/PR templates, a resilience guide, a
  comparison table, migration guides (from the incumbents), and recipes.

**Beyond SOTA (the things no Node rate limiter ships):**

- **`sketchRateLimit`** — a Count-Min Sketch limiter that caps an *unbounded* key universe in
  **~7.4 KB total** (independent of key count), for DDoS / huge-cardinality shedding where per-key
  state is itself the exhaustion vector. Check-before-add over a never-underestimating sketch gives
  a *hard* never-over-admit guarantee; error is bounded early denial (`ε·N` w.p. ≥ `1−δ`).
- **`withAnalytics`** — zero-config, dependency-free allow/deny stats + bounded-memory top-K heavy
  hitters (Space-Saving), without an OTel backend.
- **`adaptiveThrottle` + `fairShare`** — Google-SRE client-side adaptive load-shedding (with
  priority) and an honest equal-share cross-tenant fairness splitter (its real limitations spelled
  out, not overstated).
- **A formally-verified leasing bound.** The two-tier `leased` overshoot bound went from
  property-tested to *proven*: a **TLA⁺ spec model-checked with TLC** (invariant holds across the
  full reachable state space; a counterexample shows it's *exact* at `Limit + N·(Batch−1)`), plus a
  Java-free exhaustive checker that reproduces it in CI — independently finding the same state
  counts. The spec models the real `src/twotier/index.ts` line-for-line.

**Status:** every gate green — **355 tests**, 96.9% lines / 86.4% branch, lint + strict types
clean, build emits all 10 subpaths (ESM + CJS + types), `publint` clean. All work pushed in many
small bisectable commits. **Released as `throttlekit@0.2.0`** — live on npm (`dist-tags.latest =
0.2.0`), 601 KB unpacked / 52 files (sourcemaps trimmed), published with provenance via the
tag-triggered Release workflow.

## 2026-05-26 — Published v0.1.0 to npm

`throttlekit@0.1.0` is live on npm (`dist-tags.latest = 0.1.0`), published by the tag-triggered
Release workflow with npm **provenance** via GitHub OIDC. Verified the published tarball is clean —
`dist/` (ESM + CJS + types for all six subpaths), README, CHANGELOG, LICENSE; no source or tests
leak. `npm i throttlekit` works. Added npm/CI/license/types badges to the README. (Sourcemaps make
up most of the ~994 KB unpacked size; a candidate trim for 0.1.1.)

## 2026-05-26 — Feature-complete, measured, and benchmarked

Landed the rest of the surface and proved it: the six strategies (GCRA, token bucket, fixed/
sliding window, sliding log, leaky-bucket shaper), the **two-tier engine** (strict / cached-deny /
leased with a property-tested `overshoot ≤ L×batch` bound), **multi-dimensional `all`/`any`** (a
single fused Lua round trip over k keys, conformance-checked against the atomic memory path),
**adaptive concurrency** (verified Gradient2 + AIMD with an O(1) monotonic-deque rolling-min),
Express + fetch/edge adapters, standards-compliant headers, proxy-correct IP with IPv6 /64
aggregation, OTel instrumentation, the store testkit, and the property/atomicity proofs
(**N=200 concurrent at K=50 ⇒ exactly 50 allowed**, on memory *and* Redis).

Parallelized aggressively with background agents on disjoint file sets (token bucket + fixed
window; adaptive concurrency; adapters/IP/headers; testkit/property/atomicity; OTel; README +
examples), reviewing each against the verified math. Kept ownership disjoint and re-ran the full
gate after each merge.

**The benchmark earned its keep.** Running `npm run bench` surfaced a real GCRA/leaky Lua
robustness bug: with an extreme limit the emission interval falls below the ULP of a large
epoch-ms `now`, so `new_tat − now` rounds to 0 and `SET … PX 0` errors. Guarded `ttl ≥ 1` on both
the JS and Lua persists (decisions are unaffected, so conformance still holds). Also optimized the
synchronous hot path (reuse one transform, skip the Lua-invocation allocation a sync store never
uses): `checkSync` went 955k → **3.13M ops/s (319 ns/op, ~5 B/op)** — sub-microsecond, essentially
allocation-free. Upgraded MemoryStore eviction from FIFO to a correct CLOCK (second-chance)
approximate-LRU with proper tombstone handling.

**Status:** every SCOREBOARD budget met and measured; coverage 96.8% lines; CI green on node
20/22/24 with a Redis service. Remaining: publish hygiene (package validation) and final polish.

## 2026-05-25 — Dual-path proven end-to-end

The central thesis is now demonstrated, not just claimed. Built the vertical slice
(`rateLimit` + `gcra` + `MemoryStore`), the `RedisStore` (atomic Lua via `EVALSHA` with an
`EVAL`/`NOSCRIPT` fallback and an OCC fallback for custom strategies), and a **conformance vector
suite** that runs each strategy through both the JS executor and the Redis-Lua executor across
40×25 generated timelines and asserts bit-identical decision streams — ~49k validated round trips
across GCRA, token bucket, and fixed window, all green.

Key engineering call that makes conformance exact: the TAT (and other fractional state) is stored
in Redis via `string.format('%.17g', x)` so it round-trips through Redis as the *exact* IEEE-754
double, and both paths derive every float from the same integer ARGV with identical operations.
A pleasant discovery: GCRA / token bucket / fixed window are all idempotent w.r.t. stale state
(a TAT in the logical past clamps to `now`; a long-elapsed token bucket refills to capacity), so
the Redis-PEXPIRE-vs-logical-clock mismatch can't cause divergence in the conformance harness.

Parallelized with background agents (research verification, then token bucket + fixed window) while
keeping file ownership disjoint. Test Redis runs on **6380** locally to avoid clobbering an
unrelated `sarva-redis` already on 6379.

## 2026-05-25 — Kickoff & foundations

**Goal for the session.** Stand up a production-grade, framework-agnostic rate-limiting
library from the design doc (`THROTTLEKIT.md`), with provable correctness and measured
performance. Many small, bisectable commits.

**Decisions**

- **Toolchain.** TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`),
  Vitest (unit + property + bench), `fast-check` (property tests), Biome (lint+format, fast),
  `tsup` (dual ESM+CJS+`.d.ts`), Docker Redis for integration/conformance. Node `>=18`.
- **Package shape.** Single package with subpath exports (`throttlekit`, `/redis`, `/express`,
  `/fetch`, `/testkit`, `/otel`). Optional peers: `ioredis`, `express`, `@opentelemetry/api`.
- **Verified the risky math up front** (two parallel research passes, sources in
  `docs/DESIGN-NOTES.md`) before writing a line of algorithm code:
  - GCRA `tau = T·burst` admits exactly `burst` instantaneous requests from cold — matches the
    spec. (Canonical `throttled` uses `T·(burst+1)`; documented difference.)
  - Netflix **Gradient2** exact update rule (gradient clamped `[0.5,1.0]`, smoothing `0.2`,
    tolerance `1.5`, don't-grow-while-under-50%-utilized). The spec's `√limit` headroom comes
    from the older `GradientLimit`; I keep it configurable.
  - IETF RateLimit headers: current draft **-11** uses structured fields
    (`RateLimit` + `RateLimit-Policy`), not the legacy triple. Supporting both, documented.
  - Redis: `EVALSHA`→`NOSCRIPT`→`EVAL` fallback; `{tag}` hash slots; server `TIME` as clock.

**Architecture refinement (vs. the doc).** The single storage primitive becomes
`apply(key, transform)` where `transform(state) -> { state, result, ttlMs }` — the dynamic TTL
moves into the transform result (GCRA needs `ttl = ceil(new_tat − now)`), which is strictly more
capable than a fixed `ttlMs` argument. The optional atomic Lua form rides along as a property on
the transform, so Redis can fast-path built-ins to one round trip while custom strategies fall
back to optimistic concurrency — all behind the same one method a backend author implements.

**Status.** Repo initialized; tooling scaffolded; dependency install + first green CI next.
