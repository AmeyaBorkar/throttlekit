# Changelog

All notable changes to ThrottleKit are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [0.8.0] — 2026-05-28

Full-reach release: four new exact backends, seven new framework/transport bindings, a fleet-shared
token budget, a transport-agnostic enforcement core, and a security/robustness/performance hardening
pass from a multi-agent code audit. Every new store passes the shared conformance suite (including a
200-way concurrent read-modify-write); test count **490 → 609**.

### Added

- **Cloudflare stores** (`throttlekit/cloudflare`): **`DurableObjectStore`** runs the limiter's pure
  transform inside `blockConcurrencyWhile`, so the read-modify-write is atomic with **no retry loop**;
  **`D1Store`** backs edge SQLite with optimistic concurrency (a version compare-and-set) plus
  in-process per-key coalescing and a `sweep()` for Cron Triggers. (Workers KV is intentionally *not*
  offered — it can't honor the atomic `Store` contract.)
- **`DynamoStore`** (`throttlekit/dynamodb`) — DynamoDB via a conditional-write CAS on a `version`
  attribute, with `expires_at` in epoch seconds so native TTL reclaims items. Zero-dep structural
  client whose inputs mirror the AWS SDK v3 commands.
- **`DenoKvStore`** (`throttlekit/deno`) — Deno KV via its native atomic `versionstamp` CAS and native
  `expireIn` TTL; lazy expiry on the injected clock keeps decisions deterministic.
- **`distributedTokenBudget`** — the fleet-shared, `Store`-backed sibling of `tokenBudget`: the same
  stop-at-boundary debit run as an atomic RMW, so one budget `L` holds across every gateway with a
  per-token overshoot of **0 independent of fleet size** (the `B=1` GALE window-coupled instantiation).
  Carries a Lua form for single-round-trip Redis.
- **`createEnforcer`** — a transport-agnostic enforcement core (root export): turns a key into a
  verdict + standards headers with the fail policy folded in, for any transport.
- **Framework & transport adapters** — **NestJS** (`/nest`, a `CanActivate` guard), **AWS Lambda /
  API Gateway** (`/lambda`, REST v1 + HTTP v2), **gRPC** (`/grpc`, unary interceptor →
  `RESOURCE_EXHAUSTED`), **tRPC** (`/trpc`, ctx-keyed middleware), **SvelteKit** (`/sveltekit`, a
  `handle` hook), **Remix** (`/remix`, a loader/action guard that throws a `Response`), and **Elysia**
  (`/elysia`, an `onBeforeHandle` hook). All dependency-free via structural/Web-standard types.

### Changed

- **Performance (hot path):** `slidingWindow` is now backed by a fixed ring buffer (no per-check object
  rebuild); `slidingWindowLog` denies allocation-free; `checkSync` reads the clock once and reuses one
  transform with no per-call closure; `MemoryStore` folds expiry into the entry and mutates timing-wheel
  entries in place; `twoTier` collapses its per-key state into one record. (audit TK-P01..P07)
- **Security:** edge adapters no longer trust `x-forwarded-for` unless a proxy chain is configured, and
  `cf-connecting-ip` trust is opt-out via `trustClientIpHeader` (audit TK-S01); structured rate-limit
  header values are sanitized against CRLF/control-character injection (audit TK-S03).
- **Robustness:** `leakyBucket.schedule()` chunks sleeps past `setTimeout`'s 32-bit ceiling (audit
  TK-R05); `Limiter.close()` releases owned timers and the `twoTier` idle timer (audit TK-R02);
  `twoTier` coalesces in-flight on-demand leases (audit TK-R01); Lua `PEXPIRE` is clamped `≥ 1` (audit
  TK-R03); `sketchRateLimit` requires an integer cost (audit TK-R04); the per-window fairness maps are
  documented as bounded by distinct tenants (audit TK-R07).
- Validation/cleanup: shared `requireCost`/`clamp`/`prefixer` helpers across the core (audit TK-Q01..Q06).

### Breaking

- **Custom `Strategy` authors only:** `Strategy.check` now returns its decision under **`result`**
  (was `decision`), unifying `StrategyOutcome<S>` as a type alias of `ApplyOutcome<S, Decision>` so the
  limiter passes a strategy's output to the store with no per-check re-wrap (audit TK-P01). **Built-in
  strategies and all public APIs are unaffected** — only code that implemented a custom `Strategy` and
  read `outcome.decision` must rename it to `outcome.result`.

### Notes

