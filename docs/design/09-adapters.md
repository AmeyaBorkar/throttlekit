# 09 · Adapters & the request lifecycle

> One enforcement core, many transport bindings — and the exactly-once `release()` lifecycle that keeps
> concurrency accounting honest across every framework. Source: `src/adapters/`.

## Purpose

Every adapter does the same four things — resolve a `Limiter`, pick a clock for header math, build
standards headers, apply a fail policy — and only the mapping of a framework's request/response onto those
calls differs. That shared core lives once; each adapter is thin glue. A second concern runs through the
stateful adapters: a `unifiedAdmission`/`adaptiveConcurrency` slot must be released **exactly once** when
the request ends, or the in-flight count corrupts.

## The shared contract

`CommonAdapterOptions` (`src/adapters/core.ts:19`), shared by every HTTP adapter:

- `fail: "open" | "closed"` — store-outage behavior; default `"open"` (availability). The docs steer
  auth/payments/signup to `"closed"`, and the policy applies to *any* limiter throw, not only store
  outages.
- `emit` — header families (default `{ draft: true }`); `policyName` — surfaced in headers (defaults to the
  strategy name).
- `key`, `cost` (number or `(req) => number`), `onLimited`, `onError`, `handler` (a custom 429 responder
  that fully owns the denial), plus the trust-proxy config (`trustProxy`, `ipv6Prefix`,
  `trustClientIpHeader`).

`LimiterOrStrategy` is a discriminated union: pass a prebuilt `{ limiter }` or build one inline from
`{ strategy, store?, clock?, prefix? }`. `createGate` resolves it into a `{ limiter, fail, headersFor }`
bundle. For non-HTTP transports, **`createEnforcer`** (`src/adapters/enforce.ts:74`) is the transport-
agnostic core: `enforce(key, cost)` runs the check and **never throws on a store outage** — it catches,
fires `onError`, and returns an `EnforceResult` whose `allowed = (fail === "open")` with an `"error"`
outcome, so an adapter can map `"limited"` → 429 and `"error"` → 503.

**Key derivation is a security control** (see [11](11-overload-and-security.md)). Node adapters read the
socket peer + `X-Forwarded-For` through `clientIp(...)`; edge adapters use a hardened `edgeClientIp` that
trusts the platform header (`cf-connecting-ip`) by default and only consults the spoofable
`X-Forwarded-For` when `trustProxy` is configured — otherwise returning `"anon"` rather than a spoofable
key.

## The exactly-once `release()` lifecycle

This is the spine of the concurrency middleware family. The primitive hands back a `release()` that **must
be called exactly once**: a missed release leaks a slot forever (the inferred ceiling collapses to 0); a
double release under-counts and over-admits.

**Node servers** wire it to the response (`src/adapters/lifecycle.ts:47`) with first-fire-wins:

```ts
let released = false;
const fire = (dropped) => { if (released) return; released = true; release({ dropped }); };
res.on("finish", () => fire(dropOn5xx && res.statusCode >= 500)); // normal completion
res.on("close",  () => fire(true));                               // aborted/hung-up
```

**Web platforms** return a `Response` *value*, so the lifecycle wraps `response.body` in a `ReadableStream`
and fires on drain (normal), error (mid-flight), or cancel (client hangup) — returning a fresh `Response`
since `Response` is immutable (`src/adapters/lifecycle-web.ts:34`). The `try/finally`-shaped frameworks
(hono, trpc, elysia) set `dropped = thrown`. `dropped` is deliberately "a property of response *state*,
not handler outcome": the controller measures *capacity*, so a 500-in-50 ms is `dropped: false` (capacity
exists) while a client disconnect mid-stream is `dropped: true` (capacity wasted).

## Per-adapter map

