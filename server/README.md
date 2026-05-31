# throttlekit-server

The **gRPC service door** for [ThrottleKit](https://www.npmjs.com/package/throttlekit). Run the
rate-limiting core as a network service so **polyglot clients** (Python, Go, …) get decisions
**identical** to an embedded Node library — without re-implementing any algorithm or touching the raw Lua
wire.

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

> This first cut uses an in-process **memory** store (one per policy) — correct for a single instance. A
> distributed fleet shares one Redis/Postgres store across instances; wire it programmatically (below)
> until the `--redis` flag lands.

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
`Check` / `CheckMany` / `Peek` / `Forecast`). It is conformance-tested end-to-end against the same
[golden vectors](../wire/) the wire contract is built from: a live in-process server + client replays
every suite and must reproduce the oracle's decisions field-for-field (`test/`).

## Security

The default credentials are **insecure** (loopback/dev). Front anything exposed with **mTLS or TLS** —
pass `grpc.ServerCredentials` via `serve({ credentials })` — so nothing can poison a shared budget.