- Two audit trade-offs were evaluated and **deliberately declined** as net-negative: forcing the
  synchronous in-process meters' `reset()` to return `Promise<void>` (TK-Q07 — sync state deserves a
  sync API; the store-backed `distributedTokenBudget` is correctly async), and renaming the
  `throttlekit/otel` entry (TK-Q08 — the export-map convention is already uniform and a rename would
  only break importers).

## [0.7.0] — 2026-05-27

The learned/predictive layers of both research tracks ship as first-class primitives. Each is a
faithful port of its proven research kernel and is **cross-checked byte-identically** against that
kernel over many seeds, so the shipped code inherits the kernel's guarantees and any future drift
turns CI red. No existing behaviour changes — these are additive.

### Added

- **`learnedReservation`** (+ **`criticalFractile`**) — online learned token *reservation* (the
  shipped **TALE Layer 2**). The streaming `tokenBudget` meter bounds overshoot for any reservation,
  but admission still needs a reservation committed *before* a request's cost is known; this learns it
  with projected online gradient descent on the asymmetric newsvendor / pinball loss, descending onto
  the critical-fractile quantile `τ = overrunCost/(holdCost+overrunCost)` with **`O(√T)` regret**
  versus the best fixed reservation. Safety stays the meter's job — the learner only governs the
  false-reject ⇆ abort trade-off. Pure, deterministic, no clock.
- **`predictiveReservation`** — learning-augmented reservation (the shipped **TALE Layer 3**): blend a
  per-request output-length *prediction* against `learnedReservation` via a Hedge meta-learner.
  Accurate predictions drive cost to the clairvoyant optimum (**consistency**); adversarial ones fall
  back to the no-regret quantile (**robustness**); and safety is untouched — the prediction is just a
  number the meter caps, so no prediction can breach the budget (predictions-with-safety on the cost
  axis).
- **`leaseSizer`** (+ **`eoqOptimum`**) — adaptive lease sizing for `twoTier` leased mode (the shipped
  **GALE Pillar 2**): an online learner for the L2 lease `batch` that minimises the EOQ
  coordination-vs-stranding cost via AdaGrad in log-space, with **`O(√T)` regret** versus the best
  fixed batch. Standalone for now (feed `size()` into `lease.batch`); safety stays Pillar 1's — under
  `lease.windowCoupled` the overshoot is exactly `Limit` *independent of the batch*, so adaptive
  sizing can never loosen the proven bound.
- **`predictiveLeaseSizer`** — learning-augmented lease sizing (the shipped **GALE Pillar 3**): the
  prediction-augmented sibling of `leaseSizer`, with the same consistency / robustness / unconditional
  safety triad via Hedge over {follow-prediction, robust learner}.

### Documentation

- README, SCOREBOARD, and the GitHub Wiki updated: the GALE Pillars 2/3 and TALE Layers 2/3 are now
  marked **shipped** (`leaseSizer` / `predictiveLeaseSizer`, `learnedReservation` /
  `predictiveReservation`), not just researched. Test count 460 → 490.

## [0.6.1] — 2026-05-27

### Documentation

- README updated to record the now-**proved** dynamic `≤C`-message trilemma bound
  `Δ + N·U ≥ (N−1)(L − C·B)` (tight at unit batch `B=1`), completing the trilemma's coordination axis
  alongside the static-partition interpolation.

### Research

- The dynamic `≤C`-message trilemma bound is proven (single-hot-node adversary) and machine-checked
  (`test/gale/dynamic-coordination.ts` — exhaustive solver + 6 gated checks), with the closed form for
  *batched* leasing (`B>1, C≥2`, an online-stranding lower bound) left as the one open piece. Gated
  under `research/`/`test/`; **no change to the published package code** — this is a docs release.

## [0.6.0] — 2026-05-27

### Added

