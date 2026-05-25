# Examples

Runnable, type-checked examples for each part of ThrottleKit. They import from the repo source
(`../src/...`), so from the repo root you can run any of them with [`tsx`](https://tsx.is):

```sh
npx tsx examples/basic-memory.ts
```

| File | Shows |
|---|---|
| [`basic-memory.ts`](./basic-memory.ts) | In-memory GCRA, the `Decision` shape, `checkSync`, `ManualClock` determinism |
| [`express.ts`](./express.ts) | Express middleware with proxy-correct keys and headers |
| [`fetch-edge.ts`](./fetch-edge.ts) | Web `fetch` adapter (Cloudflare Workers / Deno / Bun / edge) |
| [`redis-distributed.ts`](./redis-distributed.ts) | Distributed limiting over Redis (atomic Lua) |
| [`postgres.ts`](./postgres.ts) | Distributed limiting over PostgreSQL (no Redis; advisory-lock atomic RMW) |
| [`two-tier-leased.ts`](./two-tier-leased.ts) | Two-tier L1/L2 with token leasing |
| [`multi-dimensional.ts`](./multi-dimensional.ts) | Per-IP ∧ per-user ∧ per-route in one round trip |
| [`adaptive-concurrency.ts`](./adaptive-concurrency.ts) | Latency-gradient backpressure |
| [`leaky-bucket.ts`](./leaky-bucket.ts) | Outbound traffic shaping (`schedule` / `reserve`) |
| [`sketch-ddos.ts`](./sketch-ddos.ts) | Fixed-memory limiting over an unbounded key universe (Count-Min Sketch) |
| [`analytics.ts`](./analytics.ts) | In-process allow/deny stats + top-K heavy hitters (`withAnalytics`) |
| [`admission-control.ts`](./admission-control.ts) | Client-side adaptive shedding + fair cross-tenant budget split |
| [`hono.ts`](./hono.ts) | Hono v4 middleware, run via `app.fetch` (no server) |

The Redis example needs a reachable Redis (`REDIS_URL`) and the Postgres example a reachable Postgres
(`DATABASE_URL`); the rest run standalone. In your own project, replace the `../src/...` imports with
the package entry points: `throttlekit` (core, `sketchRateLimit`, `withAnalytics`, `adaptiveThrottle`,
`fairShare`), `throttlekit/redis`, `throttlekit/postgres`, `throttlekit/express`, `throttlekit/fetch`,
and `throttlekit/hono` (plus `/next`, `/fastify`, `/koa`).
