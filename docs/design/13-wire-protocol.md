# 13 · Wire protocol

> The language-neutral contract layer: how any non-JavaScript surface proves it makes *identical* decisions
> to the Node core. Source: `wire/`.

## Purpose

`wire/` holds two independently-locked contracts that let a Python/Go client or the gRPC service make
decisions byte-identical to the reference Node core:

- the **service door** (`throttlekit.proto`) — the supported, recommended polyglot path; it never exposes
  Lua;
- the **raw Redis wire** (`scripts/*.lua` + `WIRE-PROTOCOL.md` + golden vectors) — the direct door a
  `RedisBackend` vendors; documented and behavior-locked but **not frozen**.

The load-bearing invariant: **exactly one thing computes a `Decision` — the Node core.** Every other surface
is a pipe; the golden vectors are the single yardstick each pipe is checked against. No surface re-derives
the math.

## The proto service shape

`service RateLimiter` in `package throttlekit.v1` (`wire/throttlekit.proto`) has eight unary RPCs grouped by
Door:

- **Rate:** `Check`, `CheckMany`, `Peek`, `Forecast`.
- **Cost:** `Debit` (post-hoc token-budget debit, [05](05-cost-axis-token-budget.md)).
- **Concurrency/unified lifecycle:** `Admit`, `Release`, `Heartbeat` ([06](06-concurrency.md),
  [07](07-unified-admission.md)).

The reply is the canonical `Decision` message with five pinned `int64` fields
(`allowed=1, limit=2, remaining=3, reset_at=4, retry_after_ms=5`) mirroring the frozen core `Decision`; tags
`6..15` are reserved so additive optional attributes arrive as new tags. The proto evolution rule
(documented in its header): proto3 additive-evolvable — add fields with new tag numbers, never renumber,
retype, or reuse a retired tag.

## The Lua extraction pipeline (single-source → manifest → drift-lock)

`wire/scripts/extract.ts` is the single-sourcing engine. It imports the *real* strategy constructors from
the core, constructs each one, and reads the **resolved** Lua straight off the constructed object
(`strategy.lua.script`, `strategy.readState.lua.script`). So the extracted `.lua` cannot drift from what the
library actually `EVAL`s. It computes `sha256(source)` per script and emits a manifest carrying the contract
version, `frozen: false`, the reply tuple, the `now`-argv description, and per-script ARGV order + checksum.
`generate-scripts.ts` writes each script's source **without a trailing newline** so the on-disk bytes equal
the hashed source.

**Two checksums, never confused:** the manifest pins **sha256** (vendoring integrity — "did I vendor the
right file?"); Redis caches scripts by **sha1**, computed client-side at call time ("is it in Redis's
cache?"). The exec protocol is `EVALSHA` with an `EVAL` fallback on `NOSCRIPT`.

## Golden vectors — the language-neutral behavioral contract

`wire/vectors/vectors.ts` defines canonical *input* suites only — a strategy spec plus a scripted
`(now, cost)` timeline — and **the shipped core fills the `expect` field** by running the real
`limiter.checkSync` / `meter.debitSync` against a `ManualClock`. So a fixture *cannot* be hand-computation-
wrong: the oracle is the code. The suites deliberately traverse divergence-prone transitions: cold-burst
exhaustion, fractional internal state (the `%.17g` GCRA TAT round-trip), `cost > 1`, window rollover, a large
real-epoch `now`, and the token-budget stop-at-boundary crossing debit. A port replays the inputs through
*its* path and must reproduce every `expect` field-for-field — extending the in-repo dual-path proof across a
language boundary.

The reply/state contract (`wire/WIRE-PROTOCOL.md`): every check script returns a flat 5-int array;
`ARGV[1] = now` epoch-ms with sentinel `0` ⇒ read the Redis server clock. Redis truncates Lua numbers to
integers on reply — *that* is the mechanism making the JS and Lua paths byte-equal — while fractional
internal state persists at `%.17g` so it round-trips exactly.

## Design decisions & rationale

- **Lua single-sourced from the constructed strategy** — reading `.script` off the real object (not a
  hand-copy) means the extracted `.lua` is byte-identical to what ships and can never silently diverge.
- **Drift-locked, not frozen** — a byte/sha256 test re-derives the scripts in memory and fails on any drift,
  so the wire can't change silently; a deliberate change forces a regenerate + reviewed diff (and a
  behavioral break also fails the golden vectors, forcing a contract-version bump).
- **Golden vectors define inputs only, with the core as oracle** — a fixture is never hand-computed, and a
  port is held to the exact decisions the shipped core produces.
- **Proto additive-frozen, Lua `frozen: false`** — the proto is the only contract a service client depends
  on and is additive-evolvable by construction, so the service door can ship while the raw wire stays
  unfrozen. Promoting the raw Lua to a frozen external contract is a separate, deliberate decision.
- **Contract version is decoupled from the package version** — it bumps only on a *behavioral* break (a
  changed `expect`), not on additive new suites.

## Caveats

- Status: documented and behavior-locked, **not frozen** (`frozen: false` in both manifests) — treat the raw
  Lua wire as a may-change contract until that flips.
- Only five strategies are extracted (gcra, tokenBucket, fixedWindow, slidingWindow, slidingWindowLog). The
  fused, distributed-token-budget, federation, concurrency, and multi-limiter paths are deliberately *not*
  extracted — no language-neutral vector contract, no first-party consumer; the service door covers them.

## What proves it

- `test/wire/conformance-scripts.test.ts` — the bytes lock (re-derive the scripts, diff `.lua` and sha256).
- `test/wire/conformance-vectors.test.ts` — the behavior lock (regenerate the vector document, diff against
  the committed copy).
- The golden vectors themselves are replayed downstream by the server core, the server's gRPC layer, and
  both Python backends ([14](14-grpc-server.md), [15](15-python-client.md)).

## Source map

`wire/throttlekit.proto` · `wire/WIRE-PROTOCOL.md` · `wire/scripts/extract.ts`, `generate-scripts.ts`,
`manifest.json`, `*.lua` · `wire/vectors/vectors.ts`, `golden-vectors.json` · `wire/generate.ts` ·
`wire/README.md`.
