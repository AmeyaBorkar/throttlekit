# ThrottleKit

[![npm](https://img.shields.io/npm/v/throttlekit.svg)](https://www.npmjs.com/package/throttlekit)
[![CI](https://github.com/AmeyaBorkar/throttlekit/actions/workflows/ci.yml/badge.svg)](https://github.com/AmeyaBorkar/throttlekit/actions/workflows/ci.yml)
[![types: included](https://img.shields.io/npm/types/throttlekit.svg)](https://www.npmjs.com/package/throttlekit)
[![node: >=18](https://img.shields.io/node/v/throttlekit.svg)](https://www.npmjs.com/package/throttlekit)
[![license: MIT](https://img.shields.io/npm/l/throttlekit.svg)](./LICENSE)

**Rate limiting for Node and the web — one small core, from a sub-microsecond in-process check to a distributed fleet with a _proven_ overshoot bound.**

Pick an algorithm, a backend (in-memory, Redis, or Postgres), and your framework — the limiting logic stays the same. ThrottleKit rests on three ideas: **algorithms** are pure functions of time, **storage** is one atomic primitive, and **adapters** are thin glue. That separation is what lets the *same* config run as an allocation-free in-process check or atomically across a cluster.

What sets it apart is the distributed story: it isn't "a Redis counter and hope." The two-tier leasing path has a **formally-verified overshoot bound** that, with window-coupling, is **independent of fleet size** — model-checked, not asserted. It's young (`0.x`) but heavily tested: 389 tests, a dual-path (JS↔Lua) conformance suite, and a TLA⁺-checked protocol. The benchmarks below are reproducible on your hardware, and include the cases where ThrottleKit *loses*.

**Jump to:** [Install](#install) · [Quick start](#quick-start) · [Strategies](#choosing-a-strategy) · [Frameworks](#frameworks-and-the-edge) · [Distributed & provable](#going-distributed) · [Multi-dimensional](#limiting-on-several-axes) · [Backpressure](#backpressure-and-shaping) · [DDoS](#surviving-a-flood) · [Fairness](#overload-and-fairness) · [Performance](#performance) · [Migrating](#migrating) · [How it's tested](#how-its-tested)

---

## Highlights

- **Good defaults.** GCRA out of the box — smooth pacing, controlled bursts, one timestamp of state per key.
- **Seven strategies.** GCRA, token bucket, fixed & sliding window, sliding-window log, leaky-bucket shaping, and adaptive concurrency.
- **Three backends, identical decisions.** In-memory, Redis (one atomic Lua round trip), and Postgres (no Redis required) — proven bit-identical by the conformance suite.
- **Six frameworks + the edge.** Express, Web `fetch` (Cloudflare/Deno/Bun/Next edge), Hono, Next.js, Fastify, Koa — each its own subpath.
- **Provably scales out.** Two-tier token leasing and multi-region share one engine with a *formally-verified* overshoot bound (TLA⁺/TLC); opt into `lease.windowCoupled` and that bound becomes **independent of fleet size**.
- **A synchronous API.** `checkSync` — uncommon among JS limiters — for hot paths that don't want an `await`.
- **Operable.** Standards headers (IETF draft + RFC 9651 + legacy), proxy-correct IP keys, IPv6 aggregation, HMAC key hashing, OpenTelemetry, and zero-config analytics.
- **TypeScript-first.** ESM + CJS, 11 entry points, strict types, all peer deps optional.

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

Every check returns an immutable `Decision`:

```ts
interface Decision {
  allowed: boolean;     // permit or reject
  limit: number;        // effective ceiling (burst capacity or window quota)
  remaining: number;    // whole units left before the next rejection (never negative)
  resetAt: number;      // epoch-ms when the limiter is fully replenished
  retryAfterMs: number; // 0 when allowed; otherwise how long to wait
}
```

With the in-memory store you also get a synchronous, zero-`await` fast path, and a `cost` for weighting:

```ts
const d = limiter.checkSync(userId); // MemoryStore only; throws on async stores
await limiter.check(userId, 5);      // this request costs 5 units
```

Check **many keys at once** — each at one consistent timestamp, returned in order:

```ts
const decisions = await limiter.checkMany([ip, userId, apiKey]); // Decision[] in input order
const all = limiter.checkManySync(keys);                         // MemoryStore: one loop, no promises
```

On an async store the checks fire concurrently — and collapse to a single round trip on clients that pipeline same-tick commands (node-redis, or `ioredis` with `enableAutoPipelining`). Runnable versions of every section below live in [`examples/`](./examples).

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

- `gcra` stores a single number (the theoretical arrival time); `burst` defaults to `limit`.
- `slidingWindow` — `buckets` defaults to 10 (error ≈ 1/buckets of the window); `buckets: 1` is the classic estimator. `slidingWindowLog` is exact but O(limit) memory/key.
- `leakyBucket` and `adaptiveConcurrency` build a `Shaper` / concurrency guard, not a `Limiter` — see [Backpressure and shaping](#backpressure-and-shaping).

---

## Frameworks and the edge

### Express

```ts
import { expressRateLimit } from "throttlekit/express";
import { gcra } from "throttlekit";

app.use(
  expressRateLimit({
    strategy: gcra({ limit: 100, periodMs: 60_000, burst: 20 }),
    // Default key is a proxy-correct, IPv6-aggregated client IP (see Headers, IPs, and PII).
    key: (req) => req.headers["x-api-key"]?.toString() ?? req.ip ?? "anon",
    cost: (req) => (req.method === "POST" ? 5 : 1),
    fail: "open",            // allow if the store is unreachable ("open" | "closed")
    emit: { draft: true },   // emit IETF draft RateLimit headers (the default)
    onLimited: (req, _res, d) => console.warn("blocked", req.path, d.retryAfterMs),
  }),
);
```

On a denial the middleware responds `429` with `Retry-After`. Pass `handler` to own the `429`, or `limiter` instead of `strategy` to share a prebuilt limiter. See [`examples/express.ts`](./examples/express.ts).

### Web / edge (`fetch`)

Runs on Cloudflare Workers, Deno, Bun, and Next.js edge. The default key tries `cf-connecting-ip`, then `x-forwarded-for` (via the trusted-proxy policy), then `"anon"`.

```ts
import { withRateLimit } from "throttlekit/fetch";
import { gcra } from "throttlekit";

export default {
  fetch: withRateLimit(
    (req: Request) => new Response(`hello ${new URL(req.url).pathname}`),
    { strategy: gcra({ limit: 30, periodMs: 10_000 }), emit: { draft: true } },
  ),
};
```

On allow it forwards to your handler and copies the rate-limit headers onto the response; on deny it returns `429`. See [`examples/fetch-edge.ts`](./examples/fetch-edge.ts).

### Hono, Next.js, Fastify, Koa

Every adapter shares the same options (`strategy`/`limiter`, `store`, `key`, `cost`, `fail`, `emit`, `onLimited`, `handler`, trusted-proxy config) and the same standards headers — only the binding differs, and each is its own subpath.

```ts
import { honoRateLimit } from "throttlekit/hono";       // edge-first
app.use("*", honoRateLimit({ strategy: gcra({ limit: 30, periodMs: 10_000 }) }));

import { fastifyRateLimit } from "throttlekit/fastify";  // Fastify v5
fastify.addHook("onRequest", fastifyRateLimit({ strategy: gcra({ limit: 100, periodMs: 60_000 }) }));

import { koaRateLimit } from "throttlekit/koa";          // Koa v3
app.use(koaRateLimit({ strategy: gcra({ limit: 100, periodMs: 60_000 }) }));
```

**Next.js** middleware is dependency-free (`NextRequest`/`NextResponse` are Web `Request`/`Response`) — call the limiter, then branch:

```ts
// middleware.ts
import { NextResponse, type NextRequest } from "next/server";
import { nextRateLimit } from "throttlekit/next";
import { gcra } from "throttlekit";

const limit = nextRateLimit({ strategy: gcra({ limit: 30, periodMs: 10_000 }) });

export async function middleware(req: NextRequest) {
  const r = await limit(req);
  if (r.limited) return r.response;            // 429 (or 503 on a fail-closed outage)
  const res = NextResponse.next();
  for (const [k, v] of Object.entries(r.headers)) res.headers.set(k, v);
  return res;
}
```

For Next.js **route handlers**, use `throttlekit/fetch` directly — they're Web `fetch` handlers.

---

## Going distributed

The same strategy you ran in-memory runs across a fleet — just hand it a distributed store. Every backend produces the same decisions (the conformance suite proves it).

### Redis — atomic Lua, one round trip

```ts
import { rateLimit, gcra } from "throttlekit";
import { RedisStore } from "throttlekit/redis";
import Redis from "ioredis";

const store = new RedisStore({ client: new Redis(process.env.REDIS_URL) });

const limiter = rateLimit({
  strategy: gcra({ limit: 1000, periodMs: 60_000, burst: 100 }),
  store,         // one EVALSHA per check, fully atomic — no read-then-write race
  prefix: "api", // namespace, so one store can back many limiters
});

const d = await limiter.check(userId);
```

Built-in strategies run their atomic Lua form in a single `EVALSHA` (with an `EVAL` fallback on `NOSCRIPT`); custom strategies fall back to optimistic concurrency (`WATCH`/`MULTI`/`EXEC`). `RedisStore` derives `now` from the Redis server clock, so node clock skew never corrupts shared state.

**Any Redis client — including serverless / edge.** `RedisStore` speaks the `ioredis` shape directly; for the official **node-redis** client or the **Upstash REST** client (where TCP isn't allowed), wrap it:

```ts
import { RedisStore, fromNodeRedis, fromUpstash } from "throttlekit/redis";

new RedisStore({ client: new Redis(url) });                  // ioredis — straight through
new RedisStore({ client: fromNodeRedis(nodeRedisClient) });  // official `redis` client
new RedisStore({ client: fromUpstash(Upstash.fromEnv()) });  // Upstash REST — serverless/edge
```

All three are proven bit-identical to the in-process path by the conformance suite (ioredis and node-redis tested against a live server). Upstash REST has no interactive `WATCH`/`MULTI`, so it supports the Lua-backed built-ins only. See [`examples/redis-distributed.ts`](./examples/redis-distributed.ts).

### PostgreSQL — no Redis required

Already running Postgres? You don't need to add Redis. `PostgresStore` is a fully distributed backend:

```ts
import { rateLimit, gcra } from "throttlekit";
import { PostgresStore } from "throttlekit/postgres";
import { Pool } from "pg";

const store = new PostgresStore({ pool: new Pool({ connectionString: process.env.DATABASE_URL }), prefix: "api" });
const limiter = rateLimit({ strategy: gcra({ limit: 1000, periodMs: 60_000, burst: 100 }), store });
const d = await limiter.check(userId);
```

It runs the **same pure JS transform** the in-memory store runs — no Postgres-specific algorithm to keep in sync — inside a transaction serialized per key by a transaction-scoped **advisory lock** (`pg_advisory_xact_lock`, which serializes first-touch keys that `SELECT … FOR UPDATE` cannot). So concurrent checks are atomic (N simultaneous at limit K admit exactly K, proven on a live server) and decisions are bit-identical to the other backends. Pass a `pg.Pool` directly — no adapter. Each check is one transaction; for hot keys, use it as the L2 of `twoTier({ mode: "leased" })`. See [`examples/postgres.ts`](./examples/postgres.ts).

### Two-tier — local cache in front of the network

Front the distributed store (L2) with a local in-process tier (L1) and pick the consistency/throughput trade-off:

```ts
import { twoTier, gcra } from "throttlekit";

const limiter = twoTier({
  strategy: gcra({ limit: 10_000, periodMs: 60_000, burst: 500 }),
  l2: store,                                   // a distributed store, e.g. RedisStore
  mode: "leased",                              // "strict" | "cached-deny" | "leased"
  lease: { batch: 50, windowCoupled: true },   // lease 50 at a time; expire at the L2 window
});
```

| Mode | Network cost | Global accuracy | Best for |
|---|---|---|---|
| `strict` | 1 round trip / request | Exact | Hard quotas, billing |
| `cached-deny` | 1 round trip / *allowed* request | Exact for allows, local for denies | Public APIs under abuse |
| `leased` | ~1 round trip / `batch` requests | Bounded overshoot (below) | High-throughput internal APIs |

`leased` trades exactness for throughput, with a **provably bounded** worst-case overshoot you choose:

- **Default (carryover):** `admitted ≤ Limit + N·(Batch−1)` — tight, but grows with the fleet size `N`.
- **`windowCoupled: true`:** credits expire at the L2 window boundary, so `admitted ≤ Limit` — **independent of `N`**. Opt-in; default off preserves legacy behaviour. `twoTier`'s `check` is async (`checkSync` throws — L2 is asynchronous).

> **Formally verified — and independent of fleet size.** These bounds are proven, not claimed. A [TLA⁺ spec](./spec/DistributedLeasing.tla) is **model-checked with TLC** — carryover overshoot is *exactly* `Limit + N·(Batch−1)` (a counterexample shows it's tight, not loose) — and window-coupling tightens it to **exactly `Limit`, independent of N** ([second spec](./spec/GaleWindowCoupledLeasing.tla) + a Java-free [exhaustive checker](./test/gale/leasing-variants.test.ts) reproducing both in CI). This is the shipped core of **GALE**, a research program on provable distributed leasing — adding learned (online-EOQ) lease sizing, weighted work-conserving fairness, and a proved overshoot/coordination/utilization **trilemma** lower bound, each machine-checked or measured under [`research/gale/`](./research/gale). Details: [`docs/FORMAL-MODEL.md`](./docs/FORMAL-MODEL.md).

### Multi-region

A global limit across regions is the leased model with the **regions as the leasing nodes** and one shared L2. Each region serves the bulk of its traffic from a local lease — region-local latency, no per-request cross-region hop — and the *same* verified bound caps the **worldwide** overshoot:

```text
global admitted per window  ≤  Limit + regions × (batch − 1)   (carryover)
                            ≤  Limit                            (windowCoupled — any number of regions)
```

So 4 regions leasing `batch: 50` against a global `limit: 10_000` admit at most `10_196` worldwide under carryover (< 2% overshoot for ~1 cross-region hop per 50 requests) — or **exactly `10_000` with `windowCoupled`, no matter how many regions**. There's no separate multi-region engine to trust — it's `twoTier` leased at a shared store. See [`examples/multi-region.ts`](./examples/multi-region.ts).

---

## Limiting on several axes

Limit on per-IP **and** per-user **and** per-route at once. `all({...})` allows only if **every** dimension allows, and consumes nothing unless all allow (no partial-consume). `any({...})` allows if any permits. Pass the result to **`multiRateLimit`** (not `rateLimit`):

```ts
import { all, gcra, fixedWindow, multiRateLimit } from "throttlekit";

interface Ctx { ip: string; userId: string; route: string }

const limiter = multiRateLimit<Ctx>({
  store, // on Redis, all dimensions fuse into one atomic Lua round trip
  strategy: all<Ctx>({
    ip:    { key: (c) => c.ip,     strategy: gcra({ limit: 100, periodMs: 60_000 }) },
    user:  { key: (c) => c.userId, strategy: gcra({ limit: 1000, periodMs: 60_000 }) },
    route: { key: (c) => c.route,  strategy: fixedWindow({ limit: 50, windowMs: 1_000 }) },
  }),
});

const d = await limiter.check({ ip, userId, route: "/search" });
```

The returned `Decision` reflects the binding constraint (the denying dimension, or the smallest `remaining` when allowed). Dimensions support per-dimension `cost`. On Redis, multi-dimensional checks support `gcra`, `tokenBucket`, and `fixedWindow`. See [`examples/multi-dimensional.ts`](./examples/multi-dimensional.ts).

---

## Backpressure and shaping

### Adaptive concurrency

Not a rate — a dynamically inferred ceiling on *in-flight* requests, derived from the latency gradient (`RTT_noload / RTT_actual`) and adjusted with a congestion-control sawtooth.

```ts
import { adaptiveConcurrency } from "throttlekit";

const guard = adaptiveConcurrency({ minLimit: 4, maxLimit: 512, algorithm: "gradient2" });

const lease = guard.acquire();
if (!lease.ok) return; // over the inferred ceiling — shed load (e.g. 503)
try {
  await handle(request);
} finally {
  lease.release(); // latency measured automatically; pass { dropped: true } on a failure/timeout
}
```

Introspect with `guard.limit`, `guard.inflight`, `guard.stats()`. Algorithms: `"gradient2"` (default) or `"aimd"`. See [`examples/adaptive-concurrency.ts`](./examples/adaptive-concurrency.ts).

### Leaky-bucket scheduling

`leakyBucket` builds a `Shaper` that *delays* rather than rejects, smoothing bursty input to a steady output rate — handy for pacing outbound calls to a third-party budget.

```ts
import { leakyBucket, QueueFullError } from "throttlekit";

const shaper = leakyBucket({ ratePerSec: 5, maxQueueMs: 2_000 });
try {
  await shaper.schedule("upstream-api"); // resolves after the paced delay
  await callUpstream();
} catch (err) {
  if (err instanceof QueueFullError) console.warn("queue full, retry in", err.retryAfterMs, "ms");
}
```

`reserve(key, cost?)` returns a `Reservation` (`{ accepted, delayMs }`) without sleeping; `schedule` waits or throws `QueueFullError`. `reserveSync` is available on a sync store. See [`examples/leaky-bucket.ts`](./examples/leaky-bucket.ts).

---

## Surviving a flood

Per-key stores keep one record per active key — which, under a flood of *millions of distinct* keys (every source IP in a volumetric attack), makes that state itself the memory-exhaustion vector. `sketchRateLimit` limits an **unbounded key universe in fixed memory** with a Count-Min Sketch: ~**7.4 KB total**, regardless of how many keys it sees.

```ts
import { sketchRateLimit } from "throttlekit";

const shield = sketchRateLimit({ limit: 100, windowMs: 60_000 }); // ε=0.01, δ=0.001 by default
if (!shield.checkSync(clientIp).allowed) return reject(429);       // sync or async (check)
```

Because the sketch never *under*counts, `allowed` implies the true admitted count is ≤ `limit` — it never over-admits (a hard, non-probabilistic property). Its only error is the safe direction: it may deny a key slightly early once collisions inflate its estimate, bounded by `ε·N` w.p. `≥ 1−δ` ([Cormode & Muthukrishnan 2005](http://dimacs.rutgers.edu/~graham/pubs/papers/cmencyc.pdf); conservative-update from Estan & Varghese).

**Cluster-wide (`mergeableSketch`).** A low-and-slow distributed attacker can stay under every node's threshold while flooding the fleet. Because CMS counters are linear, each node keeps its own fixed-memory sketch, ships it as compact bytes (`snapshot()` / `toBytes()`), and `merge()`s peers' — the sum is *exactly* the sketch of the whole cluster's traffic, so the global heavy hitter becomes visible everywhere. Honestly scoped as eventually-consistent **detection**, not a strongly-consistent global limit. See [`examples/distributed-sketch.ts`](./examples/distributed-sketch.ts).

---

## Overload and fairness

Two admission-control primitives that sit *upstream* of the per-key limiters.

**`adaptiveThrottle`** — Google-SRE [client-side adaptive throttling](https://sre.google/sre-book/handling-overload/). A client that keeps hammering an overloaded backend only deepens the overload; this sheds a growing fraction *locally* based on the backend's recent accept rate:

```ts
import { adaptiveThrottle } from "throttlekit";

const throttle = adaptiveThrottle({ k: 2 }); // shed once sending > 2× what the backend accepts
if (!throttle.request()) return failFast();   // shed locally, don't even try
try { const res = await callBackend(); throttle.record(res.ok); }
catch { throttle.record(false); }            // feed outcomes back so it self-corrects
```

`p = max(0, (requests − K·accepts) / (requests + 1))` over a rolling window; `request(priority)` protects critical traffic.

**`fairShare`** — split one global per-window budget across tenants so a greedy tenant can't starve the others (each active tenant guaranteed ≥ `limit/N`, global total ≤ `limit`):

```ts
import { fairShare } from "throttlekit";
const fair = fairShare({ limit: 1000, windowMs: 60_000 });
const d = fair.checkSync(tenantId); // d.limit is this tenant's current fair cap
```

**`weightedFairShare` / `weightedMaxMin`** — weighted fairness (*Weighted Fair Escrow*). Give tenants priority weights and the budget splits in proportion; `weightedMaxMin` is the exact, **work-conserving** weighted max-min split (an idle tenant's share flows to the backlogged ones; every backlogged tenant gets at least its weighted floor):

```ts
import { weightedFairShare, weightedMaxMin } from "throttlekit";
const fair = weightedFairShare({ limit: 1000, windowMs: 60_000, weightOf: (t) => t === "pro" ? 4 : 1 });
weightedMaxMin([100, 100, 100, 100], [4, 1, 1, 1], 100); // → [57, 15, 14, 14]: weighted, sums to the budget
```

`weightedFairShare` is the online streaming limiter (weighted caps, honest online caveats); `weightedMaxMin` is the proven batch allocator (use it to divide, e.g., a `twoTier` node's leased batch among local tenants). Both are the shipped piece of *Weighted Fair Escrow*; its four fairness properties are machine-checked in the [research track](./research/gale/PILLAR4-fairness.md). Fully-distributed weighted *leasing* (weighted L2 grants across nodes) remains research.

---

## Deterministic time

Time is injected everywhere — no `Date.now()` hides inside an algorithm — so every limit is reproducible to the millisecond.

```ts
import { rateLimit, gcra, ManualClock, MemoryStore } from "throttlekit";

const clock = new ManualClock(0);
const limiter = rateLimit({
  strategy: gcra({ limit: 2, periodMs: 1_000 }), // burst defaults to 2
  clock,
  store: new MemoryStore({ clock }),
});

(await limiter.check("k")).allowed; // true
(await limiter.check("k")).allowed; // true
(await limiter.check("k")).allowed; // false — burst exhausted
clock.advance(500);                 // one emission interval (1000/2) later
(await limiter.check("k")).allowed; // true
```

`ManualClock` exposes `.advance(ms)`, `.set(ms)`, `.now()`. See [`examples/basic-memory.ts`](./examples/basic-memory.ts).

---

## Headers, IPs, and PII

**Standards-compliant headers.** `buildRateLimitHeaders(decision, opts)` produces a plain `Record<string, string>` (the adapters call it for you), in three families via `emit`: **`draft`** *(default)* — the IETF `RateLimit-Limit`/`-Remaining`/`-Reset` triple; **`structured`** — RFC 9651 `RateLimit` + `RateLimit-Policy`; **`legacy`** — the `X-RateLimit-*` triple. On a denial a `Retry-After` (delta-seconds, min 1) is always added, and all time math derives from the injected `now`.

**Trusted proxy & IPv6 aggregation.** Trusting `X-Forwarded-For` blindly is the classic bypass. `clientIp` refuses to: the default is `trustProxy: false` (use the socket peer), trust is opt-in as a hop count or CIDR allowlist, and it aggregates IPv6 to a configurable prefix (`/64` default) so one customer can't rotate through billions of addresses.

```ts
import { clientIp } from "throttlekit";

const key = clientIp(
  { remoteAddr: req.socket.remoteAddress ?? "", xForwardedFor: req.headers["x-forwarded-for"] },
  { trustProxy: ["10.0.0.0/8"], ipv6Prefix: 64 }, // or trustProxy: 1 for a single hop
);
```

The Express and `fetch` adapters accept `trustProxy`/`ipv6Prefix` directly and derive this key by default.

**PII-safe keys (HMAC).** Hash raw identifiers with a server secret before they reach the store, so a shared Redis never holds the raw value:

```ts
import { hmacKeyer } from "throttlekit";
const keyer = hmacKeyer(process.env.RL_SECRET ?? "");
await limiter.check(keyer(rawUserId));
```

---

## Observability

Every `Decision` is a plain, loggable object. For metrics, the optional OpenTelemetry layer (`throttlekit/otel`) wraps a limiter or guard with your own `Meter`:

```ts
import { instrumentLimiter, instrumentGuard } from "throttlekit/otel";
import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("my-service");
const observed = instrumentLimiter(limiter, meter); // throttlekit.checks / .remaining / .store.latency
instrumentGuard(guard, meter);                       // concurrency.limit / .inflight / .rtt_noload
```

For zero-config insight without a metrics backend, wrap a limiter with **`withAnalytics`** — it tracks allow/deny counts and the **top-K heavy hitters** (keys driving the most traffic and denials) in bounded memory via **Space-Saving** (Metwally et al. 2005), so your worst offenders surface even under a flood of unique keys:

```ts
import { withAnalytics, rateLimit, gcra } from "throttlekit";

const limiter = withAnalytics(rateLimit({ strategy: gcra({ limit: 100, periodMs: 60_000 }) }));
await limiter.check(clientIp); // use exactly like any limiter
const a = limiter.analytics(); // { allowed, denied, total, denyRate, topRequested: [...], topDenied: [...] }
```

---

## When the backend goes down

The in-process `MemoryStore` never fails. A distributed store can: if Redis is unreachable, `check()` rejects (`StoreUnavailableError`). **You decide what that means** — every adapter takes a `fail` policy and fires `onError` before applying it:

| `fail` | On a store outage | Use when |
|---|---|---|
| `"open"` *(default)* | Allow the request | Availability > the cap — most public APIs |
| `"closed"` | Reject with `503` | The cap is a hard guarantee — billing, abuse-critical paths |

```ts
expressRateLimit({
  strategy: gcra({ limit: 100, periodMs: 60_000 }),
  store: redisStore,
  fail: "closed",
  onError: (_req, _res, err) => log.warn({ err }, "rate limiter store down"),
});
```

Two extra hedges: **`twoTier` leased** keeps serving from the local lease while L2 is briefly unreachable, and the Redis path is a single atomic round trip (no read-then-write window to interrupt). Both fail modes are tested on every adapter.

---

## Performance

In-process, single hot key (Node 24, reproducible via `npm run bench`; numbers vary ~±10%):

- **`checkSync` (GCRA): ~3.1M ops/s, ~320 ns/op, allocation-free.**
- `check` (async, GCRA): **~1.7M ops/s** (~600 ns/op).
- Redis: exactly **one** `EVALSHA` round trip per check.

**Head-to-head, the honest version** (`npm run bench:compare`, same machine/process/warmup):

- **Sync:** one of the few JS limiters with a synchronous API at all, and it's allocation-free.
- **Redis:** roughly **tied** with `rate-limiter-flexible` (both one atomic Lua round trip), with a tighter tail.
- **Async in-memory:** the counter-based libraries are **faster** (~2–5M vs ~1.3–1.7M ops/s) — the cost of GCRA over a bounded-memory store vs a plain counter; all far past per-process need.
- **Postgres:** a single bare check **trails** `rate-limiter-flexible`'s one-statement upsert (~3×, by design — one generic transaction per strategy); under load, `twoTier(leased)` amortizes it into a large throughput win.

The full table — algorithms labelled, methodology, and every place ThrottleKit loses — is in [SCOREBOARD.md](./SCOREBOARD.md).

---

## Migrating

**From `express-rate-limit`:**

```ts
// before
app.use(rateLimit({ windowMs: 60_000, limit: 100 }));
// after — GCRA by default (smooth pacing, no 2× boundary burst), same standards headers
import { expressRateLimit } from "throttlekit/express";
import { gcra } from "throttlekit";
app.use(expressRateLimit({ strategy: gcra({ limit: 100, periodMs: 60_000 }) }));
// want the classic window? swap in fixedWindow({ limit: 100, windowMs: 60_000 })
```

**From `rate-limiter-flexible`:**

```ts
// before — throws on exhaustion
try { await rl.consume(key); } catch { /* respond 429 */ }
// after — one atomic Lua round trip, a Decision object instead of throw-on-deny
import { rateLimit, gcra } from "throttlekit";
import { RedisStore } from "throttlekit/redis";
const limiter = rateLimit({ strategy: gcra({ limit: 100, periodMs: 60_000 }), store: new RedisStore({ client: redis }) });
const d = await limiter.check(key);
if (!d.allowed) { /* respond 429 with d.retryAfterMs */ }
```

---

## Recipes

```ts
// Tiered plans (free / pro) by API key — one store, namespaced per tier
const limiters = {
  free: rateLimit({ strategy: gcra({ limit: 60, periodMs: 60_000 }), store, prefix: "free" }),
  pro:  rateLimit({ strategy: gcra({ limit: 1_000, periodMs: 60_000 }), store, prefix: "pro" }),
};
const d = await limiters[planFor(req)].check(apiKeyOf(req));

// Cost-weighted endpoints — charge expensive routes more from the same budget
await limiter.check(apiKeyOf(req), routeIsExpensive(req) ? 5 : 1);
```

**Per-IP *and* per-route in one round trip** — see [Limiting on several axes](#limiting-on-several-axes). **Tiered burst + sustained** — compose two GCRA limiters (e.g. 10/sec *and* 1000/hour) and allow only if both pass.

---

## How it's tested

ThrottleKit is built to be checkable, not just claimed:

- **Dual-path conformance** — thousands of generated `(arrivals, costs, clock)` timelines run through both the JS and Lua path of each strategy; the two must produce identical decision streams.
- **Property tests** (fast-check) — invariants like "`remaining` never negative" and "leased overshoot ≤ documented bound" under randomized inputs.
- **Atomicity** — fire N simultaneous checks at limit K and assert exactly K allowed, for MemoryStore and (env-gated) real Redis and Postgres.
- **Formal model** — the leasing protocol is model-checked with TLA⁺/TLC and re-checked by an exhaustive JS checker in CI ([`docs/FORMAL-MODEL.md`](./docs/FORMAL-MODEL.md)).
- **Research track (GALE)** — that bound is the foundation of an ongoing program: overshoot *independent of fleet size*, learned (online-EOQ) lease sizing, weighted work-conserving fairness, and a proved *trilemma* lower bound — each machine-checked or measured under [`research/gale/`](./research/gale). (Research modules; not public API beyond `lease.windowCoupled`.)
- **Store conformance kit** — `runStoreConformance` from `throttlekit/testkit` runs any custom store through the same atomicity / TTL / concurrency suite the built-ins pass.

All time-dependent tests use `ManualClock`, so the suite is deterministic. Current state: **389 tests, 95.2% line coverage**, CI green across Node 20/22/24 — tracked in [SCOREBOARD.md](./SCOREBOARD.md).

---

## Design and docs

- [THROTTLEKIT.md](./THROTTLEKIT.md) — full design and architecture.
- [SCOREBOARD.md](./SCOREBOARD.md) — benchmarks, correctness guarantees, feature matrix.
- [docs/FORMAL-MODEL.md](./docs/FORMAL-MODEL.md) — the formally-verified leasing bound.
- [research/gale/](./research/gale) — the GALE research track: provable distributed leasing (overshoot independent of fleet size, learned lease sizing, weighted fairness, the trilemma lower bound).
- [CHANGELOG.md](./CHANGELOG.md) — release history.
- [`examples/`](./examples) — a runnable file for every section above.

---

## Status

ThrottleKit is `0.x`: feature-complete and heavily tested, but young — the public API may still be refined before a `1.0` that commits to SemVer stability. MIT-licensed and developed in the open.

## License

MIT
