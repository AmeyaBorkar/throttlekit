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
| [`two-tier-leased.ts`](./two-tier-leased.ts) | Two-tier L1/L2 with token leasing |
| [`multi-dimensional.ts`](./multi-dimensional.ts) | Per-IP ∧ per-user ∧ per-route in one round trip |
| [`adaptive-concurrency.ts`](./adaptive-concurrency.ts) | Latency-gradient backpressure |
| [`leaky-bucket.ts`](./leaky-bucket.ts) | Outbound traffic shaping (`schedule` / `reserve`) |

The Redis example needs a reachable Redis (`REDIS_URL`); the rest run standalone. In your own
project, replace the `../src/...` imports with `throttlekit`, `throttlekit/redis`,
`throttlekit/express`, and `throttlekit/fetch`.
