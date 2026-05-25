# Changelog

All notable changes to ThrottleKit are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

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

[Unreleased]: https://github.com/AmeyaBorkar/throttlekit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AmeyaBorkar/throttlekit/releases/tag/v0.1.0