- **`tokenBudget`** — a streaming token-budget meter for *post-hoc* costs (the LLM-gateway problem:
  a completion's output-token cost is known only as it streams). Debit the actual tokens as they are
  produced; a debit is admitted iff budget remains *before* it, so worst-case overshoot is bounded by
  the debit granularity — **exactly 0 per token**, `≤ g−1` at chunk size `g` — **independent of the
  per-request cap (`max_tokens`)** and of how many streams meter concurrently (only the single
  crossing debit can exceed the budget). This dominates the two production corners at once: it has
  reserve-`max_tokens`'s safety (no overshoot per token) at admit-then-count's utilization (`~1`),
  with no dependence on the cap. The shipped piece of the **TALE** research track's Layer 1
  (`research/cost-uncertainty/`); its overshoot is cross-checked byte-for-byte against the research
  streaming kernel over 200 randomized property runs. Same epoch-aligned window, `Decision` contract,
  and injected `Clock` as the other `admission` primitives; lives beside `fairShare` /
  `weightedFairShare`.

### Fixed

- The exported `version` constant was stale at `0.3.0`; synced to the package version.

### Documentation

- README **rebranded** around provability ("rate limiting you can prove") and trimmed from ~220 to
  ~110 lines — leading with the machine-checked, fleet-size-independent overshoot bound, with the full
  guides remaining in the GitHub Wiki. npm description refreshed to match; added an `llm` keyword.

### Research

- Research tracks advanced (gated under `research/`, **not** part of the published package): the
  `0<C<N` trilemma partial-coordination interpolation (`research/gale/TRILEMMA.md`), the L2/L3
  regret/consistency analysis with explicit constants (`research/cost-uncertainty/REGRET-ANALYSIS.md`),
  and a discrete-event distributed simulator confirming the Pillar-1 overshoot bound holds for N→512
  under lease latency and partitions (`research/gale/DISTRIBUTED-SIM-EVAL.md`).

## [0.5.1] — 2026-05-26

### Documentation

- README rewritten leaner (~600 → ~220 lines), leading with the differentiators — the
  formally-verified, fleet-size-independent overshoot bound; one transform across every backend,
  proven bit-identical; the synchronous API; and the GALE/TALE research tracks. The per-feature
  walkthroughs moved to a new GitHub **Wiki** (Getting Started, Strategies, Frameworks & the Edge,
  Distributed & Provable, Advanced Limiting, Overload/Fairness/DDoS, Operations, Performance,
  Migrating, Research). Corrected the stale test count in the README (389 → 430).
- Package description refreshed to match the README — leads with the proven, fleet-size-independent
  overshoot bound and the single-transform in-memory/Redis/Postgres story.

## [0.5.0] — 2026-05-26

### Added

- **Weighted Fair Escrow** (`weightedMaxMin`, `weightedFairShare`, `guaranteedShare`) — weighted
  fairness for a contended budget, the weighted siblings of `fairShare`. `weightedMaxMin(demands,
  weights, limit)` is the exact integer **weighted max-min fair allocation**: work-conserving (sums to
  `min(Σ demand, limit)` — an idle tenant's share flows to the backlogged ones) and weight-honoring
  (every backlogged tenant reaches a common weighted service level and gets at least its guaranteed
  floor `⌊w_i/W·limit⌋`); equal weights reduce to ordinary max-min. Computed as continuous
  water-filling (`O(n log n)`) plus a bounded integer drip of the `< n`-credit remainder, so it stays
  fast for large limits. Its four properties (safety / weighted-floor / work-conservation / bounded
  unfairness) are machine-checked on random instances. `weightedFairShare({limit, windowMs, weightOf})`
  is the online streaming limiter — `fairShare` with per-tenant caps proportional to weight, same
  honest online caveats. This is the shipped piece of the GALE research track's Pillar 4
  (`research/gale/PILLAR4-fairness.md`); use `weightedMaxMin` to split, e.g., a `twoTier` node's leased
  batch among its local tenants.

### Changed

- CI/release workflows bumped to `actions/checkout@v5` + `actions/setup-node@v5` (Node 24 runtime;
  Node 20 actions are being retired from GitHub-hosted runners).

## [0.4.1] — 2026-05-26

_Supersedes 0.4.0, which was tagged but never published — a GitHub Actions outage blocked its release._

### Added

- **Window-coupled leasing** (`lease.windowCoupled`, opt-in on `twoTier` `leased` mode) — expires a
  node's leased credits when the shared L2 window that granted them rolls over, instead of carrying
  them into the next window. This makes worst-case global overshoot exactly **`Limit`**, *independent
  of the number of nodes*, versus the carryover bound `Limit + N·(Batch−1)`. Default off (existing
  behaviour preserved). Machine-checked (TLA⁺ spec + exhaustive checker). It is the shipped piece of
  the GALE research track (`research/gale/`); see SCOREBOARD “Research track”.

### Documentation

- README rewritten to lead with the provable distributed-leasing story (the window-coupled overshoot
  bound + the GALE research track) and trimmed ~13%.

## [0.3.0] — 2026-05-26

### Added

- **PostgreSQL store** (`throttlekit/postgres`): a fully distributed backend for teams already running
  Postgres — no Redis required. `PostgresStore` runs the **same pure JS transform** as the in-memory
  store (no Postgres-specific algorithm to keep in sync) inside a transaction serialized per key by a
  transaction-scoped advisory lock (`pg_advisory_xact_lock` — which, unlike `SELECT … FOR UPDATE`,
  also serializes first-touch keys). Concurrent checks are atomic (**N simultaneous checks at limit K
  admit exactly K**, proven against a live server) and decisions are bit-identical to the in-memory
  and Redis paths (state stored as JSON text, round-tripping the exact IEEE-754 double). State expiry
  is clock-driven with lazy reads + a background sweep; safe because every built-in strategy is
  idempotent w.r.t. stale state. Pass a `pg.Pool` directly — no adapter. `pg` is an optional peer.
- **Batch checks** — `limiter.checkMany(keys, cost?)` and `limiter.checkManySync(keys, cost?)` check
  many independent keys in one call, each evaluated at a **single consistent timestamp** and returned
  in input order. On a synchronous store the checks run in an ordered loop with no per-key promise
  overhead; on an async store (e.g. Redis) they fire concurrently — a single round trip on clients
  that pipeline same-tick commands (node-redis, or `ioredis` with `enableAutoPipelining`). Decisions
  are identical to per-key `check`. Available on every limiter, including `twoTier` and the
  `withAnalytics` / OpenTelemetry wrappers (batch checks are counted/instrumented too).
- **Mergeable sketch** (`mergeableSketch`, `sketchSnapshotFromBytes`) — a Count-Min Sketch for
  **cluster-wide** heavy-hitter detection in fixed memory. Each node sketches its own traffic and
  ships a compact snapshot (`snapshot()` / `toBytes()`); because CMS counters are linear, merging
  them (`merge()`) is **exact** — counter-for-counter identical to one sketch over the union of all
  streams — so a low-and-slow distributed attacker invisible per node is caught cluster-wide. Never
  underestimates. Honestly scoped as eventually-consistent *detection* / best-effort shedding, not a
  strongly-consistent global limit (use Redis/Postgres or `twoTier` for that).

### Documentation

- **Multi-region guidance.** Documented that a global limit across regions is `twoTier` leased mode
  with the regions as leasing nodes and one shared L2 — region-local latency, with the
  formally-verified bound capping worldwide overshoot at `Limit + regions × (batch − 1)` (no separate
  multi-region engine to trust). New `examples/multi-region.ts` demonstrates it (~50 requests served
  per cross-region hop in the default scenario).

## [0.2.0] — 2026-05-26

### Added

- **`sketchRateLimit`** — a Count-Min Sketch limiter that caps an **unbounded key universe in fixed
  memory** (~7.4 KB at the defaults, independent of key count) for huge-cardinality / DDoS shedding.
  Provably **never over-admits** (check-before-add over a never-underestimating sketch); its only
  error is bounded early denial (`ε·N` w.p. `≥ 1−δ`). Pure JS, sync + async.
- **`withAnalytics`** — zero-config, dependency-free traffic insight: wrap any limiter to get
  allow/deny counts and bounded-memory **top-K heavy hitters** (Space-Saving), queryable in-process
  via `analytics()` without an OpenTelemetry backend.
- **Admission control** (`adaptiveThrottle`, `fairShare`): Google-SRE client-side adaptive
  load-shedding (sheds locally based on the backend's accept rate, with priority), and an online
  equal-share fairness splitter so one tenant can't starve a shared global budget.
- **Redis client adapters** (`throttlekit/redis`): `fromNodeRedis`, `fromUpstash`, and `fromIoredis`.
  `RedisStore` now works with the official **node-redis** client and the **Upstash REST** client
  (Cloudflare Workers, Vercel, Deno, Bun — anywhere TCP isn't allowed), not just `ioredis`. Every
  built-in strategy's atomic Lua runs identically across all three; the node-redis path is proven
  bit-identical to the JS path against a live server. (Upstash REST is Lua-only — no `WATCH`/`MULTI`.)
- **Framework adapters** on a shared core, each its own subpath: `throttlekit/hono` (`honoRateLimit`),
  `throttlekit/next` (`nextRateLimit`, dependency-free), `throttlekit/fastify` (`fastifyRateLimit`),
  and `throttlekit/koa` (`koaRateLimit`). Hono/Fastify/Koa are optional peers.
- A **comparative benchmark** (`npm run bench:compare`) measuring ThrottleKit against
  `rate-limiter-flexible` and `express-rate-limit` on one fair harness (memory + Redis tiers).
- **Formal verification** of the leased two-tier overshoot bound: a TLA+ spec
  (`spec/DistributedLeasing.tla`) model-checked with TLC, plus a Java-free exhaustive checker that
  reproduces it in CI. Proves `admitted_per_window ≤ Limit + N·(Batch−1)` (tight; implies the
  documented `≤ L×batch`). See `docs/FORMAL-MODEL.md`.

### Changed

- **Faster async `check()`** on synchronous stores (e.g. `MemoryStore`): it now runs the transition
  inline and hands back a resolved promise, skipping the async store frame and the per-call
  transform closure. Measured ~2.7× faster (596.9k → ~1.64M ops/s in memory, single hot key);
  `checkSync` remains allocation-free at ~3.2M ops/s. The async path is unchanged for genuinely
  async stores (Redis). No observable behavior change.
- **Leaner package:** the published tarball no longer ships sourcemaps (~2.0 MB → ~600 KB unpacked,
  72 → 52 files). Compiled code and `.d.ts` types are unchanged.

## [0.1.0] — 2026-05-26

Initial release — a pluggable, framework-agnostic rate-limiting toolkit for Node and the web.

### Algorithms

- **GCRA** (`gcra`, default) — single-timestamp pacing with a configurable burst.
- **Token bucket** (`tokenBucket`) — explicit token count, lazy refill.
- **Fixed window** (`fixedWindow`) — cheapest coarse cap (documented 2× boundary).
- **Sliding window counter** (`slidingWindow`) — sub-bucketed, near-exact, bounded O(buckets) memory.
- **Sliding window log** (`slidingWindowLog`) — exact "N in the trailing window".
- **Leaky bucket** (`leakyBucket`) — a traffic `Shaper` that delays rather than rejects
  (`reserve` / `reserveSync` / `schedule`, with `QueueFullError`).
- **Adaptive concurrency** (`adaptiveConcurrency`) — Netflix-style Gradient2 + AIMD backpressure.

Every pass/deny strategy ships a pure JS transition **and** an atomic Redis Lua form, proven
bit-identical by a dual-path conformance suite.

### Engine & stores

- `rateLimit` limiter with `check` / `checkSync` / `reset`, injectable clock, and key prefixing.
- One storage primitive — `Store.apply(key, transform)`.
- `MemoryStore` — lock-free synchronous RMW, hierarchical timing-wheel expiry, CLOCK
  (second-chance) approximate-LRU eviction.
- `RedisStore` (`throttlekit/redis`) — single `EVALSHA` round trip (with `EVAL`/`NOSCRIPT`
  fallback), optimistic-concurrency fallback for custom strategies, server-clock time source.
- `twoTier` — L1/L2 engine with `strict`, `cached-deny`, and `leased` modes (bounded `L × batch`
  overshoot, low-water async refill).
- `multiRateLimit` with `all` / `any` — multi-dimensional limits in a single fused Lua round trip,
  with no partial-consume.

### Adapters, headers & security

- Express middleware (`throttlekit/express`) and Web `fetch`/edge wrapper (`throttlekit/fetch`),
  with `fail` open/closed, `onLimited`/`onError` hooks, and custom 429 handlers.
- `buildRateLimitHeaders` — IETF draft triple, RFC 9651 structured `RateLimit`/`RateLimit-Policy`,
  legacy `X-RateLimit-*`, and `Retry-After`.
- `clientIp` — proxy-correct client IP with explicit trusted-proxy policy (default-deny `XFF`, hop
  count, or CIDR allowlist) and IPv6 `/64` aggregation; `hashKey` / `hmacKeyer` for PII-safe keys.

### Observability & testing

- Optional OpenTelemetry instrumentation (`throttlekit/otel`): `instrumentLimiter` /
  `instrumentGuard`.
- Framework-agnostic store conformance kit (`throttlekit/testkit`): `runStoreConformance`.
- Deterministic `ManualClock`; benchmark harness (`npm run bench`).

### Tooling

- TypeScript-first, strict; dual ESM + CJS builds with types across six subpaths.
- Tested with Vitest (unit, boundary, property via fast-check, dual-path conformance, and
  exactly-K concurrency/atomicity on memory and Redis); CI on Node 20/22/24 with a Redis service.

[Unreleased]: https://github.com/AmeyaBorkar/throttlekit/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/AmeyaBorkar/throttlekit/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/AmeyaBorkar/throttlekit/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/AmeyaBorkar/throttlekit/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/AmeyaBorkar/throttlekit/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/AmeyaBorkar/throttlekit/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/AmeyaBorkar/throttlekit/compare/v0.3.0...v0.4.1
[0.3.0]: https://github.com/AmeyaBorkar/throttlekit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/AmeyaBorkar/throttlekit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AmeyaBorkar/throttlekit/releases/tag/v0.1.0
