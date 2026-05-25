# ThrottleKit

[![npm](https://img.shields.io/npm/v/throttlekit.svg)](https://www.npmjs.com/package/throttlekit)
[![CI](https://github.com/AmeyaBorkar/throttlekit/actions/workflows/ci.yml/badge.svg)](https://github.com/AmeyaBorkar/throttlekit/actions/workflows/ci.yml)
[![types: included](https://img.shields.io/npm/types/throttlekit.svg)](https://www.npmjs.com/package/throttlekit)
[![node: >=18](https://img.shields.io/node/v/throttlekit.svg)](https://www.npmjs.com/package/throttlekit)
[![license: MIT](https://img.shields.io/npm/l/throttlekit.svg)](./LICENSE)

**Correctness you can prove, performance you can measure, and one configuration that scales from a single process to a global fleet.**

A pluggable, framework-agnostic rate-limiting toolkit for Node and the web. The same limit runs as a sub-microsecond in-process check, a single atomic Redis round trip, or a near-zero-network leased budget across a fleet — all from one configuration.

---

## Install

```sh
npm i throttlekit
```

Peer dependencies are **optional** and only needed for the adapters you actually use:

```sh
npm i ioredis              # for throttlekit/redis
npm i pg                   # for throttlekit/postgres
npm i express              # for throttlekit/express
npm i @opentelemetry/api   # for throttlekit/otel
```

The Web `fetch` adapter (`throttlekit/fetch`) has no peer dependencies — it uses the global `Request`/`Response`/`Headers` (Node 18+, Cloudflare Workers, Deno, Bun).

---

## Why

Most rate limiters solve one slice of the problem and punt on the rest: bound to one framework, one algorithm, one backend, or one deployment shape. ThrottleKit treats rate limiting as three cleanly separated concerns — **algorithms** (pure functions of time), **storage** (one atomic primitive), and **adapters** (thin glue) — so every deployment shape is a *policy* over the same provably-correct core, not a different library.

What no competitor combines in one edge-and-Node package:

- **GCRA by default** — the Generic Cell Rate Algorithm stores a single timestamp per key, paces traffic smoothly, supports bursts, and costs O(1) memory and CPU.
- **Isomorphic JS/Lua dual-path** — each algorithm is authored once and compiled to a JavaScript executor *and* a hand-verified Redis Lua executor; a conformance-vector suite proves both paths produce bit-identical decisions.
- **Two-tier leasing** — a local L1 tier fronts a distributed L2 with `strict`, `cached-deny`, or `leased` modes, driving steady-state network cost toward zero with a bounded overshoot.
- **Multi-dimensional, single round trip** — per-IP ∧ per-user ∧ per-route limits evaluated atomically in one Lua script, with no partial-consume hazard.
- **Adaptive concurrency** — a Netflix-style backpressure limiter that infers the safe in-flight ceiling from latency gradients (real overload protection, not just counting).
- **Edge + Node from one codebase** — a Web `fetch` adapter and an Express adapter over the same core and semantics.

See [THROTTLEKIT.md](./THROTTLEKIT.md) for the full design and architecture, and [SCOREBOARD.md](./SCOREBOARD.md) for benchmark targets and status.

---

## Quickstart (in-memory GCRA)

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

With the in-memory store you also get a synchronous, zero-`await` fast path:

```ts
const d = limiter.checkSync(userId); // MemoryStore only; throws on async stores
```

You construct and pass a `cost` to spend more than one unit per request:

```ts
await limiter.check(userId, 5); // this request costs 5 units
```

Check **many keys at once** — every key evaluated at one consistent timestamp, returned in order:

```ts
const decisions = await limiter.checkMany([ip, userId, apiKey]); // Decision[] in input order
const all = limiter.checkManySync(keys);                         // MemoryStore: one loop, no promises
```

On an async store the checks fire concurrently — a single round trip on clients that pipeline
same-tick commands (node-redis, or `ioredis` with `enableAutoPipelining`). Intended for distinct keys.

---

## Strategies

Pick a strategy and pass it to `rateLimit({ strategy })`:

| Goal | Strategy |
|---|---|
| Best general default — tiny state, smooth pacing, controlled bursts | **`gcra({ limit, periodMs, burst? })`** |
| Client-friendly "tokens remaining", controlled bursts | `tokenBucket({ capacity, refillPerSec })` |
| Cheapest coarse cap (allows up to 2× across a boundary, by design) | `fixedWindow({ limit, windowMs })` |
| Near-exact rolling window at any limit, bounded memory | `slidingWindow({ limit, windowMs, buckets? })` |
| Exact "N in the last X" at low/moderate limits | `slidingWindowLog({ limit, windowMs })` |
| Shape/queue outbound calls to a fixed rate (delays, doesn't reject) | `leakyBucket({ ratePerSec, maxQueueMs })` |
| Protect a service from overload when the right rate is unknown | `adaptiveConcurrency({ ... })` |

- `gcra` — `burst` defaults to `limit`. Stores a single number (the theoretical arrival time).
- `slidingWindow` — `buckets` defaults to 10; error is bounded by ~1/buckets of the window. `buckets: 1` recovers the classic single-previous-window estimator.
- `slidingWindowLog` — exact, but O(limit) memory per key. Use for things like "5 password resets / hour".
- `leakyBucket` builds a `Shaper` (not a `Limiter`); see [leaky-bucket scheduling](#leaky-bucket-scheduling).
- `adaptiveConcurrency` builds a concurrency guard (not a `Limiter`); see [adaptive concurrency](#adaptive-concurrency).

Runnable versions of every section below live in [`examples/`](./examples).

---

## Express

```ts
import { expressRateLimit } from "throttlekit/express";
import { gcra } from "throttlekit";

app.use(
  expressRateLimit({
    strategy: gcra({ limit: 100, periodMs: 60_000, burst: 20 }),
    // Default key is a proxy-correct, IPv6-aggregated client IP (see Headers & security).
    key: (req) => req.headers["x-api-key"]?.toString() ?? req.ip ?? "anon",
    cost: (req) => (req.method === "POST" ? 5 : 1),
    fail: "open",            // allow if the store is unreachable ("open" | "closed")
    emit: { draft: true },   // emit IETF draft RateLimit headers (the default)
    onLimited: (req, _res, d) => console.warn("blocked", req.path, d.retryAfterMs),
  }),
);
```

On a denial the middleware responds `429` with `Retry-After`. Pass `handler` to fully own the `429` response, or `limiter` instead of `strategy` to share a prebuilt limiter. See [`examples/express.ts`](./examples/express.ts).

---

## Web / edge (`fetch`)

Runs on Cloudflare Workers, Deno, Bun, and Next.js edge. The default key tries `cf-connecting-ip`, then `x-forwarded-for` (resolved through the trusted-proxy policy), then `"anon"`.

```ts
import { withRateLimit } from "throttlekit/fetch";
import { gcra } from "throttlekit";

const handler = (req: Request): Response =>
  new Response(`hello ${new URL(req.url).pathname}`);

export default {
  fetch: withRateLimit(handler, {
    strategy: gcra({ limit: 30, periodMs: 10_000 }),
    emit: { draft: true },
  }),
};
```

On allow it forwards to your handler and copies the rate-limit headers onto the response; on deny it returns `429` with `Retry-After`. See [`examples/fetch-edge.ts`](./examples/fetch-edge.ts).

---

## More frameworks (Hono, Next.js, Fastify, Koa)

Every adapter shares the same options (`strategy`/`limiter`, `store`, `key`, `cost`, `fail`, `emit`, `onLimited`, `handler`, trusted-proxy config) and the same standards headers — only the binding differs. Each is its own subpath, so you pull in only the framework you use.

```ts
// Hono (edge-first) — throttlekit/hono
import { honoRateLimit } from "throttlekit/hono";
app.use("*", honoRateLimit({ strategy: gcra({ limit: 30, periodMs: 10_000 }) }));

// Fastify v5 — throttlekit/fastify
import { fastifyRateLimit } from "throttlekit/fastify";
fastify.addHook("onRequest", fastifyRateLimit({ strategy: gcra({ limit: 100, periodMs: 60_000 }) }));

// Koa v3 — throttlekit/koa
import { koaRateLimit } from "throttlekit/koa";
app.use(koaRateLimit({ strategy: gcra({ limit: 100, periodMs: 60_000 }) }));
```

**Next.js** middleware is dependency-free (no `next` import — `NextRequest`/`NextResponse` are Web `Request`/`Response`). Call the limiter, then branch:

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

For Next.js **route handlers** (`app/.../route.ts`), use `throttlekit/fetch` directly — they're Web `fetch` handlers.

---

## Distributed (Redis, atomic Lua)

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

Built-in strategies run their atomic Lua form in a single `EVALSHA` round trip (with an `EVAL` fallback on `NOSCRIPT`). Custom strategies without a Lua form fall back to optimistic concurrency (`WATCH`/`MULTI`/`EXEC`). `RedisStore` derives `now` from the Redis server clock by default, so node clock skew never corrupts shared state. See [`examples/redis-distributed.ts`](./examples/redis-distributed.ts).

### Any Redis client — including serverless / edge

`RedisStore` speaks the `ioredis` shape directly. For the official **node-redis** client, or the **Upstash REST** client (Cloudflare Workers, Vercel, Deno, Bun — anywhere a TCP socket isn't allowed), wrap it in the matching adapter:

```ts
import { RedisStore, fromNodeRedis, fromUpstash } from "throttlekit/redis";

// ioredis — pass it straight through
new RedisStore({ client: new Redis(process.env.REDIS_URL) });

// node-redis (the official `redis` client)
import { createClient } from "redis";
const node = createClient({ url: process.env.REDIS_URL });
await node.connect();
new RedisStore({ client: fromNodeRedis(node) });

// Upstash REST — serverless / edge, no TCP
import { Redis as Upstash } from "@upstash/redis";
new RedisStore({ client: fromUpstash(Upstash.fromEnv()) });
```

Every built-in strategy's atomic Lua runs **identically** across all three — proven bit-identical to the in-process path by the conformance suite (the ioredis and node-redis paths are tested against a live server). The Upstash REST API has no interactive `WATCH`/`MULTI`, so it supports the Lua-backed built-ins only; a custom non-Lua strategy needs `ioredis` or node-redis.

---

## Distributed (PostgreSQL — no Redis required)

Already running Postgres? You don't need to add Redis. `PostgresStore` is a fully distributed backend:

```ts
import { rateLimit, gcra } from "throttlekit";
import { PostgresStore } from "throttlekit/postgres";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PostgresStore({ pool, prefix: "api" }); // auto-creates its table on first use

const limiter = rateLimit({ strategy: gcra({ limit: 1000, periodMs: 60_000, burst: 100 }), store });
const d = await limiter.check(userId);
```

It runs the **same pure JS transform** the in-memory store runs — there is no Postgres-specific algorithm to keep in sync — inside a transaction serialized per key by a transaction-scoped **advisory lock** (`pg_advisory_xact_lock`, which serializes first-touch keys that `SELECT … FOR UPDATE` cannot lock). So concurrent checks are atomic: **N simultaneous checks at limit K admit exactly K**, proven against a live server, and decisions are bit-identical to the in-memory and Redis paths (state round-trips as JSON text). Expiry is keyed off the store's clock and reclaimed by a background sweep; because every built-in strategy is idempotent w.r.t. stale state, a slightly-late expiry can't change a decision. Pass a `pg.Pool` directly — no adapter. Each check is one transaction (a few round trips); for hot keys, use it as the L2 of `twoTier({ mode: "leased" })` to amortize the round trips, exactly as you would over Redis. See [`examples/postgres.ts`](./examples/postgres.ts).

---

## Two-tier (local + distributed, network-light)

Front the distributed store (L2) with a local in-process tier (L1) and choose the consistency/throughput trade-off:

```ts
import { twoTier, gcra } from "throttlekit";

const limiter = twoTier({
  strategy: gcra({ limit: 10_000, periodMs: 60_000, burst: 500 }),
  l2: store,          // a distributed store, e.g. RedisStore
  mode: "leased",     // "strict" | "cached-deny" | "leased"
  lease: { batch: 50, lowWater: 10 }, // lease 50 tokens at a time; refill near 10
});
```

| Mode | Network cost | Global accuracy | Best for |
|---|---|---|---|
| `strict` | 1 round trip / request | Exact | Hard quotas, billing |
| `cached-deny` | 1 round trip / *allowed* request | Exact for allows, local for denies | Public APIs under abuse |
| `leased` | ~1 round trip / `batch` requests | Within `L × batch` | High-throughput internal APIs |

`leased` requires `lease.batch`. With the default `lowWater: 0`, refill is purely lease-on-demand (tightest overshoot bound, ≤ `L × batch`); set `lowWater > 0` to hide lease latency at a looser bound. `twoTier` returns a `Limiter` whose `check` is async (`checkSync` throws — L2 is asynchronous). See [`examples/two-tier-leased.ts`](./examples/two-tier-leased.ts).

> **Formally verified.** The leased overshoot bound isn't just claimed — a [TLA⁺ spec](./spec/DistributedLeasing.tla) of the protocol is **model-checked with TLC** (the invariant `admitted ≤ Limit + N·(Batch−1)` holds across the full reachable state space, and a counterexample proves it's *exact*, not loose), and a Java-free [exhaustive checker](./test/twotier/leasing-model.test.ts) reproduces it in CI — independently finding the same state counts. Details in [`docs/FORMAL-MODEL.md`](./docs/FORMAL-MODEL.md).

### Multi-region

A global limit across regions is the leased model with the **regions as the leasing nodes** and one shared L2 (a global Redis/Postgres, or one region's store). Each region serves the bulk of its traffic from a local lease — region-local latency, no per-request cross-region hop — and the *same* formally-verified bound caps the **worldwide** overshoot:

```text
global admitted per window  ≤  Limit + regions × (batch − 1)
```

So 4 regions leasing `batch: 50` against a global `limit: 10_000` admit at most `10_000 + 4×49 = 10_196` worldwide — a < 2% overshoot for roughly one cross-region round trip per 50 requests. Smaller `batch` tightens the bound; larger `batch` cuts cross-region hops. Crucially there is **no separate multi-region engine to trust** — it's `twoTier` leased pointed at a shared store, and the bound is exactly the one proven in [`docs/FORMAL-MODEL.md`](./docs/FORMAL-MODEL.md). For a hard per-region cap with *zero* cross-region traffic, give each region its own limiter at `limit / regions` instead. See [`examples/multi-region.ts`](./examples/multi-region.ts).

---

## Multi-dimensional (one round trip)

Limit on several axes at once. `all({...})` allows only if **every** dimension allows and consumes nothing unless all allow (no partial-consume). `any({...})` allows if any dimension permits. Pass the result to **`multiRateLimit`** (not `rateLimit`):

```ts
import { all, gcra, fixedWindow, multiRateLimit } from "throttlekit";

interface Ctx { ip: string; userId: string; route: string }

const limiter = multiRateLimit<Ctx>({
  store, // on Redis, all dimensions are fused into one atomic Lua round trip
  strategy: all<Ctx>({
    ip:    { key: (c) => c.ip,     strategy: gcra({ limit: 100, periodMs: 60_000 }) },
    user:  { key: (c) => c.userId, strategy: gcra({ limit: 1000, periodMs: 60_000 }) },
    route: { key: (c) => c.route,  strategy: fixedWindow({ limit: 50, windowMs: 1_000 }) },
  }),
});

const d = await limiter.check({ ip, userId, route: "/search" });
```

The returned `Decision` reflects the binding constraint (the denying dimension, or the smallest `remaining` when allowed). Dimensions support per-dimension weighted costs via `cost: (ctx) => number`. On a Redis store, multi-dimensional checks support `gcra`, `tokenBucket`, and `fixedWindow` dimensions. See [`examples/multi-dimensional.ts`](./examples/multi-dimensional.ts).

---

## Adaptive concurrency

Not a rate — a dynamically inferred ceiling on *in-flight* requests, inferred from the latency gradient (`RTT_noload / RTT_actual`) and adjusted with a congestion-control sawtooth.

```ts
import { adaptiveConcurrency } from "throttlekit";

const guard = adaptiveConcurrency({ minLimit: 4, maxLimit: 512, algorithm: "gradient2" });

const lease = guard.acquire();
if (!lease.ok) {
  // Over the inferred ceiling — shed load (e.g. 503).
  return;
}
try {
  await handle(request);
} finally {
  lease.release();              // latency is measured automatically
  // lease.release({ dropped: true }); // for a failed/timed-out request (overload signal)
}
```

Introspect with `guard.limit`, `guard.inflight`, and `guard.stats()`. Algorithms: `"gradient2"` (default) or `"aimd"`. See [`examples/adaptive-concurrency.ts`](./examples/adaptive-concurrency.ts).

---

## Leaky-bucket scheduling

`leakyBucket` builds a `Shaper` that *delays* rather than rejects, smoothing bursty input to a steady output rate — ideal for pacing outbound calls to a third-party budget.

```ts
import { leakyBucket, QueueFullError } from "throttlekit";

const shaper = leakyBucket({ ratePerSec: 5, maxQueueMs: 2_000 });

try {
  await shaper.schedule("upstream-api"); // resolves after the paced delay
  await callUpstream();
} catch (err) {
  if (err instanceof QueueFullError) {
    // The wait would exceed maxQueueMs; shed instead of queuing forever.
    console.warn("queue full, retry in", err.retryAfterMs, "ms");
  }
}
```

`reserve(key, cost?)` returns a `Reservation` (`{ accepted, delayMs }`) without sleeping; `schedule(key, cost?)` waits the paced delay or throws `QueueFullError`. `reserveSync` is available with a synchronous store. See [`examples/leaky-bucket.ts`](./examples/leaky-bucket.ts).

---

## Huge cardinality / DDoS (`sketchRateLimit`)

The per-key stores keep one record per active key — which, under a flood of *millions of distinct* keys (every source IP in a volumetric attack), makes that per-key state itself the memory-exhaustion vector. `sketchRateLimit` limits an **unbounded key universe in fixed memory** using a Count-Min Sketch: ~**7.4 KB total**, regardless of how many keys it sees.

```ts
import { sketchRateLimit } from "throttlekit";

const shield = sketchRateLimit({ limit: 100, windowMs: 60_000 }); // ε=0.01, δ=0.001 by default

const d = shield.checkSync(clientIp); // sync or async (check)
if (!d.allowed) return reject(429);
```

The guarantee: because the sketch never *under*counts, **`allowed` implies the true admitted count is ≤ `limit` — it never over-admits** (a hard, non-probabilistic property). Its only error is the safe direction — it may deny a key slightly early once hash collisions inflate its estimate, bounded by `ε·N` with probability `≥ 1−δ` ([Cormode & Muthukrishnan 2005](http://dimacs.rutgers.edu/~graham/pubs/papers/cmencyc.pdf); conservative-update from Estan & Varghese). Over-denying rather than over-admitting is exactly the right bias for abuse protection. Tune the memory/accuracy trade with `epsilon`/`delta`.

**Cluster-wide (`mergeableSketch`).** A low-and-slow distributed attacker can stay under every single node's threshold while flooding the fleet. Because Count-Min counters are linear, each node can keep its own fixed-memory sketch, ship it as compact bytes (`snapshot()` / `toBytes()`), and `merge()` peers' sketches — the sum is *exactly* the sketch of the whole cluster's traffic, so the global heavy hitter becomes visible everywhere. Honestly scoped: this is eventually-consistent **detection** (each node acts on its latest merged view), not a strongly-consistent global limit — for that use a Redis/Postgres store or `twoTier`. See [`examples/distributed-sketch.ts`](./examples/distributed-sketch.ts).

---

## Overload & fairness (`adaptiveThrottle`, `fairShare`)

Two admission-control primitives that sit *upstream* of the per-key limiters.

**`adaptiveThrottle`** — Google-SRE [client-side adaptive throttling](https://sre.google/sre-book/handling-overload/). A client that keeps hammering an overloaded backend only deepens the overload; this sheds a growing fraction of requests *locally* based on the backend's recent accept rate, so callers back off automatically:

```ts
import { adaptiveThrottle } from "throttlekit";

const throttle = adaptiveThrottle({ k: 2 }); // shed once sending > 2× what the backend accepts
if (!throttle.request()) return failFast();   // shed locally, don't even try
try { const res = await callBackend(); throttle.record(res.ok); }
catch { throttle.record(false); }            // feed outcomes back so it self-corrects
```

`p = max(0, (requests − K·accepts) / (requests + 1))` over a smooth rolling window; `request(priority)` protects critical traffic (`priority: 1` is never shed).

**`fairShare`** — split one global per-window budget across tenants so a greedy tenant can't starve the others (each active tenant is guaranteed ≥ `limit/N`, and the global total never exceeds `limit`):

```ts
import { fairShare } from "throttlekit";
const fair = fairShare({ limit: 1000, windowMs: 60_000 });
const d = fair.checkSync(tenantId); // d.limit is this tenant's current fair cap
```

It's an honest *online equal-share approximation*, not work-conserving max-min — the [reference docs](./src/admission/index.ts) spell out exactly what it does and doesn't guarantee.

---

## Determinism with `ManualClock`

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

`ManualClock` exposes `.advance(ms)`, `.set(ms)`, and `.now()`. See [`examples/basic-memory.ts`](./examples/basic-memory.ts).

---

## Headers & security

### Standards-compliant headers

`buildRateLimitHeaders(decision, opts)` produces a plain `Record<string, string>` you can set on any response; the adapters call it for you. Three families, selectable via `emit`:

- **`draft`** *(default)* — the IETF triple `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` (reset is delta-seconds).
- **`structured`** — the RFC 9651 structured `RateLimit` + `RateLimit-Policy` fields.
- **`legacy`** — the `X-RateLimit-*` triple (reset is epoch-seconds).

On a denial a `Retry-After` header (delta-seconds, rounded up, min 1) is always added. All time math derives from the injected `now`, so output is deterministic in tests.

```ts
import { buildRateLimitHeaders } from "throttlekit";

const headers = buildRateLimitHeaders(decision, {
  now: Date.now(),
  policyName: "api",
  windowSeconds: 60,
  emit: { draft: true, legacy: true },
});
```

### Trusted proxy & IPv6 aggregation

Trusting `X-Forwarded-For` blindly is the classic rate-limit bypass. `clientIp` refuses to do that: the default is `trustProxy: false` (use the socket peer), and trust is opt-in as a hop count or a CIDR/IP allowlist. It also aggregates IPv6 to a configurable prefix (`/64` by default), so one customer can't rotate through billions of addresses.

```ts
import { clientIp } from "throttlekit";

const key = clientIp(
  { remoteAddr: req.socket.remoteAddress ?? "", xForwardedFor: req.headers["x-forwarded-for"] },
  { trustProxy: ["10.0.0.0/8"], ipv6Prefix: 64 }, // or trustProxy: 1 for a single hop
);
```

The Express and `fetch` adapters accept `trustProxy` and `ipv6Prefix` directly and derive this key by default.

### PII-safe keys (HMAC)

Hash raw identifiers with a server secret before they reach the store, so a shared Redis never holds the raw value:

```ts
import { hmacKeyer, hashKey } from "throttlekit";

const keyer = hmacKeyer(process.env.RL_SECRET ?? "");
await limiter.check(keyer(rawUserId)); // or: hashKey(rawUserId, secret)
```

---

## Observability

Every `Decision` is a plain object suitable for logging. For metrics, the optional OpenTelemetry layer (`throttlekit/otel`) wraps a limiter or guard with your own configured `Meter`:

```ts
import { instrumentLimiter, instrumentGuard } from "throttlekit/otel";
import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("my-service");
const observed = instrumentLimiter(limiter, meter); // throttlekit.checks / .remaining / .store.latency
instrumentGuard(guard, meter);                       // concurrency.limit / .inflight / .rtt_noload
```

`instrumentLimiter` returns a drop-in `Limiter`; `instrumentGuard` returns the same guard with observable gauges attached. The adapters also expose `onLimited` and `onError` hooks for custom sinks.

For zero-config insight without a metrics backend, wrap a limiter with **`withAnalytics`** — it tracks allow/deny counts and the **top-K "heavy hitters"** (the keys driving the most traffic and the most denials) in bounded memory:

```ts
import { withAnalytics, rateLimit, gcra } from "throttlekit";

const limiter = withAnalytics(rateLimit({ strategy: gcra({ limit: 100, periodMs: 60_000 }) }));
await limiter.check(clientIp); // use exactly like any limiter

const a = limiter.analytics();
// { allowed, denied, total, denyRate, topRequested: [{ key, count }], topDenied: [...] }
```

Top-K uses **Space-Saving** (Metwally et al. 2005): at most `topK` entries are tracked no matter how many distinct keys appear, so it surfaces your worst offenders even under a flood of unique keys without unbounded memory. Drop-in (`check`/`checkSync`/`reset` pass through); window resets each `windowMs`.

---

## Resilience (what happens when Redis is down)

The in-process `MemoryStore` never fails. A distributed store can: if Redis is unreachable, `limiter.check()` rejects (`StoreUnavailableError`). **You decide what that means** — every adapter takes a `fail` policy and fires an `onError` hook before applying it:

| `fail` | On a store outage | Use when |
|---|---|---|
| `"open"` *(default)* | Allow the request (the limiter gets out of the way) | Availability matters more than the cap — most public APIs |
| `"closed"` | Reject with `503 { error: "rate limiter unavailable" }` | The cap is a hard guarantee — billing, abuse-critical paths |

```ts
expressRateLimit({
  strategy: gcra({ limit: 100, periodMs: 60_000 }),
  store: redisStore,
  fail: "closed",                       // deny if the limiter can't be consulted
  onError: (_req, _res, err) => log.warn({ err }, "rate limiter store down"),
});
```

Two extra hedges against transient outages: **`twoTier` in `leased` mode** keeps serving from the local lease while L2 is briefly unreachable, and the Redis path uses a single atomic round trip (no read-then-write window to be interrupted). Fail-open and fail-closed are covered by tests on every adapter.

---

## Performance

In-process, single hot key (Node 24, reproducible via `npm run bench`):

- **`checkSync` (GCRA): ~3.2M ops/s, ~316 ns/op, allocation-free.**
- `check` (async, GCRA): **~1.6M ops/s** (~600 ns/op).
- Redis: exactly **one** `EVALSHA` round trip per check.

Head-to-head (`npm run bench:compare`, same machine/process/warmup, allow path) vs the closest incumbents: ThrottleKit **owns the sync path** — no other library offers a synchronous API, and ours is allocation-free — and **ties `rate-limiter-flexible` on Redis** (both one atomic Lua round trip, ~640 ops/s loopback). On async in-memory throughput the counter-based libraries are faster per call (`rate-limiter-flexible` ~2.9M, `express-rate-limit` ~4.2M) than ThrottleKit's GCRA (~1.7M) — the trade for a smoother algorithm over a bounded-memory store; all are in the millions/sec. Full table, methodology, and caveats in [SCOREBOARD.md](./SCOREBOARD.md).

---

## Migrating

**From `express-rate-limit`:**

```ts
// before
import rateLimit from "express-rate-limit";
app.use(rateLimit({ windowMs: 60_000, limit: 100 }));

// after — GCRA by default (smooth pacing, no 2× boundary burst), same standards headers
import { expressRateLimit } from "throttlekit/express";
import { gcra } from "throttlekit";
app.use(expressRateLimit({ strategy: gcra({ limit: 100, periodMs: 60_000 }) }));
// want the classic window instead? swap in fixedWindow({ limit: 100, windowMs: 60_000 })
```

**From `rate-limiter-flexible`:**

```ts
// before — throws on exhaustion
const rl = new RateLimiterRedis({ storeClient: redis, points: 100, duration: 60 });
try { await rl.consume(key); } catch { /* respond 429 */ }

// after — one atomic Lua round trip, a Decision object instead of throw-on-deny
import { rateLimit, gcra } from "throttlekit";
import { RedisStore } from "throttlekit/redis";
const limiter = rateLimit({
  strategy: gcra({ limit: 100, periodMs: 60_000 }),
  store: new RedisStore({ client: redis }),
});
const d = await limiter.check(key);
if (!d.allowed) { /* respond 429 with d.retryAfterMs */ }
```

---

## Recipes

**Tiered plans (free / pro) by API key** — one store, namespaced per tier:

```ts
const limiters = {
  free: rateLimit({ strategy: gcra({ limit: 60, periodMs: 60_000 }), store, prefix: "free" }),
  pro: rateLimit({ strategy: gcra({ limit: 1_000, periodMs: 60_000 }), store, prefix: "pro" }),
};
const d = await limiters[planFor(req)].check(apiKeyOf(req));
```

**Cost-weighted endpoints** — charge expensive routes more from the same budget:

```ts
await limiter.check(apiKeyOf(req), routeIsExpensive(req) ? 5 : 1); // `cost` second arg
```

**Per-IP *and* per-route in one round trip** — see [Multi-dimensional](#multi-dimensional-one-round-trip) (`all({ ip, route })`). **Tiered burst + sustained** — compose two GCRA limiters (e.g. 10/sec *and* 1000/hour) and allow only if both pass.

---

## How it's tested

ThrottleKit is engineered to be *provably* correct:

- **Dual-path conformance** — thousands of generated `(arrivals, costs, clock)` timelines run through both the JS and Lua path of each strategy; the two must produce identical decision streams.
- **Property tests** — invariants like "`remaining` never negative", "never allow above limit + documented overshoot", and "leased overshoot ≤ L × B" under randomized inputs.
- **Atomicity** — fire N simultaneous checks at a limit of K and assert **exactly K** are allowed, for the MemoryStore and (env-gated) a real Redis.
- **Store conformance kit** — `runStoreConformance` from `throttlekit/testkit` runs any custom store through the same atomicity / TTL / concurrency suite the built-ins pass.

All time-dependent tests use `ManualClock`, so the suite is deterministic.

---

## License

MIT
