# throttlekit-server

**Beyond rate limiting — over the wire.** The **gRPC service door** for
[ThrottleKit](https://www.npmjs.com/package/throttlekit): run the proven core that governs **rate,
concurrency, and cost** — its **GALE** (*Globally-Accounted Learned Escrow*) and **TALE** (*Temporally-Accounted Learned Escrow*)
engines — as a network service so **polyglot clients** (Python, Go, …) get decisions **identical** to an
embedded Node library, without re-implementing any algorithm or touching the raw Lua wire.

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

…or back the fleet with **Postgres** instead — no Redis required, the same shared-store guarantee, and
decisions stay bit-identical (the core's pure transform runs inside the store, server-side):

```bash
throttlekit-server --config .throttlekit.yaml --postgres-url postgres://user:pass@db:5432/app
```

…or **DynamoDB** (`--dynamodb-create-table` provisions the single-`pk` table on first run):

```bash
throttlekit-server --config .throttlekit.yaml \
  --store dynamodb --dynamodb-table throttlekit --dynamodb-create-table
```

## Backing stores

The server can host any of the core's **exact** rate stores. The decision always runs in the core, so
every backend yields bit-identical decisions — the store only transports state. Select one with `--store`,
or let it infer from which URL flag you pass:

| Store | How | Notes |
|---|---|---|
| **Memory** | default (no flag) | per-policy, in-process — single instance only |
| **Redis** | `--redis <url>` | shared fleet store; one atomic Lua round trip |
| **Postgres** | `--postgres-url <url>` | shared fleet store, **no Redis required**; per-key advisory-lock atomicity |
| **DynamoDB** | `--store dynamodb --dynamodb-table <t>` | shared fleet store, **no Redis required**; version-CAS atomicity + native TTL |

> **DenoKV** and **Cloudflare** (D1 / Durable Objects / Workers KV) are *edge-runtime* stores — they bind
> to APIs that don't exist in Node, so they can't back a Node `throttlekit-server`. Reach them by running
> ThrottleKit *inside* those runtimes, not through this service door.

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

## Watch it live — the terminal dashboard

`throttlekit-server --config x.yaml --tui` opens a built-in, **zero-dependency** live dashboard right in
your terminal, alongside gRPC — no browser, no metrics backend:

```bash
throttlekit-server --config .throttlekit.yaml --tui
#  → gRPC on :50051  +  a live dashboard (q quit · 1-5/Tab switch views · ↑↓ scroll · p pause)
```

It taps every limiter and unified admitter into an in-process hub (synchronous, exception-swallowing, O(1)
— the gRPC decisions are byte-for-byte unchanged) and renders the full ops board plus **live binding-axis
attribution**: for a unified policy, *which* of rate / concurrency / cost (or the joint-LP `policy` lane) is
throttling each key right now. It works for **every** policy — a plain `gcra` limiter gets the board and the
"why throttled" attribution by policy + key; the axis lane lights up for unified admitters.

The dashboard is organized into **five views** — press `1`–`5` or `Tab` / `Shift-Tab` to switch:
**Overview**, **Latency** (avg / p50 / p99 / max admit-path latency), **Capacity** (per-key spendable +
refill ETA), **Fairness** (per-tenant weighted-fair-escrow share), and **Guarantee** (concurrency headroom
to each guard's enforced ceiling + self-fence status). Fairness lights up for a `fairEscrow` policy (served
by `check`, the key being the tenant); Guarantee lights up for any `concurrency` policy (the admitter's
guard is surfaced to the dashboard).

A TUI owns the terminal, so it is **opt-in** and needs an interactive TTY (a non-TTY warns and serves
without it). For **headless / production** monitoring, emit OpenTelemetry → Grafana instead — including the
`throttlekit.denies_by_axis{lane}` counter. See the
[Monitoring](https://github.com/AmeyaBorkar/throttlekit/wiki/Monitoring-and-the-Lens) guide.

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
| `--store <backend>` | pick the backend explicitly: `memory` \| `redis` \| `postgres` \| `dynamodb` (inferred from the URL flags if omitted) |
| `--redis <url>` | share one Redis store across instances (one fleet-wide limit); omit for in-process memory |
| `--redis-prefix <p>` | key prefix for the shared Redis store |
| `--postgres-url <url>` | back the fleet with a shared **Postgres** store (no Redis required) |
| `--postgres-table <t>` | table holding limiter state (default `throttlekit`) |
| `--postgres-prefix <p>` | key prefix for the shared Postgres store |
| `--dynamodb-table <t>` | back the fleet with a **DynamoDB** table (implies `--store dynamodb`; no Redis required) |
| `--dynamodb-region <r>` / `--dynamodb-endpoint <url>` | AWS region / endpoint override (e.g. `http://localhost:8000` for dynamodb-local) |
| `--dynamodb-prefix <p>` | key prefix for the shared DynamoDB store |
| `--dynamodb-create-table` | create the single-`pk` table if absent, then wait for it (dev convenience) |
| `--tls-cert` + `--tls-key` | serve **TLS** |
| `--tls-ca <ca>` | require + verify client certs ⇒ **mTLS** |
| `--fail open\|closed` | store-outage policy (default `open`) |
| `--tui` | live **terminal dashboard** alongside gRPC (interactive TTY only; `q` to quit); see [Watch it live](#watch-it-live--the-terminal-dashboard) |

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
| **Store (Redis/Postgres/DynamoDB) outage** | resolved by `--fail`: `open` admits, `closed` denies (a synthesized `Decision`) |
| **Service unreachable** (transport) | the *client's* call to make — fail-open or fail-closed in your code; a returned `Decision` is always authoritative |

## Security

The default credentials are **insecure** (loopback/dev only). Front anything exposed with **TLS/mTLS**
(flags above, or pass `grpc.ServerCredentials` to `serve({ credentials })`) so nothing can poison a
shared budget. The server warns on startup if it binds a non-loopback host without TLS.
