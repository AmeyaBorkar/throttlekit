# ThrottleKit

[![npm](https://img.shields.io/npm/v/throttlekit.svg)](https://www.npmjs.com/package/throttlekit)
[![CI](https://github.com/AmeyaBorkar/throttlekit/actions/workflows/ci.yml/badge.svg)](https://github.com/AmeyaBorkar/throttlekit/actions/workflows/ci.yml)
[![types: included](https://img.shields.io/npm/types/throttlekit.svg)](https://www.npmjs.com/package/throttlekit)
[![node: >=18](https://img.shields.io/node/v/throttlekit.svg)](https://www.npmjs.com/package/throttlekit)
[![license: MIT](https://img.shields.io/npm/l/throttlekit.svg)](./LICENSE)

> **Rate limiting you can _prove_.** A distributed overshoot bound that's machine-checked in TLA⁺/TLC and **independent of fleet size** — on one small core, from a ~320 ns in-process check to a global cluster.

Most distributed rate limiters are a shared counter and a hope: fine in one process, "probably fine" across a fleet, with no stated bound on how far past the limit they can drift. ThrottleKit is built the other way — **algorithms** are pure functions of time, **storage** is one atomic primitive, **adapters** are thin glue — so the *same* configuration runs as an allocation-free in-process check or atomically across a cluster, and its distributed behaviour is **verified, not asserted**.

**Docs:** [Wiki](https://github.com/AmeyaBorkar/throttlekit/wiki) · [Design](./THROTTLEKIT.md) · [Scoreboard](./SCOREBOARD.md) · [Formal model](./docs/FORMAL-MODEL.md) · [Research](./research) · [Changelog](./CHANGELOG.md)

## Why ThrottleKit

- **A formally-verified overshoot bound — independent of fleet size.** The two-tier leasing path is model-checked in TLA⁺/TLC: worst-case global admissions are *exactly* `Limit + N·(Batch−1)` (shown tight by counterexample), and with `windowCoupled` they collapse to *exactly* `Limit` — **no matter how many nodes**. Most limiters can't state a bound at all; this one is machine-checked, and the checker re-runs in CI.
- **One algorithm, every backend, proven identical.** The *same* GCRA (or token-bucket, sliding-window, …) runs in-memory, on Redis (one atomic Lua round trip), and on Postgres (advisory-lock transaction — no Redis needed). A dual-path conformance suite proves the JavaScript and Lua decisions are bit-identical, so local and distributed limiters can't silently drift apart.
- **A real synchronous API.** `checkSync` is allocation-free at ~320 ns/op — uncommon among JS limiters, which are almost all async-only — for hot paths that shouldn't pay for an `await`.
- **Research-grade, and shipping.** Two formal programs underpin it — **GALE** (provable distributed leasing) and **TALE** (token-budget escrow for LLMs) — and their results land as real features, not slideware: the proven core (`lease.windowCoupled`, `weightedFairShare`, `tokenBudget`) *and* the learned/predictive layers (`learnedReservation`/`predictiveReservation`, `leaseSizer`/`predictiveLeaseSizer`), each cross-checked byte-identically against its proven kernel.

And it tells you where it **loses**: every benchmark is reproducible on your hardware, including the cases where an incumbent is faster. Honesty is part of the spec — see [SCOREBOARD.md](./SCOREBOARD.md).

## Install

```sh
npm i throttlekit
```

Peer dependencies are **optional** — install only those for the adapters you use (`ioredis`/`node-redis` for `throttlekit/redis`, `pg` for `throttlekit/postgres`, `express`, …). The Web `fetch` adapter needs none (Node 18+, Cloudflare Workers, Deno, Bun).

## Quick start

In-memory GCRA — no infrastructure, works out of the box:

```ts
import { rateLimit, gcra } from "throttlekit";

const limiter = rateLimit({
  // 100 requests/min, with an instantaneous burst of 20.
  strategy: gcra({ limit: 100, periodMs: 60_000, burst: 20 }),
  // `store` defaults to a fresh in-process MemoryStore.
});

const decision = await limiter.check(userId); // cost defaults to 1
if (!decision.allowed) throw new Error(`rate limited; retry in ${decision.retryAfterMs}ms`);
```

Every check returns an immutable `Decision` — `{ allowed, limit, remaining, resetAt, retryAfterMs }`. The in-memory store also gives a synchronous fast path (`limiter.checkSync(userId)`) and a per-request `cost`. Need to read state **without spending it**? `limiter.peek(key)` returns the current `Decision` and `limiter.forecast(key, cost)` projects capacity (`{ spendableNow, nextReplenishAt, fullAt }`) — both non-consuming on every backend. The [**Getting Started**](https://github.com/AmeyaBorkar/throttlekit/wiki/Getting-Started) guide covers the `Decision` shape, batch checks (`checkMany`), introspection, and deterministic time (`ManualClock`); runnable demos live in [`examples/`](./examples).

## Pick a strategy, a backend, a framework

**Seven strategies** — `gcra` (the default: tiny state, smooth pacing, controlled bursts), `tokenBucket`, `fixedWindow`, `slidingWindow`, `slidingWindowLog`, `leakyBucket` (shaping), and `adaptiveConcurrency` (backpressure when the right rate is unknown) — plus **`quota`**, a first-class billing-period budget (`calendar-month`/`-week`/`-day`, `fixed`, or `rolling`) for "1,000,000 calls/month, resetting on the 1st", distinct from a sliding rate limit and leap-year-correct. Pick one → [Strategies](https://github.com/AmeyaBorkar/throttlekit/wiki/Strategies).

**Seven stores, identical decisions** — in-memory (lock-free sync RMW, timing-wheel expiry), **Redis** (`throttlekit/redis`; one `EVALSHA`/check; `ioredis`, `node-redis`, or Upstash REST for the edge), **Postgres** (`throttlekit/postgres`; advisory-lock transaction, **no Redis required**), **Cloudflare** (`throttlekit/cloudflare`: a `DurableObjectStore` for single-threaded atomicity, plus a `D1Store` for edge SQLite via version compare-and-set), **DynamoDB** (`throttlekit/dynamodb`; conditional-write CAS with native TTL), and **Deno KV** (`throttlekit/deno`; native atomic versionstamp CAS). The conformance suite — including a 200-way concurrent read-modify-write — proves every backend agrees.

**A dozen framework & transport bindings**, each its own subpath sharing one options surface and standards headers — Express, Fastify, Koa, Hono, Next, **NestJS**, **SvelteKit**, **Remix**, **Elysia**, the Web `fetch` edge, **AWS Lambda**, **tRPC**, and **gRPC** — plus a transport-agnostic `createEnforcer()` for anything else (queue consumers, job runners, custom protocols). The serverless/edge/RPC bindings are **dependency-free**.

```ts
import { expressRateLimit } from "throttlekit/express"; // + /fastify /koa /hono /next /nest /sveltekit /remix /elysia
import { withRateLimit } from "throttlekit/fetch";       // Web fetch — Cloudflare/Deno/Bun/Next edge
import { lambdaRateLimit } from "throttlekit/lambda";     // AWS Lambda + API Gateway
import { grpcRateLimit } from "throttlekit/grpc";         // gRPC; + /trpc, and createEnforcer() for custom transports
```

Copy-pasteable setups: [Frameworks & the edge](https://github.com/AmeyaBorkar/throttlekit/wiki/Frameworks-and-the-Edge).

## Distributed, and provably bounded

This is the part most libraries hand-wave. Front the distributed store (L2) with a local in-process tier (L1) and choose your trade-off:

```ts
import { twoTier, gcra } from "throttlekit";

const limiter = twoTier({
  strategy: gcra({ limit: 10_000, periodMs: 60_000, burst: 500 }),
  l2: store,                                  // a distributed store, e.g. RedisStore
  mode: "leased",                             // "strict" | "cached-deny" | "leased"
  lease: { batch: 50, windowCoupled: true },  // lease 50 at a time; expire at the L2 window
});
```

| Mode | Network cost | Global accuracy |
|---|---|---|
| `strict` | 1 round trip / request | Exact (hard quotas, billing) |
| `cached-deny` | 1 round trip / *allowed* request | Exact allows, local denies (public APIs under abuse) |
| `leased` | ~1 round trip / `batch` | **Provably bounded** overshoot (high-throughput internal APIs) |

`leased` trades exactness for throughput, with a worst-case overshoot you choose: **carryover** gives `admitted ≤ Limit + N·(Batch−1)` (tight, but grows with fleet size `N`); **`windowCoupled: true`** expires credits at the L2 window so `admitted ≤ Limit` — **independent of `N`**.

> **Formally verified.** These bounds are *proven*, not claimed. A [TLA⁺ spec](./spec/DistributedLeasing.tla) is **model-checked with TLC** (carryover overshoot is *exactly* `Limit + N·(Batch−1)`, tight by counterexample); window-coupling tightens it to *exactly* `Limit`, independent of N ([second spec](./spec/GaleWindowCoupledLeasing.tla) + a Java-free [exhaustive checker](./test/gale/leasing-variants.test.ts) reproducing both in CI). The shipped core of **GALE**; details in [`docs/FORMAL-MODEL.md`](./docs/FORMAL-MODEL.md).

**Multi-region** is the same mechanism with regions as the leasing nodes and one shared L2 — region-local latency, the *same* verified bound capping worldwide overshoot. Walkthroughs: [Distributed & provable](https://github.com/AmeyaBorkar/throttlekit/wiki/Distributed-and-Provable).

## Overload, fairness, and cost

Primitives that sit *upstream* of the per-key limiters:

- **`adaptiveThrottle`** — Google-SRE client-side load-shedding: shed locally based on a backend's recent accept rate.
- **`fairShare` / `weightedFairShare` / `weightedMaxMin`** — split one budget across tenants so a greedy tenant can't starve the rest. `weightedMaxMin` is the exact, **work-conserving** weighted max-min allocation — GALE's *Weighted Fair Escrow*, machine-checked.
- **`tokenBudget`** — a streaming **token-budget meter** for *post-hoc* costs (LLM output tokens, known only as they stream): debit actual tokens as produced and overshoot is bounded by the debit granularity — **0 per token**, independent of the per-request cap *and* of concurrency. TALE's Layer 1. **`distributedTokenBudget`** is its fleet-shared, `Store`-backed form — the same stop-at-boundary debit run as an atomic RMW, so one budget holds across every gateway with the same per-token **Δ = 0**.
- **`learnedReservation` / `predictiveReservation`** — pace LLM admission *over* a `tokenBudget`: an online newsvendor learner sets the per-request token reservation, descending onto the cost-optimal quantile with `O(√T)` regret; the predictive variant blends in an output-length hint with consistency, robustness, and **unconditional safety** (the meter, not the prediction, holds the bound). TALE Layers 2–3.
- **`sketchRateLimit` / `mergeableSketch`** — cap an **unbounded key universe in ~7.4 KB** with a Count-Min Sketch that **provably never over-admits**; `merge()` per-node sketches for exact cluster-wide heavy-hitter detection.

Details: [Overload, fairness & DDoS](https://github.com/AmeyaBorkar/throttlekit/wiki/Overload-Fairness-and-DDoS).

## Research: GALE & TALE

ThrottleKit's distributed guarantees come from two formal programs developed alongside it; both are proven/measured and gated under [`research/`](./research), with pieces shipping into the library as marked.

- **GALE** — *Globally-Accounted Learned Escrow.* A distributed limiter with a hard, tight overshoot bound **independent of fleet size** (shipped as `lease.windowCoupled`), online-EOQ learned lease sizing and learning-augmented sizing with unconditional safety (shipped as `leaseSizer`/`predictiveLeaseSizer`), weighted work-conserving fairness (shipped as `weightedFairShare`/`weightedMaxMin`), and a proved **trilemma** lower bound `Δ + N·U ≥ (N−1)L`, with a tight `0<C<N` partial-coordination interpolation across **both** static partitioning and dynamic leasing (`Δ + N·U ≥ (N−1)(L − C·B)`, tight at unit batch) — all machine-checked.
- **TALE** — *escrow under cost uncertainty.* Token-budget rate limiting for LLMs, where a request's cost — its *output* tokens — is revealed only as it streams. A three-layer escrow, now all shipping: the streaming meter (**`tokenBudget`**, window-coupling on the cost axis), the online learned reservation (**`learnedReservation`**), and the predictions-with-safety reservation (**`predictiveReservation`**); the multi-gateway form (**`distributedTokenBudget`**, `Store`-backed) reduces *byte-identically* to GALE's leased budget.

## Performance

In-process, single hot key (Node 24, AMD Ryzen AI 9 HX 370, measured 2026-05-28; reproducible via `npm run bench`; ~±10%):

- **`checkSync` (GCRA): ~5.4M ops/s, ~186 ns/op, ~1 B/op (≈allocation-free).** `check` (async): ~3.5M ops/s. Redis: exactly one `EVALSHA` round trip per check.

**The honest head-to-head** (`npm run bench:compare`): roughly tied with `rate-limiter-flexible` on Redis (both one atomic Lua round trip), with a tighter tail; ThrottleKit's async in-memory path now edges *past* `rate-limiter-flexible`, though `express-rate-limit`'s bare counter is still ~1.4× faster (the cost of returning a full `Decision` over a bounded-memory store); a single Postgres check trails a one-statement upsert by design, but `twoTier(leased)` amortizes it into a ~37× throughput win under load. The full table, methodology, machine spec, and every place ThrottleKit loses: [SCOREBOARD.md](./SCOREBOARD.md).

## Tested to be checkable, not just claimed

Dual-path conformance (JS ≡ Lua on thousands of generated timelines), property tests (fast-check), atomicity (N concurrent checks at limit K ⇒ exactly K allowed), and the TLA⁺/TLC formal model re-checked by an exhaustive JS checker in CI. All time-dependent tests use `ManualClock`, so the suite is deterministic. Current state: **490 tests, 95.2% line coverage**, CI green across Node 20/22/24.

## Status & license

ThrottleKit is `0.x`: feature-complete and heavily tested, but young — the public API may still be refined before a `1.0` that commits to SemVer stability. MIT-licensed and developed in the open.
