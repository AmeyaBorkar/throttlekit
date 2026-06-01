# throttlekit-server

**The rate limiter you can prove — over the wire.** The **gRPC service door** for
[ThrottleKit](https://www.npmjs.com/package/throttlekit): run the proven rate-limiting core — including the
**GALE** (distributed leasing) and **TALE** (LLM token-budget) engines — as a network service so **polyglot
clients** (Python, Go, …) get decisions **identical** to an embedded Node library, without re-implementing
any algorithm or touching the raw Lua wire.

> **Status: experimental (pre-1.0).** The core `throttlekit` package is 1.0 and frozen; this server
> evolves independently. It depends only on `throttlekit`'s **public, frozen API** — it adds no surface
> to the core and keeps the core's zero-runtime-dependency promise intact.

## Why a service (not a port)

The whole ThrottleKit design rests on one invariant: **exactly one thing computes a `Decision`** — the
Node core, directly or as Lua-in-Redis. The service exposes that core over gRPC, so a client is a trivial
RPC stub instead of a second rate-limiter to keep in sync. A rate-limit *denial* is a normal `Decision`
(`allowed: false`), never an RPC error; errors are reserved for operational faults (unknown policy →
`NOT_FOUND`, unsupported op → `UNIMPLEMENTED`).

This is the door we lead with for non-Node languages: the in-process ~169 ns number doesn't transfer to
CPython, so the network-bound service is where the value is.

## Run it

```bash
throttlekit-server --config .throttlekit.yaml --port 50051
```

```yaml
# .throttlekit.yaml
version: 1
limiters:
  api:     { strategy: gcra,        limit: 100, period: 1m, burst: 20 }
  uploads: { strategy: fixedWindow, limit: 10,  period: 1h }
```

A client sends `Check { policy: "api", key: apiKey, cost: 1 }` and reads back a `Decision`.

By default each policy uses an in-process **memory** store (correct for a single instance). Point every
instance at the **same Redis** to run a coordinated fleet enforcing one shared limit:

```bash
throttlekit-server --config .throttlekit.yaml --redis redis://redis:6379
```

## Two-tier leasing (cut the per-request round trip)

A policy can carry a `twoTier` block to be served as a **two-tier leased** limiter: each instance leases a
batch of tokens from the shared L2 (Redis) and then admits locally until the batch runs low — trading one
Redis round trip per `batch` requests for a bounded, self-healing overshoot (`≤ fleet × (batch − 1)` per
window, or **exactly the limit** with `windowCoupled`). The client reaches it with a **plain `check`** —
no new RPC, the core still computes every decision.

```yaml
version: 1
limiters:
  leased-api:
    strategy: gcra          # the same algorithm/fields as a plain policy, enforced at L2
    limit: 1000
    period: 1m
    twoTier:                # ← a nested *block* (the config parser does not accept nested flow `{…}`)
      mode: leased          # strict | cached-deny | leased
      batch: 50             # tokens leased from L2 per refill
      windowCoupled: true   # tie credit lifetime to the L2 window ⇒ per-window overshoot = limit
```

Without `--redis` a `twoTier` policy falls back to a private in-process L2 (single-instance, same as a
plain policy); point the fleet at one Redis to share the budget. `peek`/`forecast` aren't offered on a
leased policy (it is consume-only) — they return `UNIMPLEMENTED`.

## Token budgets (the cost axis)

For post-hoc costs you only learn *after* a request runs — the LLM-gateway problem, where a completion's
token count isn't known until it streams — a policy can be a `tokenBudget` meter, served via the `Debit`
RPC. The client **debits** the actual tokens as they are produced; a debit is admitted while budget
remains, and the meter stops on the token that crosses the limit (per-token debiting overshoots by 0).

```yaml
version: 1
limiters:
  completions:
    tokenBudget:        # ← a block, not a strategy: this policy is a meter, served via Debit
      budget: 100000    # tokens per window, per key
      windowMs: 60000
```

A client calls `Debit { policy: "completions", key: tenant, tokens: n }` per chunk. The service keeps one
meter per key (bounded by `maxKeys`, default 100k). It is **single-instance** today (the core primitive is
per-gateway; a fleet-shared budget is a planned enhancement). `check` on a token-budget policy — and
`debit` on a rate limiter — return `UNIMPLEMENTED`.

## Concurrency & unified admission (the in-flight axis)

For limiting *concurrent* work — not a rate, but how many requests are in flight at once — a policy can
carry a `concurrency` block. It is served by a stateful lifecycle: **`Admit`** takes a slot, **`Release`**
returns it, **`Heartbeat`** renews long holds. The ceiling is the core's adaptive `adaptiveConcurrency`
(it grows while latency stays low and contracts under load); pin it with `minLimit === maxLimit` for a
fixed cap. Add a `strategy` alongside and the policy becomes a **unified** rate × concurrency admitter —
the core composes the axes and reports which one bound a denial.

```yaml
version: 1
limiters:
  checkout:                 # concurrency-only: at most `maxLimit` requests in flight
    concurrency: { minLimit: 4, maxLimit: 200 }
  api:                      # unified: rate (gcra) AND concurrency, whichever binds first
    strategy: gcra
    limit: 1000
    period: 1m
    burst: 100
    concurrency: { maxLimit: 64 }
```

A granted `Admit` returns a `lease_id` the caller **must** `Release` when the work finishes (pass
`dropped: true` on a timeout/error so the adaptive limit contracts). If a client crashes without
releasing, the server reclaims the slot once the lease TTL (default 2s) lapses without a heartbeat —
the same crash-safety contract the core uses node↔coordinator, one layer out. `check`/`debit` on an
admitter (and `admit` on a rate limiter / meter) return `UNIMPLEMENTED`. Single-instance today (each
server is the concurrency authority for its own clients); a fleet-coordinated ceiling via the core's
`distributedAdaptiveConcurrency` is the planned next step, reachable by the **same** client lifecycle.

## Embed it (Node)

```ts
import { readFileSync } from "node:fs";
import { createRateLimiterServiceFromConfig, serve } from "throttlekit-server";
import { RedisStore } from "throttlekit/redis";

const service = createRateLimiterServiceFromConfig(readFileSync(".throttlekit.yaml", "utf8"), {
  store: new RedisStore({ client }), // shared across the fleet
  fail: "closed",
});
const running = await serve({ service, port: 50051 });
// … on shutdown
await running.close();
```

## The contract

The service answers [`throttlekit.proto`](../wire/throttlekit.proto) (`throttlekit.v1.RateLimiter`:
`Check` / `CheckMany` / `Peek` / `Forecast` for rate, `Debit` for the cost axis, and the stateful
`Admit` / `Release` / `Heartbeat` lifecycle for concurrency / unified admission). It is conformance-tested
end-to-end against the same [golden vectors](../wire/) the wire contract is built from: a live in-process
server + client replays every suite and must reproduce the oracle's decisions field-for-field (`test/`),
and the admission lifecycle is driven over real gRPC (admit / release / heartbeat / crash-reclaim).

## Clients

[`throttlekit-py`](https://github.com/AmeyaBorkar/throttlekit-py) is the reference client — point its
`ServiceBackend` at this server. (It also ships a direct `RedisBackend` that runs the same vendored Lua
straight against Redis, for when you'd rather skip the hop — proven bit-for-bit against the same golden
vectors.) Any language with gRPC can be a client: load `throttlekit.proto` and call `RateLimiter`.

## Deploy

```bash
# fleet mode (shared Redis) + mTLS
throttlekit-server --config .throttlekit.yaml \
  --redis redis://redis:6379 --redis-prefix prod \
  --tls-cert server.crt --tls-key server.key --tls-ca client-ca.crt \
  --fail closed
```

| Flag | Effect |
|---|---|
| `--redis <url>` | share one Redis store across instances (one fleet-wide limit); omit for in-process memory |
| `--redis-prefix <p>` | key prefix for the shared store |
| `--tls-cert` + `--tls-key` | serve **TLS** |
| `--tls-ca <ca>` | require + verify client certs ⇒ **mTLS** |
| `--fail open\|closed` | store-outage policy (default `open`) |

**Container** (build from the repo root so the single-source proto in `wire/` is bundled):

```bash
docker build -f server/Dockerfile -t throttlekit-server .
docker run -p 50051:50051 -v "$PWD/.throttlekit.yaml:/etc/tk.yaml" \
  throttlekit-server --config /etc/tk.yaml --redis redis://host.docker.internal:6379
```

## Failure modes

| Condition | Behavior |
|---|---|
| Rate limit hit | a normal `Decision` with `allowed:false` + `retryAfterMs` — **not** an RPC error |
| Unknown policy | gRPC `NOT_FOUND` |
| Op unsupported by the strategy (`peek`/`forecast`) | gRPC `UNIMPLEMENTED` |
| **Store (Redis) outage** | resolved by `--fail`: `open` admits, `closed` denies (a synthesized `Decision`) |
| **Service unreachable** (transport) | the *client's* call to make — fail-open or fail-closed in your code; a returned `Decision` is always authoritative |

## Security

The default credentials are **insecure** (loopback/dev only). Front anything exposed with **TLS/mTLS**
(flags above, or pass `grpc.ServerCredentials` to `serve({ credentials })`) so nothing can poison a
shared budget. The server warns on startup if it binds a non-loopback host without TLS.
