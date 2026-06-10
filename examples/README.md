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
| [`multi-region.ts`](./multi-region.ts) | Global budget across regions (leased mode, shared L2, proven overshoot bound) |
| [`federation.ts`](./federation.ts) | Cross-region federation over Redis — a `GlobalCoordinator` pools one global budget with the K-independent overshoot bound |
| [`federation-postgres.ts`](./federation-postgres.ts) | The same federation, coordinated by a `PostgresCoordinator` (no Redis required) |
| [`federation-regional-escrow.ts`](./federation-regional-escrow.ts) | Multi-process-per-region federation with a shared regional escrow + the `regional-only` coordinator-outage mode |
| [`multi-dimensional.ts`](./multi-dimensional.ts) | Per-IP ∧ per-user ∧ per-route in one round trip |
| [`adaptive-concurrency.ts`](./adaptive-concurrency.ts) | Latency-gradient backpressure |
| [`leaky-bucket.ts`](./leaky-bucket.ts) | Outbound traffic shaping (`schedule` / `reserve`) |
| [`sketch-ddos.ts`](./sketch-ddos.ts) | Fixed-memory limiting over an unbounded key universe (Count-Min Sketch) |
| [`distributed-sketch.ts`](./distributed-sketch.ts) | Cluster-wide heavy-hitter detection by merging per-node sketches |
| [`analytics.ts`](./analytics.ts) | In-process allow/deny stats + top-K heavy hitters (`withAnalytics`) |
| [`admission-control.ts`](./admission-control.ts) | Client-side adaptive shedding + fair cross-tenant budget split |
| [`joint-lp-admission.ts`](./joint-lp-admission.ts) | Bid-price admission policy — steer a cost-bound budget to high-value requests |
| [`unified.ts`](./unified.ts) | Unified admission — rate ⊕ concurrency ⊕ cost in one `Decision`, with binding-axis attribution |
| [`distributed-concurrency.ts`](./distributed-concurrency.ts) | A fleet under one cooperatively-inferred global concurrency ceiling (`distributedAdaptiveConcurrency`) |
| [`weighted-fair-escrow.ts`](./weighted-fair-escrow.ts) | Multi-tenant work-conserving budget split by weight (`weightedFairEscrow`, LLM-gateway TPM) |
| [`federated-weighted-fair-escrow.ts`](./federated-weighted-fair-escrow.ts) | Weighted fair escrow lifted across regions into a global weighted-max-min split |
| [`adaptive-lease-sizing.ts`](./adaptive-lease-sizing.ts) | Online lease-batch sizing for `twoTier` leased mode (EOQ optimum), safety decoupled from the size |
| [`hono.ts`](./hono.ts) | Hono v4 middleware, run via `app.fetch` (no server) |

The Redis example needs a reachable Redis (`REDIS_URL`) and the Postgres example a reachable Postgres
(`DATABASE_URL`); the rest run standalone. In your own project, replace the `../src/...` imports with
the package entry points: `throttlekit` (core, `sketchRateLimit`, `mergeableSketch`, `withAnalytics`,
`adaptiveThrottle`, `fairShare`), `throttlekit/redis`, `throttlekit/postgres`, `throttlekit/express`,
`throttlekit/fetch`, and `throttlekit/hono` (plus `/next`, `/fastify`, `/koa`).

**Monitoring:** run [`throttlekit-server`](../server) with `--tui` for **ThrottleKit Lens** — a built-in,
zero-dependency live **terminal dashboard** (live binding-axis attribution + the full ops board across 8 tabs,
no browser or backend) — see the
[Monitoring](https://github.com/AmeyaBorkar/throttlekit/wiki/Monitoring-and-the-Lens) guide. For a programmable /
remote read API, the server also exposes the **Monitor door** (read-only `throttlekit.v1.Monitor` gRPC +
Prometheus `/metrics`). For headless / production, emit OpenTelemetry → Grafana.
