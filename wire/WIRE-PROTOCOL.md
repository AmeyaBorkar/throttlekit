# ThrottleKit wire protocol (Redis Lua)

How the atomic Redis path encodes a rate-limit check: the script names, their `KEYS`/`ARGV`, the reply
tuple, and the state encoding. This is the contract a **direct `RedisBackend`** (a polyglot client that
talks to the *same* Redis as a Node fleet, running the *same* vendored Lua) must hold to make decisions
bit-identical to the reference library. The extracted scripts live next to this doc in
[`scripts/`](scripts/), pinned by [`scripts/manifest.json`](scripts/manifest.json).

> **Status: documented + behavior-locked, NOT frozen.** `manifest.json` carries `"frozen": false`. The
> script bytes, `ARGV` order, reply tuple, state encoding, and key scheme below are stable in practice
> and guarded by tests, but are **not** yet a frozen external contract — that is bet #78, a separate,
> deliberate decision (see `research/polyglot/DESIGN.md`). The **single trigger** to freeze: the direct
> `RedisBackend` is promoted to a supported, externally-pinned surface. Until then the service door (the
> `throttlekit.proto` gRPC contract) is the recommended polyglot path, and it never exposes this wire.

## The one invariant

**Exactly one thing computes a `Decision`: the Node core** — and on the Redis path that computation runs
**server-side, in Lua**. A `RedisBackend` does not re-implement any algorithm; it marshals `ARGV`, runs
the vendored script, and decodes the reply. The [golden vectors](README.md) confirm its
marshalling/decoding round-trips correctly. No surface re-derives the math.

## The reply tuple

Every `check` script returns a flat array of **five integers**, in this exact order:

```
{ allowed, limit, remaining, resetAt, retryAfterMs }
```

| Field | Meaning |
|---|---|
| `allowed` | `1` if admitted, `0` if denied. (Decoded to a boolean: `allowed == 1`.) |
| `limit` | Effective ceiling reported to clients (burst capacity or window quota). |
| `remaining` | Whole units left before the next denial. Never negative. |
| `resetAt` | Epoch-ms at which the limiter is fully replenished. |
| `retryAfterMs` | Milliseconds to wait before retrying. `0` when `allowed`. |

Redis **truncates Lua numbers to integers on reply**, which is *why* every field is integer-valued — it
is the mechanism that makes the JS and Lua paths produce identical replies. A denied request never
consumes; `remaining` stays meaningful on a deny.

## The `now` slot — `ARGV[1]`

`ARGV[1]` is **always `now` in epoch-ms**, with one sentinel:

- `ARGV[1] = 0` ⇒ the script reads the **Redis server clock** (`TIME`) and uses that for `now`. This is
  the default (`RedisStore { useServerTime: true }`) and is what a distributed fleet must use, so that
  node clock skew can never split one logical window into two counters or corrupt shared state.
- `ARGV[1] = <epoch-ms>` ⇒ the script uses that exact instant (deterministic tests; a single-node caller
  that passes its own clock). Only the absolute `resetAt` depends on this choice; the duration fields
  (`retryAfterMs`) stay skew-free either way.

**A polyglot fleet sharing a key MUST agree on this** — mixing server-time and client-time clients on the
same key is a misconfiguration.

## The key scheme

The script treats `KEYS[1]` as opaque, but clients sharing a limit must format it identically:

```
KEYS[1] = prefix ? `${prefix}:${key}` : key
```

i.e. a non-empty store `prefix` is joined to the limiter key with a single `:`. The join format is
defined once in the reference core (`src/core/key.ts`) and is part of this contract — a Python and a Node
client on the same logical limit must produce the same `KEYS[1]` string. Each built-in script touches
exactly **one** key, so Redis Cluster hash-tagging is a non-issue here (no multi-key script).

## Fractional state, integer replies

Internal per-key state is often **fractional** (a GCRA theoretical-arrival-time, a token-bucket token
count). It is persisted via Lua `string.format('%.17g', v)` so it round-trips through Redis **exactly**
(17 significant digits == full IEEE-754 double precision). The *reply* is still integer (see above); the
fractional value lives only in the stored state. A port that re-reads state (the `read` scripts) must
parse it back at full precision (`tonumber` in Lua; `float()` in Python; etc.).

## Execution protocol

The reference store runs each script by **`EVALSHA`** (the sha1 of the script body, computed by the
client) with an **`EVAL` fallback on `NOSCRIPT`** (the cache is empty after a Redis restart/failover; the
`EVAL` re-populates it). A `RedisBackend` should do the same:

```
sha = sha1(script_bytes)
try:    EVALSHA sha <numkeys> <keys...> <argv...>
except NOSCRIPT:
        EVAL    script_bytes <numkeys> <keys...> <argv...>
```

`manifest.json` pins the **sha256** of each script's bytes (a vendoring/integrity check for the port);
Redis itself keys its script cache by **sha1**, which the client computes at call time. Don't confuse the
two: sha256 = "did I vendor the right file"; sha1 = "is it in Redis's cache".

## The extracted scripts

Each strategy ships a consuming **`check`** script (returns the reply tuple, may write) and a
non-consuming **`read`** script (returns raw state for `peek`/`forecast`, never writes). `KEYS[1]` is the
(prefixed) limiter key for all of them; `read` scripts take no `ARGV`.

| Strategy | `check` ARGV (after `now`) | State encoding | `read` returns |
|---|---|---|---|
| **gcra** | `periodMs, limit, burst, cost` | string: the TAT, `%.17g` | `GET` → TAT string |
| **tokenBucket** | `capacity, refillPerSec, cost` | HASH `t`=tokens (`%.17g`), `l`=last-ms | `HMGET t l` |
| **fixedWindow** | `limit, windowMs, cost` | HASH `s`=window-start, `c`=count (ints) | `HMGET s c` |
| **slidingWindow** | `windowMs, limit, cost, buckets` | HASH ring of `S+1` slots, field `idx%(S+1)` = `"<idx>:<count>"` | `HGETALL` |
| **slidingWindowLog** | `windowMs, limit, cost` | ZSET: one member per accepted unit, score = epoch-ms | `ZRANGE 0 -1 WITHSCORES` |

Notes that bite a re-implementer:

- **Windows are epoch-aligned**: `windowStart = floor(now/windowMs)*windowMs` (fixed/sliding/budget). A
  fixed window therefore admits up to **2×limit** across a boundary by design — match it, don't "fix" it.
- **slidingWindow** is a sub-bucketed *estimate* (error bounded by one bucket); its `retryAfterMs` is an
  advisory approximation. The decision depends only on the integer ARGV with identical float ops/clamps,
  so it still matches bit-for-bit — reproduce the arithmetic exactly, including the clamp order.
- **slidingWindowLog** member names are `"<now>-<rank>"` where rank derives from the live count, making
  them unique without any non-deterministic command — the decision depends only on the multiset of
  *scores*, so a port may name members differently **only** if it preserves score multiplicity.
- A request whose `cost` exceeds the ceiling (e.g. GCRA `cost > burst`) can never be satisfied.

Conformance for all five is the language-neutral [`golden-vectors.json`](vectors/golden-vectors.json):
replay each suite's `(now, cost)` ops through the vendored Lua and assert every `expect` field-for-field.

## What is NOT in this contract (yet)

These ship in the Node library and run real Lua, but are **deliberately not extracted** — they have no
language-neutral vector contract a port could check against, and no first-party client consumes them yet.
Treat them as internal until they earn a vector suite + an entry here:

| Script(s) | Where | Why deferred |
|---|---|---|
| Fused GCRA × token-bucket admission (`tk:v1:fused-rc`, 2 keys) | `src/admission/fused-lua.ts` | Multi-key, bespoke; the service door covers unified admission instead. |
| Distributed token budget | `src/admission/distributed-budget.ts` | Returns the 5-tuple, but only the *in-process* `tokenBudget` is vectored today. |
| Federation lease/reconcile/refill/release | `src/federation/` | Coordination primitives with bespoke replies, not a `Decision`. |
| Concurrency heartbeat / HDEL | `src/concurrency/redis-concurrency-coordinator.ts` | Bespoke replies; distributed-concurrency coordination. |
| Multi-limiter | `src/multi/index.ts` | Composes per-strategy scripts; no separate neutral contract. |

The **service door** (`throttlekit.proto`) is the supported way to reach all of the above from another
language without depending on this raw wire.

## Regenerating

```bash
npm run wire:scripts     # rewrites wire/scripts/*.lua + manifest.json from the current core
npm run wire             # both: vectors + scripts
```

`test/wire/conformance-scripts.test.ts` re-derives the scripts from the shipped strategy objects and
fails if any committed `.lua` byte or manifest `sha256` has drifted — so the wire can't change silently;
a deliberate change forces a regenerate + a reviewed diff (and a behavioral break also fails the golden
vectors, forcing a `contractVersion` bump).
