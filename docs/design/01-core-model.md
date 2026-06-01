# 01 · Core model & the `apply` primitive

> The domain contracts every other component is built from: `Decision`, `Strategy`, `Store`, `Clock`,
> `Limiter`, and the single atomic primitive — `apply` — that all storage reduces to. Source: `src/core/`.

## Purpose

The core defines the **smallest set of contracts** that makes three things simultaneously true:

1. an algorithm can be authored **once** and run in-process *or* atomically across a cluster;
2. a backend can be added by implementing **one** method;
3. the in-process path and the distributed path can be proven to make **bit-identical** decisions.

Everything else in ThrottleKit is a policy over these contracts.

## The contracts

### `Decision` — the immutable result of one check

```ts
// src/core/types.ts:22
export interface Decision {
  readonly allowed: boolean;
  readonly limit: number;        // the effective ceiling (burst capacity or window quota)
  readonly remaining: number;    // whole units left before rejection; never negative
  readonly resetAt: number;      // epoch-ms of full replenishment
  readonly retryAfterMs: number; // 0 when allowed
}
```

Two properties of this type are load-bearing:

- **All numeric fields are integers.** This is not cosmetic. Redis truncates Lua numbers to integers
  on reply, so by forbidding fractional decision fields the JavaScript path and the Redis-Lua path can
  produce *byte-equal* values — which is what makes the dual-path conformance proof (below) possible
  (`src/core/types.ts:14`).
