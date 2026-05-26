# ThrottleKit

[![npm](https://img.shields.io/npm/v/throttlekit.svg)](https://www.npmjs.com/package/throttlekit)
[![CI](https://github.com/AmeyaBorkar/throttlekit/actions/workflows/ci.yml/badge.svg)](https://github.com/AmeyaBorkar/throttlekit/actions/workflows/ci.yml)
[![types: included](https://img.shields.io/npm/types/throttlekit.svg)](https://www.npmjs.com/package/throttlekit)
[![node: >=18](https://img.shields.io/node/v/throttlekit.svg)](https://www.npmjs.com/package/throttlekit)
[![license: MIT](https://img.shields.io/npm/l/throttlekit.svg)](./LICENSE)

**Rate limiting for Node and the web — one small core, from a sub-microsecond in-process check to a distributed fleet with a _proven_ overshoot bound.**

Pick an algorithm, a backend (in-memory, Redis, or Postgres), and your framework — the limiting logic never changes. ThrottleKit rests on three ideas: **algorithms** are pure functions of time, **storage** is one atomic primitive, and **adapters** are thin glue. That separation is what lets the *same* configuration run as an allocation-free in-process check or atomically across a cluster — and it's what makes the distributed behaviour something you can verify rather than hope for.

**Docs:** [Wiki](https://github.com/AmeyaBorkar/throttlekit/wiki) (full guides) · [Design](./THROTTLEKIT.md) · [Scoreboard](./SCOREBOARD.md) · [Formal model](./docs/FORMAL-MODEL.md) · [Research](./research) · [Changelog](./CHANGELOG.md)

---

## What makes it different

Most distributed rate limiters are *a shared counter and a hope*: correct in one process, "probably fine" across a fleet, with no stated bound on how far past the limit they can drift. ThrottleKit is built the other way around — a single small core whose distributed behaviour is **proven**, not asserted.

- **A formally-verified overshoot bound — independent of fleet size.** The two-tier leasing path is model-checked in TLA⁺/TLC: worst-case global admissions are *exactly* `Limit + N·(Batch−1)` (shown tight by counterexample), and with `windowCoupled` they collapse to *exactly* `Limit` — **no matter how many nodes**. Most limiters can't state a bound at all; this one is machine-checked, and the checker re-runs in CI.
- **One algorithm, every backend, proven identical.** Strategies are pure functions of time; storage is one atomic primitive. The *same* GCRA (or token-bucket, sliding-window, …) code runs in-memory, on Redis (one atomic Lua round trip), and on Postgres (advisory-lock transaction — no Redis required). A dual-path conformance suite proves the JavaScript and Lua decisions are bit-identical, so your local and distributed limiters can't silently drift apart.
- **A real synchronous API.** `checkSync` is allocation-free at ~320 ns/op — uncommon among JS limiters, which are almost all async-only — for hot paths that shouldn't pay for an `await`.
- **Breadth on one core, not seven libraries.** Seven algorithms, three backends, six frameworks plus the edge, multi-dimensional checks that fuse into a single round trip, fixed-memory DDoS sketches (an unbounded key universe in ~7 KB), adaptive concurrency, and fair-share admission — all composed from the same primitives. TypeScript-first; every peer dependency optional.
- **Research-backed, and shipping.** Two formal research programs underpin it — **GALE** (provable distributed leasing: fleet-size-independent overshoot, learned lease sizing, weighted fairness, a proved overshoot/coordination/utilization trilemma) and **TALE** (token-budget escrow for LLMs, where a request's true cost is revealed only as it streams). Their results land as real features (`lease.windowCoupled`, `weightedFairShare`), not slideware.

And it tells you where it **loses**: every benchmark is reproducible on your own hardware, including the cases where an incumbent is faster. Honesty is part of the spec — see [SCOREBOARD.md](./SCOREBOARD.md).

---

## Install

```sh
npm i throttlekit
```

Peer dependencies are **optional** — install only the ones for the adapters you use (`ioredis` for `throttlekit/redis`, `pg` for `throttlekit/postgres`, `express`, `@opentelemetry/api`, …). The Web `fetch` adapter (`throttlekit/fetch`) needs none — it uses the global `Request`/`Response` (Node 18+, Cloudflare Workers, Deno, Bun).

---

## Quick start

In-memory GCRA — no infrastructure, works out of the box:

```ts
import { rateLimit, gcra } from "throttlekit";

const limiter = rateLimit({
  // 100 requests per minute, with an instantaneous burst allowance of 20.
  strategy: gcra({ limit: 100, periodMs: 60_000, burst: 20 }),
  // `store` defaults to a fresh in-process MemoryStore.
});

const decision = await limiter.check(userId); // cost defaults to 1
if (!decision.allowed) {
  // 429 with Retry-After: Math.ceil(decision.retryAfterMs / 1000)
  throw new Error(`rate limited; retry in ${decision.retryAfterMs}ms`);
}
```

Every check returns an immutable `Decision` — `{ allowed, limit, remaining, resetAt, retryAfterMs }`. With the in-memory store you also get a synchronous, zero-`await` fast path and a `cost` for weighting:

```ts
const d = limiter.checkSync(userId); // MemoryStore only; throws on async stores
await limiter.check(userId, 5);      // this request costs 5 units
```

Runnable versions of every feature live in [`examples/`](./examples), and the [**Getting Started**](https://github.com/AmeyaBorkar/throttlekit/wiki/Getting-Started) wiki page walks through the `Decision` shape, batch checks (`checkMany`), and deterministic time (`ManualClock`).

---

## Choosing a strategy

Pick one and pass it to `rateLimit({ strategy })`:

| Goal | Strategy |
|---|---|
| Good general default — tiny state, smooth pacing, controlled bursts | **`gcra({ limit, periodMs, burst? })`** |
| Client-friendly "tokens remaining", controlled bursts | `tokenBucket({ capacity, refillPerSec })` |
| Cheapest coarse cap (allows up to 2× across a boundary, by design) | `fixedWindow({ limit, windowMs })` |
| Near-exact rolling window at any limit, bounded memory | `slidingWindow({ limit, windowMs, buckets? })` |
| Exact "N in the last X" at low/moderate limits | `slidingWindowLog({ limit, windowMs })` |
| Shape/queue outbound calls to a fixed rate (delays, doesn't reject) | `leakyBucket({ ratePerSec, maxQueueMs })` |
| Protect a service from overload when the right rate is unknown | `adaptiveConcurrency({ ... })` |

`gcra` stores a single number and defaults `burst` to `limit`. `leakyBucket` and `adaptiveConcurrency` build a `Shaper` / concurrency guard rather than a `Limiter` — see [Backpressure & shaping](https://github.com/AmeyaBorkar/throttlekit/wiki/Advanced-Limiting).

---

## Backends and frameworks

**Three backends, identical decisions.** Hand any limiter a distributed store and the same strategy runs across a fleet; the conformance suite proves every backend agrees.

- **In-memory** — lock-free synchronous RMW, timing-wheel expiry, CLOCK approximate-LRU eviction.
- **Redis** (`throttlekit/redis`) — one atomic `EVALSHA` per check; works with `ioredis`, official `node-redis`, and the **Upstash REST** client (serverless/edge where TCP isn't allowed).
- **Postgres** (`throttlekit/postgres`) — a fully distributed backend with **no Redis required**; the same JS transform inside an advisory-lock transaction. Pass a `pg.Pool` directly.

**Six frameworks + the edge**, each its own subpath and all sharing one options surface (`strategy`/`limiter`, `store`, `key`, `cost`, `fail`, `emit`, `onLimited`, `handler`, trusted-proxy config) and the same standards headers:

```ts
import { expressRateLimit } from "throttlekit/express"; // Express
import { withRateLimit } from "throttlekit/fetch";      // Web fetch — Cloudflare/Deno/Bun/Next edge
import { honoRateLimit } from "throttlekit/hono";        // Hono
import { nextRateLimit } from "throttlekit/next";        // Next.js (dependency-free)
import { fastifyRateLimit } from "throttlekit/fastify";  // Fastify v5
import { koaRateLimit } from "throttlekit/koa";          // Koa v3
```

Full, copy-pasteable setups for each are in [**Frameworks & the edge**](https://github.com/AmeyaBorkar/throttlekit/wiki/Frameworks-and-the-Edge).

---

## Distributed, and provably bounded

This is the part most libraries hand-wave. Front the distributed store (L2) with a local in-process tier (L1) and choose your consistency/throughput trade-off:

```ts
import { twoTier, gcra } from "throttlekit";

const limiter = twoTier({
  strategy: gcra({ limit: 10_000, periodMs: 60_000, burst: 500 }),
  l2: store,                                  // a distributed store, e.g. RedisStore
  mode: "leased",                             // "strict" | "cached-deny" | "leased"
  lease: { batch: 50, windowCoupled: true },  // lease 50 at a time; expire at the L2 window
});
```

| Mode | Network cost | Global accuracy | Best for |
|---|---|---|---|
| `strict` | 1 round trip / request | Exact | Hard quotas, billing |
| `cached-deny` | 1 round trip / *allowed* request | Exact for allows, local for denies | Public APIs under abuse |
| `leased` | ~1 round trip / `batch` requests | Bounded overshoot (below) | High-throughput internal APIs |

`leased` trades exactness for throughput, with a **provably bounded** worst-case overshoot you choose:

- **Default (carryover):** `admitted ≤ Limit + N·(Batch−1)` — tight, but grows with fleet size `N`.
- **`windowCoupled: true`:** credits expire at the L2 window boundary, so `admitted ≤ Limit` — **independent of `N`**. Opt-in; default off preserves legacy behaviour.

> **Formally verified — and independent of fleet size.** These bounds are *proven*, not claimed. A [TLA⁺ spec](./spec/DistributedLeasing.tla) is **model-checked with TLC** — carryover overshoot is *exactly* `Limit + N·(Batch−1)`, with a counterexample showing it's tight — and window-coupling tightens it to *exactly* `Limit`, independent of N ([second spec](./spec/GaleWindowCoupledLeasing.tla) + a Java-free [exhaustive checker](./test/gale/leasing-variants.test.ts) that reproduces both in CI). This is the shipped core of **GALE** (see [Research](#research-gale--tale)). Details in [`docs/FORMAL-MODEL.md`](./docs/FORMAL-MODEL.md).

**Multi-region** is the same mechanism with regions as the leasing nodes and one shared L2 — region-local latency, with the *same* verified bound capping worldwide overshoot. Four regions leasing `batch: 50` against `limit: 10_000` admit at most `10_196` globally under carryover, or **exactly `10_000` with `windowCoupled`, no matter how many regions**.

Redis, Postgres, two-tier, and multi-region walkthroughs: [**Distributed & provable**](https://github.com/AmeyaBorkar/throttlekit/wiki/Distributed-and-Provable).

---

## Overload, fairness, and floods

Primitives that sit *upstream* of the per-key limiters:

- **`adaptiveThrottle`** — Google-SRE client-side adaptive load-shedding: a client that keeps hammering an overloaded backend sheds a growing fraction *locally*, based on the backend's recent accept rate.
- **`fairShare` / `weightedFairShare` / `weightedMaxMin`** — split one global budget across tenants so a greedy tenant can't starve the rest. `weightedMaxMin` is the exact, **work-conserving** weighted max-min allocation (an idle tenant's share flows to the backlogged ones; everyone gets at least their weighted floor) — the shipped piece of GALE's *Weighted Fair Escrow*, its fairness properties machine-checked.
- **`sketchRateLimit` / `mergeableSketch`** — cap an **unbounded key universe in fixed memory** (~7.4 KB) with a Count-Min Sketch that **provably never over-admits**; ship and `merge()` per-node sketches for *exact* cluster-wide heavy-hitter detection against low-and-slow distributed floods.

Details: [**Overload, fairness & DDoS**](https://github.com/AmeyaBorkar/throttlekit/wiki/Overload-Fairness-and-DDoS).

---

## Research: GALE & TALE

ThrottleKit's distributed guarantees come from two research programs developed alongside it (target venues SIGMETRICS/POMACS, NSDI). Both are proven/measured and gated under [`research/`](./research); pieces ship into the library as marked.

- **GALE** — *Globally-Accounted Learned Escrow.* The first distributed limiter with a hard, tight overshoot bound **independent of fleet size** (Pillar 1, shipped as `lease.windowCoupled`), plus online-EOQ learned lease sizing (Pillar 2), learning-augmented sizing with unconditional safety (Pillar 3), weighted work-conserving fairness (Pillar 4, shipped as `weightedFairShare`/`weightedMaxMin`), and a proved **trilemma** lower bound `Δ + N·U ≥ (N−1)L`. See [`research/gale/`](./research/gale).
- **TALE** — *escrow under cost uncertainty.* Token-budget rate limiting for LLMs, where a request's cost — its *output* tokens — is revealed only as it streams. A reserve-then-reconcile escrow in three layers; the streaming meter is window-coupling on the cost axis, and the multi-gateway form reduces *byte-identically* to GALE's leased budget. See [`research/cost-uncertainty/`](./research/cost-uncertainty).

---

## Performance

In-process, single hot key (Node 24, reproducible via `npm run bench`; numbers vary ~±10%):

- **`checkSync` (GCRA): ~3.1M ops/s, ~320 ns/op, allocation-free.**
- `check` (async, GCRA): **~1.7M ops/s** (~600 ns/op).
- Redis: exactly **one** `EVALSHA` round trip per check.

**Head-to-head, the honest version** (`npm run bench:compare`):

- **Sync:** one of the few JS limiters with a synchronous API at all, and it's allocation-free.
- **Redis:** roughly **tied** with `rate-limiter-flexible` (both one atomic Lua round trip), with a tighter tail.
- **Async in-memory:** counter-based libraries are **faster** (~2–5M vs ~1.3–1.7M ops/s) — the cost of GCRA over a bounded-memory store vs a plain counter; all far past per-process need.
- **Postgres:** a single bare check **trails** `rate-limiter-flexible`'s one-statement upsert (~3×, by design); under load, `twoTier(leased)` amortizes it into a ~34× throughput win.

The full table — algorithms labelled, methodology, and every place ThrottleKit loses — is in [SCOREBOARD.md](./SCOREBOARD.md).

---

## Documentation

- **[Wiki](https://github.com/AmeyaBorkar/throttlekit/wiki)** — task-oriented guides: getting started, every framework, the distributed model, fairness & DDoS, operations (headers/IPs/PII, observability, failure modes), and migration.
- [THROTTLEKIT.md](./THROTTLEKIT.md) — full design and architecture.
- [SCOREBOARD.md](./SCOREBOARD.md) — benchmarks, correctness guarantees, feature matrix.
- [docs/FORMAL-MODEL.md](./docs/FORMAL-MODEL.md) — the formally-verified leasing bound.
- [research/](./research) — the GALE and TALE research tracks.
- [CHANGELOG.md](./CHANGELOG.md) — release history.
- [`examples/`](./examples) — a runnable file for every feature.

---

## How it's tested

ThrottleKit is built to be checkable, not just claimed:

- **Dual-path conformance** — thousands of generated `(arrivals, costs, clock)` timelines run through both the JS and Lua path of each strategy; the two must produce identical decision streams.
- **Property tests** (fast-check) — invariants like "`remaining` never negative" and "leased overshoot ≤ documented bound" under randomized inputs.
- **Atomicity** — fire N simultaneous checks at limit K and assert exactly K allowed, for MemoryStore and (env-gated) real Redis and Postgres.
- **Formal model** — the leasing protocol is model-checked with TLA⁺/TLC and re-checked by an exhaustive JS checker in CI.
- **Store conformance kit** — `runStoreConformance` runs any custom store through the same atomicity / TTL / concurrency suite the built-ins pass.

All time-dependent tests use `ManualClock`, so the suite is deterministic. Current state: **430 tests, 95.2% line coverage**, CI green across Node 20/22/24 — tracked in [SCOREBOARD.md](./SCOREBOARD.md).

---

## Status

ThrottleKit is `0.x`: feature-complete and heavily tested, but young — the public API may still be refined before a `1.0` that commits to SemVer stability. MIT-licensed and developed in the open.

## License

MIT