| Adapter | Shape | Default key | Denial | Notable |
|---|---|---|---|---|
| express | `RequestHandler` | socket+XFF | `res.status(429).json` | fail-closed → 503 |
| fastify | `onRequest` hook | socket+XFF | `reply.code(429)` | unified variant must be `preHandler` (so `reply.raw` has subscribers) |
| koa | `Middleware` | `ctx.req` | `ctx.status=429` | reads `ctx.req` so it's correct regardless of `app.proxy`; unified does not `await next()` (would double-fire) |
| nest | `CanActivate` guard | socket+XFF | throws (Nest layer) | dependency-free; `@RateLimit` decorator + a globally-registered guard |
| hono | `MiddlewareHandler` | `edgeClientIp` | `c.json(…,429)` | merges custom-handler headers without clobbering |
| fetch | handler wrap | `edgeClientIp` | 429 `Response` | clones the handler `Response` to copy headers; unified wraps the body stream |
| next | returns a result | `edgeClientIp` | ready 429/503 `Response` | dependency-free; `{limited, headers|response}` |
| remix | guard | `edgeClientIp` | throws a `Response` | Remix renders thrown Responses |
| sveltekit | `handle` hook | `event.getClientAddress()` | 429 `Response` | uses SvelteKit's platform IP |
| elysia | `onBeforeHandle` | `edgeClientIp` | `set.status=429` | unified is a manual wrap (hooks can't tie one admit to its release) |
| trpc | `t.middleware` | **required `key`** | throws `TRPCError` | no headers (not HTTP) |
| grpc | unary wrap | `call.getPeer()` | `RESOURCE_EXHAUSTED`(8) | built on `createEnforcer`; fail-closed → `UNAVAILABLE`(14) |
| lambda | proxy-handler wrap | event source IP (v1/v2) | 429 | built on `createEnforcer`; merges headers into the result |

The **`@RateLimit` decorator** (nest) is an idiomatic, dependency-free option: it stamps metadata read off
the ambient `reflect-metadata`, validates eagerly at module load, and a single globally-registered guard
caches one `Gate` per distinct metadata object (decorator configs are stable singletons → safe `WeakMap`
keys) and resolves handler-first then class-level then defaults. (Implementation note flagged for the
record: the design called for a guard + *interceptor* for post-completion release; the shipped code uses a
guard + Express-style *middleware* registered via `MiddlewareConsumer` — functionally equivalent, both run
post-handler.)

## Design decisions & rationale

- **Transport-agnostic `createEnforcer`** — the limiter/fail/header logic is written once and every
  transport is a thin map, so gRPC and Lambda reuse the exact same enforcement as HTTP.
- **`release()` exactly-once is belt-and-suspenders** — enforced by first-fire-wins + a local boolean *and*
  the primitive's own idempotence, because the cost of getting it wrong (a permanently leaked slot) is
  severe.
- **Web vs node lifecycles differ structurally** — node mutates a stream (`finish`/`close` events) while
  web returns an immutable `Response` value (must wrap the body stream); the two paths exist because the
  platforms genuinely differ.
- **`dropped` reflects capacity, not success** — the adaptive controller measures whether a slot's capacity
  was used, so a fast 500 is not "dropped" but a wasted mid-stream disconnect is.
- **Edge keying defaults to the platform header, never a raw spoofable one** — the hardened `edgeClientIp`
  is the audited fix for the classic header-spoofing bypass.

## Caveats

- Fastify's unified middleware must be `preHandler`, not `onRequest` (subscriber timing on `reply.raw`).
- Koa/express unified deny paths use a no-op release from the admitter's short-circuit (no lifecycle wiring
  needed on a deny).
- Adaptive concurrency is **keyless** (a global in-flight count, not per-IP) — compose
  `weightedFairEscrow` ahead of it for per-tenant fairness.

## What proves it

- `test/adapters/release-invariant.test.ts` — the safety net: property-fuzzes `[finish, close]` orderings
  asserting **≤ 1 release, exactly 1 if any event fired, correct `dropped`**; integration workloads end
  with `guard.inflight === 0` (no slot leak).
- `test/adapters/enforce.test.ts` — `createEnforcer` fails **open** (allowed, error outcome, headers `{}`)
  and **closed** (denied) as configured.
- `test/adapters/edge-ip-trust.test.ts` — trusts `cf-connecting-ip`, ignores spoofable XFF → `"anon"`
  without `trustProxy`.
- Per-framework: `test/adapters/{express,fastify,koa,nest,nest-decorator,nest-middleware,hono,fetch,next,
  remix,sveltekit,elysia,trpc,grpc,lambda}.test.ts` and the `*-unified` variants.

## Source map

`src/adapters/core.ts`, `enforce.ts` (the shared contract) · `lifecycle.ts`, `lifecycle-web.ts` (the
exactly-once release) · the per-framework files listed above.