- **Every field is `readonly`.** `Decision` is a **producer** type — the library makes it, the caller
  reads it — and the 1.x stability contract is that it grows *only* by appending new optional readonly
  fields. Consumers must therefore not reject unknown keys (don't `zod.strict()` a `Decision`). This is
  the rule that lets later versions add e.g. `bindingAxis` without a breaking change (`src/core/types.ts:17`).

### `Strategy<S>` — a pure algorithm over serializable state

```ts
// src/core/types.ts:49
export interface Strategy<S = unknown> {
  readonly name: string;        // surfaced in RateLimit-Policy and metrics
  readonly limit: number;
  readonly windowMs?: number;
  readonly ttlMs: number;       // store TTL hint
  check(state: S | undefined, now: number, cost: number): StrategyOutcome<S>;
  readonly lua?: LuaProgram;    // optional atomic Redis form (the dual path)
  peek?(state, now): Decision;            // non-consuming "current capacity"
  forecast?(state, now, cost): Forecast;  // non-consuming projection
  readonly readState?: ReadState<S>;      // read-only Lua decode for peek/forecast over Redis
}
```

A strategy is a pure transition: given the prior state (or `undefined`), the current time, and a cost,
it returns the next state and a decision. It never performs I/O and never reads the clock — those are
the store's and the limiter's jobs. The optional `lua` is the *same* transition expressed as an atomic
Redis script; the optional `peek`/`forecast`/`readState` give non-consuming introspection.

### `Store` — one atomic primitive plus housekeeping

```ts
// src/core/types.ts:161
export interface Store {
  apply<S, R>(key: string, transform: Transform<S, R>): Promise<R>;
  applySync?<S, R>(key: string, transform: Transform<S, R>, now?: number): R; // sync-capable stores only
  reset(key: string): Promise<void>;
  resetSync?(key: string): void;
  close?(): Promise<void>;
}
```

`apply` runs a pure read-modify-write `transform` **atomically with respect to other applies on the
same key**, persisting the new state with a TTL iff the transform asks. That single guarantee is the
entire contract a backend author must satisfy:

```ts
// src/core/types.ts:140
type Transform<S, R> = ((state: S | undefined) => ApplyOutcome<S, R>) & { lua?: LuaInvocation<R> };
type ApplyOutcome<S, R> = { state: S; result: R; ttlMs: number; persist: boolean };
```

A `Transform` may carry an optional `.lua` rider. A Lua-capable store (Redis) runs the script in one
round trip; **every other store ignores the rider and runs the function body** — so correctness never
depends on the Lua path existing. This is the dual-path design in one type: the pure JS transform is the
source of truth, and the Lua form is a verified-equivalent accelerator.

### `Clock` — injected time

```ts
// src/core/types.ts:7
export interface Clock { now(): number; } // epoch-ms
```

`systemClock` is the *only* place `Date.now()` is called in the entire library (`src/core/clock.ts:3`);
`ManualClock` drives the deterministic test suite. `ManualClock.advance(ms)` requires a non-negative
step (monotonic), while `set(ms)` may move time *backwards* — deliberately, so the suite can simulate
clock jumps and prove every algorithm is jump-safe (`src/core/clock.ts:18`).

### `Limiter` — the wiring

`rateLimit({ strategy, store?, clock?, prefix? })` returns a `Limiter` that binds a strategy to a store
with an injected clock and a key prefix (`src/core/limiter.ts`). The store defaults to a fresh
`MemoryStore`; `clock` defaults to `systemClock`. It exposes `check`/`checkSync`, batched
`checkMany`/`checkManySync`, non-consuming `peek`/`forecast`, plus `reset`/`close`.

## Design decisions & rationale

**One mutating primitive, on purpose.** Storage exposes exactly one write operation — `apply` — and
nothing else (`src/core/types.ts:157`). This is the central architectural lever: because algorithms are
pure functions over `S` and backends are pure transport for one atomic RMW, the two axes are fully
independent. Adding DynamoDB doesn't touch GCRA; adding a sliding-window variant doesn't touch any
store. The cost is that every algorithm must express its step as a single atomic transform — which it
turns out every rate-limiting algorithm can.

**`StrategyOutcome` *is* `ApplyOutcome`.** A strategy's `check` returns precisely the shape a store's
`apply` consumes (`src/core/types.ts:41`), so the limiter forwards a strategy's output straight into the
store with no per-check re-wrap allocation. The two interfaces were unified specifically to kill that
allocation on the hottest path.

**The zero-allocation synchronous fast path.** For the in-memory store, the async machinery and a
per-call transform closure are pure overhead. The limiter keeps a *single reused* `syncTransform` closure
that reads two mutable slots (`syncNow`, `syncCost`); `check`/`checkSync`/`checkMany` set the slots and
invoke through `applySync` **with no `await` in between** (`src/core/limiter.ts:54`). Single-threaded
execution guarantees the slots are read before any other call runs, so the closure is safe to reuse and
allocates nothing per call. When a sync store is present, `check` even runs inline and returns
`Promise.resolve(...)`, skipping the async frame entirely (`src/core/limiter.ts:67`).

**Injected clock, never `Date.now()` inside an algorithm.** Determinism is a hard requirement, not a
convenience: it is what makes the conformance vectors (below) reproducible and what lets a unit test pin
a limit to the millisecond. `set()` deliberately allows backward jumps so the suite can verify the
jump-safety every algorithm implements with `max(tat, now)` / `max(0, now − last)` (`src/core/clock.ts:33`).

**Stable, machine-readable error codes.** `ThrottleKitError` carries a frozen string `code`
(`store_unavailable`, `rate_limit_exceeded`, `not_implemented`, `queue_full`, `config_invalid`) rather
than relying on `instanceof` (`src/core/errors.ts:9`). `instanceof` silently fails across realms or when
two copies of the package are bundled; a `code` string never does. `StoreUnavailableError` is what drives
the fail-open/closed policy at the edges.

**`prefix:key` is joined in exactly one place.** `prefixer` (`src/core/key.ts:8`) is the single
definition of how a namespace and a key combine, shared by the limiter and every store, so a limiter and
its backend can never split a keyspace by formatting it two different ways. For the same reason the cost
check lives once in `requireCost` (`src/core/validate.ts`) and `clamp` lives once in `src/core/math.ts`
— shared definitions that call sites cannot disagree about.

**`ownsStore`.** The limiter closes a store only if it created it (`store` was omitted). A store you
constructed and passed in is yours to manage — `close()` will never dispose it (`src/core/limiter.ts:46`).

## The dual-path contract (why bit-identity matters)

The single most important invariant in the codebase: **the JavaScript executor and the Redis-Lua
executor produce identical decision streams.** It is what lets you develop and test in-memory and deploy
on Redis with no behavioral surprise, and it is the foundation the polyglot stack ([13](13-wire-protocol.md),
[15](15-python-client.md)) extends across languages.

Three mechanisms make it hold:

- integer-only `Decision` fields (Redis truncates Lua numbers on reply);
- fractional internal state persisted at full IEEE-754 precision via `string.format('%.17g', v)` so a
  GCRA timestamp round-trips exactly;
- a shared `now` sentinel (`ARGV[1] = 0` ⇒ the Lua reads the Redis server clock) so a distributed
  decision is anchored to one authoritative time.

This is proven, not asserted — see *What proves it*.

## Caveats

- `checkSync` is available **only** over a sync-capable store (`MemoryStore`); calling it against an
  async store throws, by design.
- `systemClock` is the one `Date.now()` site; on some platforms (notably Windows) `Date.now()` is not
  strictly monotonic, which is *why* every algorithm clamps elapsed time. Decisions stay correct under a
  backward jump (they fail safe — deny — until real time catches up).

## What proves it

- `test/core/limiter.test.ts` — `checkSync` and `check` agree decision-for-decision across advancing
  steps; prefix isolation; `checkSync` throws on an async-only store.
- `test/core/single-clock-read.test.ts` — the clock is read **exactly once** per `checkSync` /
  `checkManySync` regardless of key count (the reused-transform optimization).
- `test/core/check-many.test.ts` — a batch is evaluated at one consistent instant; equals per-key
  `checkSync`.
- `test/core/clock.test.ts` — monotonic `advance`, backward-jumpable `set`, input validation.
- `test/core/errors.test.ts` — the error hierarchy and `code` discriminants.
- `test/conformance/conformance.test.ts` — **the central proof**: thousands of generated
  `(arrivals, costs, clock)` timelines run through both the JS path (MemoryStore) and the atomic Redis
  Lua path (RedisStore), asserting the two decision streams are byte-equal at every step (Redis-gated).

## Source map

`src/core/types.ts` (all contracts) · `src/core/limiter.ts` (`rateLimit`) · `src/core/clock.ts`
(`systemClock`, `ManualClock`) · `src/core/key.ts` · `src/core/validate.ts` · `src/core/math.ts` ·
`src/core/errors.ts` · `src/core/transform.ts` (`decisionTransform`, `readOnlyTransform`) ·
`src/core/lua.ts` (the `now` sentinel + shared decoder) · `src/core/combine.ts` (the admission algebra,
covered in [07](07-unified-admission.md)).
