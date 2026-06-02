# ThrottleKit

[![npm](https://img.shields.io/npm/v/throttlekit.svg)](https://www.npmjs.com/package/throttlekit)
[![CI](https://github.com/AmeyaBorkar/throttlekit/actions/workflows/ci.yml/badge.svg)](https://github.com/AmeyaBorkar/throttlekit/actions/workflows/ci.yml)
[![types: included](https://img.shields.io/npm/types/throttlekit.svg)](https://www.npmjs.com/package/throttlekit)
[![node: >=18](https://img.shields.io/node/v/throttlekit.svg)](https://www.npmjs.com/package/throttlekit)
[![license: MIT](https://img.shields.io/npm/l/throttlekit.svg)](./LICENSE)

**Beyond rate limiting — govern rate, concurrency, and cost, _provably_.** *Meter what your LLM spends. Prove what your fleet admits.* Counting requests is the easy 10%; ThrottleKit governs the three axes a real request must clear — **rate**, **concurrency**, and **cost** — each behind a bound you can prove.

Two engines do the hard part. **GALE** (provable distributed leasing) holds global overshoot to a **fleet-size-independent** bound, **machine-checked in TLA⁺**. **TALE** (token-budget escrow) meters an LLM's output tokens — known only as they stream — and bounds them anyway. All on one small core: a **169 ns** in-process check (5.9M ops/s, effectively allocation-free), **zero runtime dependencies**, proven bit-identical across six stores.

Most limiters just count requests — fine in one process, "probably fine" across a fleet, and silent on the two axes that actually cost you money: concurrency and tokens. ThrottleKit states its bounds, and proves them.

And the bound is only the start. **GALE** and **TALE** ship as real features, not heuristics — **window-coupled leasing**, **adaptive lease sizing**, **weighted-fair escrow**, **distributed adaptive concurrency**, **unified rate × concurrency × cost** admission, and an **LLM token-budget stack** — each a checked guarantee, every one byte-identically verified. [See how GALE & TALE work →](https://github.com/AmeyaBorkar/throttlekit/wiki/Research)

**Site:** [throttlekit.in](https://throttlekit.in) · **Docs:** [Wiki](https://github.com/AmeyaBorkar/throttlekit/wiki) · [Benchmarks](./BENCH.md) · [Stability](./STABILITY.md) · [Design](./THROTTLEKIT.md) · [Component design](./docs/design/) · [Formal model](./docs/FORMAL-MODEL.md) · [Scoreboard](./SCOREBOARD.md) · [Changelog](./CHANGELOG.md)

## Install

```sh
npm i throttlekit
```

Zero runtime dependencies. Peer deps are **optional** — install only what your stores and adapters use (`ioredis`/`node-redis` for `throttlekit/redis`, `pg` for `throttlekit/postgres`, `express`, …). The Web `fetch` adapter needs none (Node 18+, Cloudflare, Deno, Bun).

## Quick start

In-memory, no infrastructure — and a real synchronous fast path:

```ts
import { rateLimit, gcra } from "throttlekit";

const limiter = rateLimit({
  strategy: gcra({ limit: 100, periodMs: 60_000, burst: 20 }), // 100/min, instantaneous burst 20
});

const decision = limiter.checkSync(userId); // sync + allocation-free — or `await limiter.check(userId)`
if (!decision.allowed) {
  throw new Error(`rate limited; retry in ${decision.retryAfterMs}ms`);
}
```

Every check returns an immutable `Decision` — `{ allowed, limit, remaining, resetAt, retryAfterMs }`. Read state without spending it via `limiter.peek(key)` / `limiter.forecast(key)`.

Going distributed is the same algorithm with a store and a trade-off — lease a batch of credits in one round trip, then serve them locally at in-process speed:

```ts
import { twoTier, gcra } from "throttlekit";
import { RedisStore } from "throttlekit/redis";

const limiter = twoTier({
  strategy: gcra({ limit: 10_000, periodMs: 60_000, burst: 500 }),
  l2: new RedisStore({ client }),               // or Postgres, DynamoDB, Deno KV, Cloudflare
  mode: "leased",                               // "strict" | "cached-deny" | "leased"
  lease: { batch: 50, windowCoupled: true },    // ~1 round trip / 50 requests; admitted ≤ Limit, any fleet size
});
```

## Why ThrottleKit

- **A proven overshoot bound, independent of fleet size.** Two-tier leasing is model-checked in TLA⁺/TLC: worst-case global admissions are *exactly* `Limit + N·(Batch−1)` (tight by counterexample), and `windowCoupled` collapses that to *exactly* `Limit` — **no matter how many nodes**, and across regions too (`federate(...)`, bound independent of region count `K`). The checker re-runs in CI. Most limiters can't state a bound at all.
- **Sub-microsecond synchronous checks.** `checkSync` returns a complete decision in **169 ns/op (5.9M ops/s), effectively allocation-free** — a true sync API, uncommon among JS limiters, for hot paths that shouldn't pay for an `await`. [Benchmarks →](./BENCH.md)
- **One algorithm, six backends, proven bit-identical.** The *same* GCRA (or token-bucket, sliding-window, …) runs in memory, on Redis (one atomic `EVALSHA`), and on Postgres (advisory-lock transaction — no Redis needed). A dual-path conformance suite — including a 200-way concurrent read-modify-write — proves the JavaScript and Lua decisions agree, so local and distributed limiters can't silently drift.
- **Two engines, shipped as features — not heuristics.** **GALE** (provable distributed leasing) and **TALE** (LLM token-budget escrow) land as real, byte-identically-verified APIs: window-coupled leasing, weighted-fair escrow, adaptive lease sizing, unified rate × concurrency × cost admission, distributed adaptive concurrency, and the cost-axis token-budget stack.
- **Batteries included, dependencies not.** **24 entry points** — 8 strategies, 6 storage backends, 13 framework/transport adapters — and **zero runtime dependencies**. First-class types, ESM + CJS, tree-shakeable subpaths.
- **Honest about where it loses.** Every benchmark is reproducible on your hardware, including the cases an incumbent wins. See [BENCH.md](./BENCH.md) and [SCOREBOARD.md](./SCOREBOARD.md).

## How it compares

The incumbents are good at what they do — this is what ThrottleKit adds on top. Every row is a shipped, tested ThrottleKit feature; the comparison reflects each library's documented capabilities.

| | `express-rate-limit` | `rate-limiter-flexible` | `@upstash/ratelimit` | **ThrottleKit** |
|---|:--:|:--:|:--:|:--:|
| Provable, **fleet-size-independent** overshoot bound (TLA⁺-checked) | – | – | – | **✓** |
| Synchronous, allocation-free check | – | – | – | **✓ 169 ns** |
| One algorithm, proven **bit-identical** across backends | – | – | – | **✓ (6 stores)** |
| Two-tier leasing — amortized round trips, *bounded* overshoot | – | – | – | **✓** |
| LLM **token-budget escrow** (post-hoc cost axis) | – | – | – | **✓ (TALE)** |
| Unified **rate × concurrency × cost** in one decision | – | – | – | **✓** |
| Weighted-fair share · overload shedding · fixed-memory DDoS sketch | – | – | – | **✓** |
| Polyglot from one **verified** core (Python today) | – | – | – | **✓** |
| Framework / transport adapters | 1 (Express) | a few | – | **13** |
| Zero runtime dependencies | – | – | – | **✓** |

This table is about distributed-*correctness* guarantees and breadth — the benchmarks (incl. the rows an incumbent wins) are reproducible on your hardware: [BENCH.md](./BENCH.md).

## Benchmarks

In-process, single hot key, Node 24 / AMD Ryzen AI 9 HX 370 (full methodology, caveats, and head-to-head in [BENCH.md](./BENCH.md)):

| Path | Throughput | Latency |
|---|--:|--:|
| `checkSync` (GCRA, in-process) | 5.9M ops/s | **169 ns/op**, ~0 B/op |
| `check` (GCRA, async, in-process) | 3.3M ops/s | ~300 ns/op |
| `twoTier(leased)` over Redis, batch 100 | **66.4k ops/s** | 1 round trip / 100 requests |

The honest head-to-head (`npm run bench:compare`): on Redis, level with `rate-limiter-flexible` (both one atomic Lua round trip) with a tighter tail; the async in-memory GCRA path edges *past* it (301 vs 331 ns) while computing a full `Decision`; a single Postgres check trails a one-statement upsert by design, but `twoTier(leased)` turns that into a **~35× throughput win** under load.

## Strategies

`gcra` (default — tiny state, smooth pacing, controlled bursts) · `tokenBucket` · `fixedWindow` · `slidingWindow` · `slidingWindowLog` · `leakyBucket` (traffic shaping) · `adaptiveConcurrency` (backpressure when the right rate is unknown) · `quota` (billing-period budgets: `calendar-month`/`-week`/`-day`, `fixed`, `rolling` — leap-year-correct). → [Strategies](https://github.com/AmeyaBorkar/throttlekit/wiki/Strategies)

## Stores — identical decisions on every backend

| Backend | Subpath | Mechanism |
|---|---|---|
| In-memory | *(built-in)* | lock-free synchronous RMW, timing-wheel expiry |
| Redis | `throttlekit/redis` | one `EVALSHA`/check — `ioredis`, `node-redis`, or Upstash REST |
| Postgres | `throttlekit/postgres` | advisory-lock transaction — **no Redis required** |
| DynamoDB | `throttlekit/dynamodb` | conditional-write CAS with native TTL |
| Deno KV | `throttlekit/deno` | atomic versionstamp CAS |
| Cloudflare | `throttlekit/cloudflare` | Durable Object atomicity + `D1` edge SQLite |

## Frameworks & transports

Express · Fastify · Koa · Hono · Next · NestJS · SvelteKit · Remix · Elysia · Web `fetch` (edge) · AWS Lambda · tRPC · gRPC — each its own subpath sharing one options surface and standards headers, plus `createEnforcer()` for anything else (queues, job runners, custom protocols). Serverless/edge/RPC bindings are dependency-free.

```ts
import { expressRateLimit } from "throttlekit/express"; // + /fastify /koa /hono /next /nest /sveltekit /remix /elysia
import { withRateLimit } from "throttlekit/fetch";       // Web fetch — Cloudflare / Deno / Bun / Next edge
```

→ [Frameworks & the edge](https://github.com/AmeyaBorkar/throttlekit/wiki/Frameworks-and-the-Edge)

## Distributed, and provably bounded

Front a distributed store (L2) with a local in-process tier (L1) and choose the trade-off:

| Mode | Network cost | Global accuracy |
|---|---|---|
| `strict` | 1 round trip / request | Exact — hard quotas, billing |
| `cached-deny` | 1 round trip / *allowed* request | Exact allows, local denies — public APIs under abuse |
| `leased` | ~1 round trip / `batch` | **Provably bounded** overshoot — high-throughput internal APIs |

`leased` trades exactness for throughput with an overshoot *you* choose: **carryover** gives `admitted ≤ Limit + N·(Batch−1)`; **`windowCoupled: true`** expires credits at the L2 window so `admitted ≤ Limit`, **independent of fleet size `N`**. Set `lease.adaptive` and each key's batch is sized online at the EOQ optimum (GALE Pillar 2), bound untouched.

> **Formally verified, not claimed.** A [TLA⁺ spec](./spec/DistributedLeasing.tla) is model-checked with TLC (overshoot *exactly* `Limit + N·(Batch−1)`, tight by counterexample); [window-coupling](./spec/GaleWindowCoupledLeasing.tla) tightens it to *exactly* `Limit`, and a Java-free [exhaustive checker](./test/gale/leasing-variants.test.ts) reproduces both in CI. Details in [`docs/FORMAL-MODEL.md`](./docs/FORMAL-MODEL.md).

**When a store goes down:** `apply` rejects (never silently allows/denies), your `fail: "open" | "closed"` policy decides, no write lands partially, durable backends never lose committed counts, and `twoTier(leased)` keeps serving local credits through a brief L2 blip. Full matrix: [`docs/FAILURE-MODES.md`](./docs/FAILURE-MODES.md). → [Distributed & provable](https://github.com/AmeyaBorkar/throttlekit/wiki/Distributed-and-Provable)

## Beyond rate limiting

Primitives that sit *upstream* of per-key limiters — overload, fairness, and cost:

- **`adaptiveThrottle`** — Google-SRE client-side load-shedding from a backend's recent accept rate.
- **`weightedMaxMin` / `weightedFairShare`** — exact, work-conserving weighted max-min sharing so a greedy tenant can't starve the rest (GALE's *Weighted Fair Escrow*, machine-checked); `federatedWeightedFairEscrow` lifts it to a global guarantee across regions.
- **`tokenBudget` / `distributedTokenBudget`** — a streaming token-budget meter for *post-hoc* costs (LLM output tokens, known only as they stream): overshoot bounded by debit granularity — **Δ = 0 per token**, independent of concurrency (TALE Layer 1).
- **`learnedReservation` / `predictiveReservation`** — pace LLM admission over a budget with an online newsvendor learner (`O(√T)` regret); the predictive variant blends an output-length hint with unconditional safety (the meter holds the bound, not the prediction).
- **`unifiedAdmission`** — compose rate ∧ concurrency ∧ cost into one decision, sequential or atomic Lua-fused; opt into a revenue-management **bid-price** filter (`policy: "joint-lp"`).
- **`sketchRateLimit`** — cap an unbounded key universe in ~7.4 KB with a Count-Min Sketch that provably never over-admits.

→ [Overload, fairness & DDoS](https://github.com/AmeyaBorkar/throttlekit/wiki/Overload-Fairness-and-DDoS)

## Polyglot — one core, two doors (experimental)

Reach the limiter from non-Node services without re-implementing a single algorithm: the Node core stays the **only** thing that computes a decision, and every other surface is a thin pipe conformance-checked against one set of language-neutral [golden vectors](./wire).

- **Service door** — [`throttlekit-server`](./server) runs the core and answers a small gRPC contract (`throttlekit.proto`); any language becomes a trivial stub, and a denial is a normal decision, never an RPC error.
- **Direct door** — a client runs the core's *own* vendored Lua against the same Redis your Node fleet uses (one hop, no extra service).
- **[`throttlekit-py`](https://github.com/AmeyaBorkar/throttlekit-py)** reaches **every axis** from Python — rate (`check`), cost (`debit`), two-tier leased (`check`, transparently), and concurrency + unified admission (`admit`, with crash-safe leases) — and its `RedisBackend` replays the full golden vectors through real Redis to reproduce this core **bit-for-bit**.

The proto is the stable polyglot contract; the raw Lua wire is behavior-locked but deliberately **not** frozen. The full walkthrough is the [**Polyglot & Python**](https://github.com/AmeyaBorkar/throttlekit/wiki/Polyglot-and-Python) wiki page; design + decision records live in [`research/polyglot/DESIGN.md`](./research/polyglot/DESIGN.md).

## Correctness

Dual-path conformance (JS ≡ Lua over thousands of generated timelines) + shrinkable `fast-check` property passes, atomicity tests (N concurrent checks at limit K ⇒ exactly K allowed), the TLA⁺/TLC model re-checked by an exhaustive JS checker in CI, and federation BFS-twin coverage. All time-dependent tests use `ManualClock`, so the **1,300+ test** suite is deterministic; CI is green across Node 20/22/24, and a bench-regression gate blocks hot-path slowdowns.

## Stability & license

ThrottleKit is **1.0** — the public API is frozen under SemVer. [STABILITY.md](./STABILITY.md) is the promise: the stable core (algorithms, stores, adapters, federation, unified-admission core) only grows additively, the experimental frontier (the joint-LP policy, distributed-concurrency tuning knobs, the learned escrow/sketch layer) is opt-in and carved out, and the freeze is mechanically enforced (type-level surface tests + `attw` + `publint` in CI). MIT-licensed, developed in the open.
