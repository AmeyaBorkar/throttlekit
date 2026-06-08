# ThrottleKit — Design & Architecture

> **Rate limiting you can prove — built on GALE and TALE.** A pluggable, framework-agnostic
> toolkit for Node and the web, correct by construction: **GALE** gives a *machine-checked*,
> fleet-size-independent overshoot bound on distributed leasing, and **TALE** a `max_tokens`-independent
> bound on LLM token budgets — with no network call on the hot path, and the fastest option in its
> class, without sacrificing accuracy or developer ergonomics.

ThrottleKit treats rate limiting as three cleanly separated concerns: **algorithms** (pure
functions of time), **storage** (one atomic primitive), and **adapters** (thin glue to your
framework). That separation is what lets the same limit run as a sub-microsecond in-process
check, as a single atomic Redis round trip, or as a near-zero-network leased budget across a
fleet — all from one configuration, with one set of conformance tests proving every path agrees.

> **Going deeper?** This page is the single-page overview. Each component has a dedicated, in-depth
> design document — architecture, the math, and *why every non-obvious choice was made* — under
> [`docs/design/`](docs/design/).

---

## Table of contents

1. [Why this exists](#1-why-this-exists)
2. [What makes it novel](#2-what-makes-it-novel)
3. [Design principles](#3-design-principles)
4. [Core concepts and domain model](#4-core-concepts-and-domain-model)
5. [Public API](#5-public-api)
6. [Algorithms (full specifications)](#6-algorithms-full-specifications)
7. [Storage and the atomic `apply` primitive](#7-storage-and-the-atomic-apply-primitive)
8. [The two-tier distributed engine (L1/L2)](#8-the-two-tier-distributed-engine-l1l2)
9. [Multi-dimensional limiting in one round trip](#9-multi-dimensional-limiting-in-one-round-trip)
10. [Adaptive concurrency (backpressure, not just counting)](#10-adaptive-concurrency-backpressure-not-just-counting)
11. [Performance engineering](#11-performance-engineering)
12. [Correctness and consistency guarantees](#12-correctness-and-consistency-guarantees)
13. [Observability](#13-observability)
14. [Security and correctness footguns](#14-security-and-correctness-footguns)
15. [HTTP headers](#15-http-headers)
16. [Testing strategy](#16-testing-strategy)
17. [Configuration reference](#17-configuration-reference)
18. [Comparison with prior art](#18-comparison-with-prior-art)
19. [Design tradeoffs and FAQ](#19-design-tradeoffs-and-faq)
20. [Glossary](#20-glossary)
21. [References](#21-references)

---

## 1. Why this exists

Rate limiting is deceptively hard. The naïve version is a counter and an `if`. The production
version has to be correct under concurrency, correct across many processes, cheap enough to run
on every request, resilient when its own backing store is down, fair to honest clients, hostile
to abusive ones, observable, and standards-compliant. The popular libraries each solve a slice
of this and punt on the rest:

- **`express-rate-limit`** is ergonomic but Express-only, primarily fixed-window, and leans on
  store `increment` semantics rather than a single atomic operation — so distributed accuracy
  depends entirely on the store adapter. It also famously requires careful `trust proxy` setup to
  avoid IP-spoofing bypasses.
- **`rate-limiter-flexible`** is powerful and backend-rich (Redis, Mongo, Memcached, Postgres,
  MySQL) with penalties, rewards, and a fallback "insurance" limiter — but it is not edge-native,
  has no Web-standard `fetch` story, no GCRA, and no adaptive concurrency.
- **`@upstash/ratelimit`** is excellent for serverless/edge over HTTP Redis, with multi-region and
  an ephemeral deny cache — but it is bound to Upstash's HTTP Redis, offers no pure in-memory mode,
  and is rate-only (no concurrency control).

None of them give you the same algorithm running *identically* in-process and in Redis, a hot path
that avoids the network entirely under load, GCRA as a first-class citizen, or congestion-control
style backpressure in the same package. ThrottleKit does.

**The thesis:** the right primitive is small enough to be provably correct and fast, and general
enough that every deployment shape (single process, multi-process, edge, fleet) is a *policy* over
that primitive — not a different library.

---

## 2. What makes it novel

1. **Isomorphic dual-path strategies.** Each algorithm is authored once as a pure transition and
   compiled to two executors: a JavaScript path (in-process and optimistic-concurrency fallback)
   and a hand-verified Redis **Lua** path (single atomic round trip). A shared **conformance
   vector** suite asserts both paths produce bit-identical decisions for thousands of generated
   timelines. You get in-memory speed *and* distributed atomicity from one definition, proven equal.

2. **Two-tier L1/L2 engine with three coordination modes.** A local in-process tier (L1) fronts the
   distributed tier (L2) with selectable semantics: `strict` (exact, one round trip per request),
   `cached-deny` (denials cached locally so an attacker can't make you hammer Redis), and `leased`
   (each node leases token *batches* and serves them locally, driving steady-state network cost
   toward zero with a mathematically bounded global overshoot — opt into window-coupling and that
   bound becomes *independent of fleet size*).

3. **GCRA as the default.** The Generic Cell Rate Algorithm stores a *single timestamp* per key,
   paces traffic smoothly, supports bursts, and costs O(1) memory and CPU — yet it is rare in the
   JS ecosystem. ThrottleKit makes it the default and gives it an exact atomic Lua implementation.

4. **Adaptive concurrency built in.** Beyond counting requests, ThrottleKit ships a Netflix-style
   adaptive *concurrency* limiter that infers the safe in-flight ceiling from latency gradients
   (`gradient = RTT_noload / RTT_actual`) and adjusts with AIMD — real backpressure that protects a
   service from overload even when a static rate is wrong.

5. **Multi-dimensional checks in one round trip.** Compose per-IP ∧ per-user ∧ per-route limits and
   evaluate all of them atomically in a *single* Lua script — no N+1 round trips, no partial-consume
   anomalies.

6. **Edge-native and Node-native from one codebase.** A Web-standard `fetch` adapter runs on
   Cloudflare Workers, Deno, Bun, and Next.js edge; an Express adapter and a zero-allocation
   synchronous in-process path serve traditional Node. Same core, same semantics.

7. **Observability-first.** Every decision is a structured object; first-class OpenTelemetry metrics
   and events; IETF draft `RateLimit` headers plus legacy `X-RateLimit-*` and correct `Retry-After`.

8. **Deterministic and fully testable.** Time is injected everywhere. No `Date.now()` hides inside an
   algorithm. Every limit is reproducible in a unit test down to the millisecond.

9. **Provable distributed leasing.** The leasing bound anchors an engine we call *GALE* that makes
   overshoot **independent of fleet size** (shipped as `lease.windowCoupled`), sizes leases online with
   an `O(√T)`-regret guarantee (online EOQ, shipped as `lease.adaptive`), adds **weighted
   work-conserving fairness** across tenants (`weightedFairEscrow`, `federatedWeightedFairEscrow`), and
   proves a **trilemma** lower bound tying overshoot, coordination, and utilization. Each result is
   machine-checked (`test/gale/`) or measured. Pieces graduate into the public API as they harden.

---

## 3. Design principles

- **Pure core, effectful edges.** Algorithms never perform I/O or read the clock directly. They are
  `(state, now, cost) -> { state, decision }`. This makes them trivially testable and portable to Lua.
- **One storage primitive.** Stores expose exactly one mutating operation — an atomic `apply`. Adding
  a backend is implementing one method; adding an algorithm never touches a store.
- **Fast by default, exact on demand.** The common path (single process, or `leased` mode) is
  allocation-light and network-free. Exactness is a one-line mode change, not a rewrite.
- **Fail toward your intent.** Store outages resolve via an explicit `fail: "open" | "closed"` policy,
  never an accident.
- **Standards over invention at the boundary.** Wire formats (headers, status codes) follow the IETF
  draft and long-standing conventions so existing clients and SDKs interoperate.
- **No hidden globals.** Limiters, clocks, and stores are values you construct and inject, so tests and
  multi-tenant servers never share surprising state.

---

## 4. Core concepts and domain model

```
            ┌──────────────┐     check(key, cost)      ┌───────────────┐
 request ──►│   Adapter    │ ─────────────────────────►│   Limiter     │
            │ (express /   │                            │  strategy +   │
            │  fetch /     │◄───────────  Decision ─────│  store + key  │
            │  core)       │                            └──────┬────────┘
            └──────────────┘                                   │ apply(key, ttl, transform)
                                                               ▼
                                              ┌────────────────────────────────┐
                                              │              Store              │
                                              │  Memory │ Redis(Lua) │ TwoTier  │
                                              └────────────────────────────────┘
```

**Decision** — the immutable result of one check:

```ts
interface Decision {
  allowed: boolean;     // permit or reject
  limit: number;        // effective ceiling (burst capacity or window quota)
  remaining: number;    // whole units left before rejection
  resetAt: number;      // epoch-ms when the limiter is fully replenished
  retryAfterMs: number; // 0 when allowed; otherwise how long to wait
}
```

**Strategy** — a pure algorithm with serializable state `S`:

```ts
interface Strategy<S = unknown> {
  readonly name: string;             // surfaced in RateLimit-Policy and metrics
  readonly ttlMs: number;            // how long state stays relevant (store TTL)
  check(state: S | undefined, now: number, cost: number): { state: S; decision: Decision };
  readonly lua?: LuaProgram;         // optional atomic Redis form (dual-path)
}
```

**Store** — one atomic primitive plus housekeeping:

```ts
interface Store {
  apply<S, T>(key: string, ttlMs: number,
              transform: (state: S | undefined) => { state: S; result: T }): Promise<T>;
  reset(key: string): Promise<void>;
  close?(): Promise<void>;
}
```

**Clock** — injected time, so everything is deterministic:

```ts
interface Clock { now(): number } // epoch-ms
```

**Key** — the identity a limit applies to (an IP, user id, API key, route, or a composite). Keys are
derived by a pure `keyOf(ctx)` function and may be normalized/hashed (see §14).

---

## 5. Public API

### Core (any runtime)

```ts
import { rateLimit, gcra } from "throttlekit";

const limiter = rateLimit({
  strategy: gcra({ limit: 100, periodMs: 60_000, burst: 20 }), // 100/min, bursts of 20
  // store defaults to an in-process MemoryStore
});

const d = await limiter.check(userId);          // cost defaults to 1
if (!d.allowed) throw new TooMany(d.retryAfterMs);

// Synchronous, zero-allocation fast path for the in-memory store:
const d2 = limiter.checkSync(userId);           // available only with MemoryStore
```

### Express

```ts
import { expressRateLimit } from "throttlekit/express";
import { gcra } from "throttlekit";

app.use(expressRateLimit({
  strategy: gcra({ limit: 100, periodMs: 60_000, burst: 20 }),
  key: (req) => req.user?.id ?? req.ipKey,      // ipKey = normalized, proxy-correct (see §14)
  cost: (req) => (req.method === "POST" ? 5 : 1),
  fail: "open",                                  // allow if the store is unreachable
  onLimited: (req, _res, d) => metrics.inc("rl.block", { route: req.route?.path }),
}));
```

### Web / edge (`fetch`)

```ts
import { withRateLimit } from "throttlekit/fetch";
import { gcra } from "throttlekit";

export default {
  fetch: withRateLimit(handler, {
    strategy: gcra({ limit: 30, periodMs: 10_000 }),
    key: (req) => req.headers.get("cf-connecting-ip") ?? "anon",
  }),
};
```

### Distributed (Redis, atomic Lua)

```ts
import { rateLimit, gcra } from "throttlekit";
import { RedisStore } from "throttlekit/redis";
import Redis from "ioredis";

const store = new RedisStore({ client: new Redis(process.env.REDIS_URL) });

const limiter = rateLimit({
  strategy: gcra({ limit: 1000, periodMs: 60_000, burst: 100 }),
  store,                       // one EVALSHA per check, fully atomic
  prefix: "api",
});
```

### Two-tier (local + distributed, network-light)

```ts
import { twoTier } from "throttlekit";

const limiter = twoTier({
  strategy: gcra({ limit: 10_000, periodMs: 60_000, burst: 500 }),
  l2: store,                   // Redis
  mode: "leased",              // "strict" | "cached-deny" | "leased"
  lease: { batch: 50, lowWater: 10 }, // refill the local budget in batches of 50
});
```

### Multi-dimensional composition (one round trip on Redis)

```ts
import { all, gcra, fixedWindow } from "throttlekit";

const limiter = rateLimit({
  store,
  strategy: all({
    ip:    { key: (c) => c.ipKey,  strategy: gcra({ limit: 100, periodMs: 60_000 }) },
    user:  { key: (c) => c.userId, strategy: gcra({ limit: 1000, periodMs: 60_000 }) },
    route: { key: (c) => c.route,  strategy: fixedWindow({ limit: 50, windowMs: 1_000 }) },
  }),
});
// allowed only if every dimension allows; evaluated atomically together.
```

### Adaptive concurrency (backpressure)

```ts
import { adaptiveConcurrency } from "throttlekit";

const guard = adaptiveConcurrency({ minLimit: 4, maxLimit: 512, algorithm: "gradient2" });

const lease = guard.acquire();          // rejected if over the inferred ceiling
if (!lease.ok) return res.status(503).end();
try { await handle(req); }
finally { lease.release(/* measured latency captured automatically */); }
```

### Determinism in tests

```ts
import { rateLimit, gcra, ManualClock, MemoryStore } from "throttlekit";

const clock = new ManualClock(0);
const limiter = rateLimit({ strategy: gcra({ limit: 2, periodMs: 1000 }), clock,
                            store: new MemoryStore({ clock }) });

expect((await limiter.check("k")).allowed).toBe(true);
expect((await limiter.check("k")).allowed).toBe(true);
expect((await limiter.check("k")).allowed).toBe(false); // burst exhausted
clock.advance(500);
expect((await limiter.check("k")).allowed).toBe(true);  // one emission interval later
```

---

## 6. Algorithms (full specifications)

Every algorithm is a pure transition and (where it matters for distribution) has an atomic Lua form.
State shapes are deliberately compact to minimize serialization cost.

### 6.1 GCRA — Generic Cell Rate Algorithm *(default)*

**Idea.** Instead of counting tokens, track a single **theoretical arrival time** (TAT): the earliest
moment the *next* request would be perfectly paced. One number per key, no buckets to refill, no
arrays to trim. Smooth pacing with a configurable burst allowance.

**Parameters.** `limit` requests per `periodMs`; optional `burst` (instantaneous allowance, default
`limit`). Cost `q` defaults to 1.

```
T   = periodMs / limit          // emission interval (ms per request)
tau = T * burst                 // burst tolerance window
```

**Transition** at time `now` with cost `q`, given stored `tat` (or `now` if absent/expired):

```
tat'     = max(tat, now)
new_tat  = tat' + T * q
allow_at = new_tat - tau
if now < allow_at:   DENY,  retryAfterMs = ceil(allow_at - now)        // do not persist new_tat
else:                ALLOW, persist new_tat with ttl = ceil(new_tat - now)
                     remaining = floor((tau - (new_tat - now)) / T)
```

Starting empty (`tat = now`), requests `1..burst` are allowed instantaneously and request
`burst + 1` is denied; thereafter throughput settles to exactly `1/T`. **State is one float.**

**Atomic Lua (single round trip):**

```lua
-- KEYS[1]=key  ARGV: now, T, tau, inc(=T*q)
local tat = tonumber(redis.call('GET', KEYS[1]) or ARGV[1])
local now = tonumber(ARGV[1])
if tat < now then tat = now end
local new_tat  = tat + tonumber(ARGV[3+1])         -- inc
local allow_at = new_tat - tonumber(ARGV[3])       -- tau
if now < allow_at then
  return {0, math.ceil(allow_at - now)}            -- denied, retry_after_ms
end
redis.call('SET', KEYS[1], new_tat, 'PX', math.ceil(new_tat - now))
return {1, 0}
```

**Use when:** you want smooth pacing, tiny state, and a great general default. **Avoid when:** you
need exact "N in the last rolling window" accounting under bursty arrivals (use a sliding window).

### 6.2 Token bucket

**Idea.** A bucket of `capacity` tokens refilling at `refillPerSec`; each request spends `cost`
tokens. Allows bursts up to capacity, bounds the sustained rate. State: `{ tokens, last }`.

```
refillPerMs = refillPerSec / 1000
elapsed     = max(0, now - last)
tokens      = min(capacity, tokens + elapsed * refillPerMs)
allow       = tokens >= cost   →  tokens -= cost
retryAfterMs (deny) = ceil((cost - tokens) / refillPerMs)
resetAt     = now + ceil((capacity - tokens) / refillPerMs)
```

GCRA is mathematically equivalent for `burst = capacity`, but token bucket reports `remaining` as an
explicit token count, which some teams prefer for client UX.

### 6.3 Leaky bucket (queue / shaper)

A scheduling variant that *delays* rather than rejects, smoothing output to a fixed drain rate. Useful
for outbound shaping (e.g., third-party API budgets). Exposed via `limiter.schedule(key)` which
resolves when a slot is available, with a `maxQueueMs` ceiling that rejects rather than queuing
forever.

### 6.4 Fixed window

Counter per aligned window of `windowMs`. Cheapest and simplest; allows up to **2× limit** across a
boundary (documented, not a bug). State: `{ start, count }`. Atomic Lua = `INCR` + `PEXPIRE` on
first hit. Good for coarse abuse caps where the boundary burst is acceptable.

### 6.5 Sliding window log (exact)

Stores the timestamp of every accepted hit and counts those within the trailing `windowMs`. **Exact**,
but O(limit) memory per key. State: an ascending `number[]`. `retryAfterMs` is the time until the
oldest in-window hit expires. In Redis this maps to a sorted set
(`ZREMRANGEBYSCORE` + `ZCARD` + `ZADD`) inside one Lua script. Use for low/moderate limits where
precision matters (e.g., 5 password resets / hour).

### 6.6 Sliding window counter — sub-bucketed (bounded memory, near-exact)

The window is divided into `S` sub-buckets (default 10). Each request increments the current
sub-bucket; the count is the sum of sub-buckets overlapping `[now - windowMs, now]`, with the oldest
partial bucket weighted by its overlap fraction. **Error is bounded by one bucket width** (≈ `1/S` of
the window) while memory stays O(S) regardless of the limit. This is the sweet spot between fixed
window (cheap, 2× error) and exact log (precise, unbounded memory). The classic single-prev-window
weighted estimator is the `S = 1` special case and is also available as `slidingWindowCounter`.

### 6.7 Adaptive concurrency (Netflix-style)

Not a rate — a dynamically inferred ceiling on *in-flight* requests. See §10 for the full model.

**Selection cheat sheet**

| Goal | Pick |
|---|---|
| Best general default, tiny state, smooth pacing | **GCRA** |
| Client-friendly "tokens remaining", controlled bursts | Token bucket |
| Shape/queue outbound calls to a fixed rate | Leaky bucket |
| Cheapest coarse cap, boundary burst OK | Fixed window |
| Exact "N in the last X" at low limits | Sliding window log |
| Near-exact rolling window at any limit, bounded memory | Sliding window (sub-bucketed) |
| Protect a service from overload when the right rate is unknown | Adaptive concurrency |

---

## 7. Storage and the atomic `apply` primitive

Everything reduces to **one** method:

```ts
apply<S, T>(key, ttlMs, transform: (state?: S) => { state: S; result: T }): Promise<T>
```

`apply` must run `transform` **atomically** with respect to other applies on the same key. The
contract is the only thing a backend author must satisfy; the four built-in algorithms and all future
ones run on top of it unchanged.

### 7.1 MemoryStore (single process)

- **Atomicity for free.** Node is single-threaded; a *synchronous* read-modify-write cannot interleave.
  The sync fast path (`checkSync`) therefore needs no locks at all. The async `apply` honors the same
  guarantee via a tiny per-key promise-chain mutex so it composes with async stores.
- **Expiry.** A hierarchical **timer wheel** gives O(1) amortized expiry instead of scanning the map,
  plus lazy expiry on read. Keys past TTL are treated as absent.
- **Memory safety.** Optional bounds: `maxKeys` with CLOCK/2-hand approximate-LRU eviction, so a flood
  of unique keys (e.g., spoofed IPs) cannot grow the map without limit.
- **No JSON.** State is stored as native objects/numbers — zero serialization on the hottest path.

### 7.2 RedisStore (distributed, atomic)

- **One round trip.** Built-in strategies ship a Lua program; `apply` runs it via `EVALSHA` (with an
  `EVAL` + cache fallback on `NOSCRIPT`). No `WATCH`/`MULTI` retry loop, no read-then-write race.
- **Custom strategies still work.** A strategy without a Lua form falls back to **optimistic
  concurrency** (`WATCH`/`MULTI`/`EXEC` with bounded retries). Correct everywhere; the Lua path is
  simply faster on hot keys.
- **Compact encoding.** GCRA persists a single number; token bucket persists two. No JSON envelopes on
  the wire.
- **Sharding.** Keys are hash-tagged so multi-key scripts (multi-dimensional checks) land on one slot in
  Redis Cluster; consistent hashing spreads independent keys across shards.

### 7.3 Custom stores

Implement `apply` against anything with atomic semantics — Memcached (CAS), DynamoDB (conditional
writes), Cloudflare Durable Objects, Postgres (`INSERT ... ON CONFLICT` / advisory locks). A
`@throttlekit/store-testkit` runs your store through the same atomicity, TTL, and concurrency suite the
built-ins pass, so a third-party backend is verifiably correct.

---

## 8. The two-tier distributed engine (L1/L2)

A purely distributed limiter pays a network round trip on every request — the wrong cost exactly when
traffic (and attacks) spike. ThrottleKit fronts the distributed store (L2) with a local tier (L1) and
lets you choose the consistency/throughput tradeoff per limiter.

```
request ─► L1 (in-process, sync)
              │  hit & decisive?  ──► return locally (0 network)
              │  needs authority? ──► L2 (Redis, atomic Lua) ──► update L1
              ▼
           Decision
```

### Mode `strict` — exact, one round trip per request
L1 holds nothing authoritative; every check consults L2. Use when global exactness matters more than
latency (billing quotas, hard contractual caps).

### Mode `cached-deny` — DoS-resilient
L1 caches **denials** with their `retryAfterMs`. Once a key is over the limit, further requests are
rejected locally until the retry window passes — so an abusive client cannot translate its flood into
Redis load. Allowed requests still consult L2, so honest traffic stays globally accurate. This is the
"protect the protector" mode and a natural default for public endpoints.

### Mode `leased` — near-zero network, bounded overshoot
Each node atomically **leases a batch** of `B` tokens from the L2 bucket in one call, then serves up to
`B` requests entirely from L1. When the local budget hits `lowWater`, it leases again (asynchronously,
so requests never block on the refill). Idle leases are returned on a timer so capacity isn't stranded.

**Consistency model.** With `L` nodes each holding at most `B` leased tokens, the global count can
exceed the configured limit by at most `L × B` within a refill interval — a bound you choose. Set
`B = 1` to recover strict behavior; raise `B` to trade a known, small overshoot for collapsing network
cost from O(requests) to O(requests / B). This is the same bargain CPUs make with store buffers:
slightly relaxed global ordering for a large throughput win, with the looseness bounded and explicit.

**Sizing `B` automatically (GALE Pillar 2).** Rather than pin `B`, set `lease.adaptive` and each key's
batch is sized online: the limiter feeds a per-key learner the demand that key served each window and
leases at the size it reads back, descending onto the EOQ batch `√(2·orderCost·demand/strandPenalty)`
— trading L2 round trips against stranded budget without hand-tuning. Safety is unchanged: the `L × B`
(and, with `windowCoupled`, exactly `Limit`) bound holds for *any* `B` the learner picks. See
`examples/adaptive-lease-sizing.ts`.

| Mode | Network cost | Global accuracy | Best for |
|---|---|---|---|
| `strict` | 1 RTT / request | Exact | Hard quotas, billing |
| `cached-deny` | 1 RTT / *allowed* request | Exact for allows, local for denies | Public APIs under abuse |
| `leased` | ~1 RTT / `B` requests | Within `L × B` | High-throughput internal APIs |

---

## 9. Multi-dimensional limiting in one round trip

Real systems limit on several axes at once: per-IP *and* per-user *and* per-route. Done naïvely that is
N sequential checks (N round trips) and a partial-consume hazard — if dimension 3 denies after 1 and 2
consumed, you've leaked budget. `all({...})` solves both:

- **Atomic together.** On Redis, every dimension is evaluated in a **single Lua script** over
  hash-tagged keys, so the whole decision is one atomic round trip with no interleaving.
- **No partial consumption.** The script computes all decisions first and commits state only if *every*
  dimension allows; otherwise nothing is consumed and the tightest `retryAfterMs` is returned.
- **Representative decision.** The returned `Decision` reflects the binding constraint (the dimension
  that denied, or the smallest `remaining` when allowed), so your headers and logs name the real limit.

An `any({...})` combinator (allow if *any* dimension permits) and weighted costs per dimension are
supported with the same atomicity guarantees.

---

## 10. Adaptive concurrency (backpressure, not just counting)

Static rates assume you know the safe throughput in advance. Under real load — cold caches, a slow
dependency, a noisy neighbor — the safe number changes minute to minute. ThrottleKit includes an
adaptive *concurrency* limiter modeled on TCP congestion control and Netflix's `concurrency-limits`.

**Signal.** It measures the latency **gradient**:

```
gradient = RTT_noload / RTT_actual        // 1.0 ⇒ no queueing; < 1.0 ⇒ queue forming
```

`RTT_noload` is a rolling minimum (best-observed latency); `RTT_actual` is a recent average.

**Adjustment (gradient2 / AIMD family).**

```
newLimit = currentLimit × gradient + queueSize        // queueSize defaults to √limit
```

The `√limit` headroom term yields fast growth at small limits and stability at large ones. When
latency rises (gradient < 1), the limit contracts *multiplicatively* and fast; when the system is
healthy it grows *additively* — the familiar congestion-control **sawtooth** that continuously probes
for capacity without any manual tuning or central coordinator.

**Why bundle it.** Rate limiting answers "is this client asking too often?"; adaptive concurrency
answers "is the service about to fall over?". Together they prevent both client abuse and cascading
overload. Acquired permits auto-record their latency on `release()`, so integration is two lines.

---

## 11. Performance engineering

Performance is a design constraint here, not an afterthought. The mechanisms:

- **Synchronous, allocation-light hot path.** With the memory store, `checkSync` performs the entire
  decision without `await`, without locks (single-threaded RMW is atomic), and without allocating: a
  `checkInto(result, key)` variant writes into a caller-owned result struct so steady-state allocation
  is zero. Strategy state for GCRA/token-bucket is a number or a two-field record — monomorphic and
  cache-friendly.
- **GCRA's O(1) everything.** One number of state, a handful of FLOPs, no array trimming, no refill
  loop, no work at all while a key is quiescent.
- **Single round trip distributed.** `EVALSHA` executes the whole algorithm inside Redis atomically;
  no read-modify-write race, no `WATCH` retry storms on hot keys.
- **Batch the network away.** `leased` mode amortizes L2 cost across `B` requests; `cached-deny`
  removes L2 cost for abusive traffic entirely.
- **Pipelined / fused multi-checks.** Multi-dimensional limits fuse into one script; independent checks
  in a tick can be pipelined.
- **O(1) expiry.** A timer wheel replaces map scans; lazy expiry covers the rest.
- **Bounded memory.** Approximate-LRU caps key cardinality so adversarial key floods can't OOM you.
- **Compact wire format.** No JSON envelopes for built-in strategies; numbers go over the wire as
  numbers.

**Performance budgets (design targets, validated by the bundled benchmark suite — not vendor claims):**

| Path | Target |
|---|---|
| In-memory `checkSync` (GCRA) | sub-microsecond; **0 steady-state allocations** |
| In-memory `check` (async) | low single-digit microseconds |
| Redis `strict` decision | exactly **1** round trip; algorithm cost dominated by RTT |
| `leased` steady state | ~**1 round trip per `B` requests** |
| Multi-dimensional (k axes) on Redis | **1** round trip regardless of k |

A `npm run bench` harness ships with the package (workload generators, percentile reporting, and a
Redis-in-Docker mode) so every number above is reproducible on your hardware rather than asserted.

---

## 12. Correctness and consistency guarantees

- **Atomicity.** Under N concurrent requests against a limit of K, exactly K are allowed — guaranteed in
  memory (single-threaded RMW) and in Redis (Lua / OCC). This is a first-class test (see §16).
- **Monotonic time.** All algorithms are written against injected time and tolerate clock jumps:
  negative elapsed is clamped to zero; GCRA's `max(tat, now)` is jump-safe. Distributed paths use the
  Redis server clock (`TIME`) as the single source of truth so node clock skew never corrupts state.
- **Determinism.** Given the same clock, key sequence, and costs, decisions are reproducible exactly —
  the basis of conformance testing.
- **Bounded staleness.** In `leased` mode, global overshoot is provably ≤ `L × B`; in `cached-deny`,
  denials may persist up to one `retryAfterMs` after the global state would have allowed (fail-safe
  direction). Both bounds are documented and configurable.
- **Defined failure semantics.** Store errors resolve via `fail: "open" | "closed"`; there is no
  implicit behavior.

---

## 13. Observability

- **Structured decisions.** Every `Decision` is a plain object suitable for logging/auditing.
- **OpenTelemetry.** Optional metrics: `throttlekit.checks` (allowed/denied counters by strategy and
  key-dimension), `throttlekit.remaining` (histogram), `throttlekit.store.latency`, `throttlekit.lease`
  (lease acquisitions / overshoot), and adaptive-limiter gauges (`limit`, `rtt_noload`, `gradient`).
- **Events.** `onLimited`, `onError`, `onLease`, and `onAdapt` hooks for custom sinks.
- **Wire visibility.** Standards-compliant headers (see §15) make limits visible to clients and proxies
  without extra code.

---

## 14. Security and correctness footguns

Rate limiting is a security control; getting the *key* wrong silently defeats it.

- **Proxy-correct client IP.** Behind load balancers, the socket address is the proxy, not the client.
  ThrottleKit provides a `clientIp` helper with an explicit **trusted-proxy** configuration (hop count
  or CIDR allowlist) and refuses to blindly trust `X-Forwarded-For`. Misconfiguration here is the
  classic bypass in other libraries; here it is an explicit, validated choice.
- **IPv6 aggregation.** A single IPv6 customer controls a `/64` (or more). Limiting per full address is
  trivially bypassed. The default IP keyer aggregates IPv6 to a configurable prefix (`/64` by default)
  so one client can't rotate through billions of addresses.
- **PII-safe keys.** Keys can be hashed (e.g., HMAC-SHA-256 with a server secret) before storage, so the
  backing store never holds raw identifiers — useful for GDPR posture and shared Redis.
- **DoS resilience.** `cached-deny` mode and approximate-LRU bounds ensure that an attacker hammering a
  blocked key or spraying unique keys cannot amplify load on Redis or exhaust memory.
- **Fail direction is explicit.** Security-critical limits should `fail: "closed"`; availability-critical
  ones `fail: "open"`. The library never guesses.
- **No lockout amplification.** Denials don't extend the window (no "penalty by default"); optional
  penalties/rewards are opt-in and bounded.

---

## 15. HTTP headers

On every response the adapters can emit:

- **IETF draft `RateLimit` headers** — `RateLimit-Limit`, `RateLimit-Remaining`,
  `RateLimit-Reset` (seconds until reset), and a `RateLimit-Policy` describing the active strategy.
- **Legacy** — `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (epoch seconds), for
  clients and SDKs that still expect them.
- **On rejection** — HTTP `429 Too Many Requests` with **`Retry-After`** (seconds, rounded up, minimum
  1) derived from `retryAfterMs`.

Emission is configurable (`draft`, `legacy`, or both) and computed from the injected clock so header
math is deterministic in tests.

---

## 16. Testing strategy

The project is engineered to be *provably* correct, which is also what makes it a clean evaluation target.

- **Conformance vectors.** Thousands of generated `(arrivals, costs, clock)` timelines are run through
  both the JS and Lua paths of each strategy; the two must produce identical decision streams. This is
  what backs the "isomorphic dual-path" claim.
- **Boundary unit tests.** Each algorithm has explicit edge tests: GCRA burst-then-pace, fixed-window
  2× boundary, sliding-log exact expiry and `retryAfter`, sub-bucket weighting accuracy.
- **Concurrency/atomicity tests.** Fire N simultaneous checks at a limit of K and assert exactly K
  allowed — for MemoryStore and (env-gated) a real Redis.
- **Property tests.** Invariants like "remaining never negative", "never allow above limit + documented
  overshoot", and "leased overshoot ≤ L × B" are checked with randomized inputs.
- **Store conformance kit.** Any custom store is validated against the same atomicity/TTL/concurrency
  suite as the built-ins.
- **Chaos/integration.** Redis kill/restart during traffic verifies fail-open/closed behavior and OCC
  retry/EVALSHA-reload paths.
- **Benchmarks.** `npm run bench` reports throughput and p50/p99 for each path and mode, with a Dockerized
  Redis option, so performance budgets are reproducible.

All time-dependent tests use `ManualClock`, so the entire suite is deterministic and fast.

---

## 17. Configuration reference

```ts
rateLimit({
  strategy,                 // required: gcra() | tokenBucket() | fixedWindow() | slidingWindow() | all() | any()
  store?,                   // default: new MemoryStore()
  clock?,                   // default: systemClock
  prefix?,                  // namespace to share one store across many limiters
})

twoTier({
  strategy, l2,             // L2 = distributed store
  mode: "strict" | "cached-deny" | "leased",
  lease?: { batch, lowWater, returnIdleAfterMs },
  l1?: { maxKeys },
})

// Adapter options (express / fetch share these)
{
  limiter? | strategy,      // pass a prebuilt limiter or build one inline
  key,                      // (ctx) => string ; default: proxy-correct client IP
  cost?,                    // number | (ctx) => number ; default 1
  fail?: "open" | "closed", // store-error behavior ; default "open"
  headers?: { draft?, legacy? } | false,
  onLimited?, onError?,     // observability hooks
  handler?,                 // custom 429 responder
}

// Strategies
gcra({ limit, periodMs, burst? })
tokenBucket({ capacity, refillPerSec })
fixedWindow({ limit, windowMs })
slidingWindow({ limit, windowMs, buckets? })       // sub-bucketed; buckets default 10
slidingWindowLog({ limit, windowMs })              // exact
leakyBucket({ ratePerSec, maxQueueMs })

// Backpressure
adaptiveConcurrency({ minLimit, maxLimit, algorithm: "gradient2" | "aimd", rttWindow? })

// Stores
new MemoryStore({ clock?, maxKeys?, sweepIntervalMs? })
new RedisStore({ client, prefix?, useLua?, maxRetries? })   // ioredis or compatible
```

---

## 18. Comparison with prior art

Legend: ✓ supported · ◐ partial / via adapter · ✗ not supported.

| Capability | **ThrottleKit** | express-rate-limit | rate-limiter-flexible | @upstash/ratelimit |
|---|:--:|:--:|:--:|:--:|
| GCRA (single-timestamp) | ✓ | ✗ | ✗ | ✗ |
| Token bucket | ✓ | ✗ | ✓ | ✓ |
| Fixed window | ✓ | ✓ | ✓ | ✓ |
| Sliding window (counter) | ✓ | ✗ | ◐ | ✓ |
| Sliding window log (exact) | ✓ | ✗ | ◐ | ✗ |
| Leaky bucket / queueing | ✓ | ✗ | ✓ | ◐ |
| Adaptive concurrency | ✓ | ✗ | ✗ | ✗ |
| In-memory store | ✓ | ✓ | ✓ | ✗ |
| Redis store | ✓ | ◐ | ✓ | ◐ (Upstash HTTP) |
| Atomic single round trip (Lua) | ✓ | ✗ | ✓ | ✓ |
| Two-tier local cache | ✓ | ✗ | ◐ (insurance) | ◐ (ephemeral deny) |
| Token leasing (network-light) | ✓ | ✗ | ✗ | ✗ |
| Multi-dimensional, 1 round trip | ✓ | ✗ | ✗ | ✗ |
| Express adapter | ✓ | ✓ | ◐ | ✗ |
| Web `fetch` / edge | ✓ | ✗ | ✗ | ✓ |
| Injectable clock / determinism | ✓ | ✗ | ✗ | ✗ |
| OpenTelemetry metrics | ✓ | ✗ | ◐ | ◐ (analytics) |
| IETF draft headers | ✓ | ✓ | ✗ | ◐ |
| Proxy-correct IP + IPv6 prefix | ✓ | ◐ (manual) | ◐ | ◐ |
| TypeScript-first, ESM + CJS | ✓ | ✓ | ✓ | ✓ |

The differentiators that no competitor combines: **GCRA default + dual JS/Lua parity + two-tier leasing
+ multi-dimensional single-round-trip + adaptive concurrency**, in one edge-and-Node package.

---

## 19. Design tradeoffs and FAQ

**Why GCRA over token bucket as the default?** They're equivalent in behavior, but GCRA stores one
number instead of two and has no refill bookkeeping — smaller state on the wire and a simpler atomic
script. Token bucket remains available when you want to surface a literal token count.

**Why is `leased` mode not the default?** It trades a small, bounded global overshoot for throughput.
That's the right call for high-traffic internal services but wrong for hard billing quotas, so it's
opt-in. `cached-deny` is the recommended default for public endpoints; `strict` for exactness.

**Why optimistic concurrency *and* Lua in Redis?** Lua gives one atomic round trip for built-in
strategies. OCC (`WATCH`/`MULTI`) lets *any* custom pure strategy run correctly without writing Lua.
You get speed for the common case and generality for the rest.

**Why bundle adaptive concurrency with rate limiting?** They defend different failure modes (client
abuse vs. service overload) and share the same request hook. Shipping them together means one
integration point and consistent observability.

**Does the in-memory path really need no locks?** Correct — a synchronous read-modify-write cannot be
interrupted on Node's single thread. The async `apply` adds a per-key mutex only so it composes with
genuinely async stores.

**What about Redis Cluster?** Multi-key scripts use hash tags to co-locate a limiter's keys on one
slot; independent keys distribute across slots normally.

**Out of scope (deliberately).** A hosted control plane/dashboard, non-HTTP transports, and persistence
of historical analytics beyond metric export. The toolkit emits the signals; storing and visualizing
them is your observability stack's job.

---

## 20. Glossary

- **TAT** — Theoretical Arrival Time; GCRA's single piece of per-key state.
- **Emission interval (T)** — the ideal spacing between requests, `period / limit`.
- **Burst tolerance (τ)** — how far ahead of the ideal pace a client may run, `T × burst`.
- **L1 / L2** — local in-process tier / distributed (shared) tier.
- **Lease** — a batch of tokens checked out from L2 and spent locally in L1.
- **Overshoot** — how far global throughput may exceed the configured limit in relaxed modes; bounded by
  `L × B`.
- **Gradient** — `RTT_noload / RTT_actual`; the adaptive limiter's overload signal.
- **AIMD** — Additive-Increase / Multiplicative-Decrease; the congestion-control adjustment producing the
  sawtooth limit.
- **OCC** — Optimistic Concurrency Control; `WATCH`/`MULTI`/`EXEC` with retry on conflict.
- **Conformance vector** — a generated timeline used to prove the JS and Lua paths agree.

---

## 21. References

- Generic cell rate algorithm — Wikipedia: <https://en.wikipedia.org/wiki/Generic_cell_rate_algorithm>
- Brandur Leach, "Rate Limiting, Cells, and GCRA": <https://brandur.org/rate-limiting>
- James Lao, "GCRA Rate Limiting": <https://jameslao.com/post/gcra-rate-limiting/>
- SlashID, "Rate Limiting for Large-scale, Distributed Applications Using GCRA": <https://www.slashid.dev/blog/id-based-rate-limiting/>
- Redis, "Rate limiting patterns / Lua": <https://redis.io/tutorials/howtos/ratelimiting/> and <https://redis.io/docs/latest/develop/use-cases/rate-limiter/>
- Netflix Technology Blog, "Performance Under Load — Adaptive Concurrency Limits": <https://netflixtechblog.medium.com/performance-under-load-3e6fa9a60581>
- Netflix `concurrency-limits` (AIMD & gradient): <https://github.com/Netflix/concurrency-limits>
- Vector, "Adaptive Request Concurrency": <https://vector.dev/blog/adaptive-request-concurrency/>
- `@upstash/ratelimit` (algorithms, multi-region, ephemeral cache, analytics): <https://github.com/upstash/ratelimit-js>
- `rate-limiter-flexible` (backends, insurance limiter, penalties/rewards): <https://www.npmjs.com/package/rate-limiter-flexible>
- `express-rate-limit` (middleware, proxy/IP considerations): <https://www.npmjs.com/package/express-rate-limit>
- OneUptime, "Implement Rate Limiting with Redis" (local caching, Lua atomicity): <https://oneuptime.com/blog/post/2026-01-21-redis-rate-limiting/view>

---

*ThrottleKit — correctness you can prove, performance you can measure, and one configuration that
scales from a single process to a global fleet.*
