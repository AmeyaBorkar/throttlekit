# Contributing to ThrottleKit

Thanks for your interest! ThrottleKit aims to be *provably* correct and *measurably* fast, so the
contribution bar is mostly about preserving those guarantees.

## Setup

```sh
npm ci
```

Requires Node ≥ 18 (CI runs 20, 22, 24).

## Everyday scripts

| Script | What it does |
|---|---|
| `npm test` | Run the Vitest suite (Redis-gated tests skip without a Redis env). |
| `npm run test:cov` | Tests with V8 coverage. |
| `npm run typecheck` | `tsc --noEmit` (strict; also type-checks `examples/`). |
| `npm run lint` / `npm run lint:fix` | Biome check / auto-fix + format. |
| `npm run build` | tsup → ESM + CJS + `.d.ts` for every subpath. |
| `npm run bench [-- --redis]` | Benchmarks; add `--expose-gc` to measure allocations. |

A quick pre-PR gate: `npm run check` (lint → typecheck → test).

## Running the Redis-gated tests locally

The dual-path conformance, the Redis atomicity proofs, and the Redis store-testkit are gated on a
real Redis. Start one (any port; avoid clobbering an existing Redis) and point the env var at it:

```sh
docker run -d --rm -p 6380:6379 --name tk-redis redis:7-alpine
THROTTLEKIT_TEST_REDIS=redis://localhost:6380 npm test
```

Each Redis-using test file pins its own DB index, so they can run in parallel safely.

## Adding a strategy (the important rule)

A pass/deny strategy is a pure `(state, now, cost) -> { state, decision, ttlMs, persist }`. If it
has an atomic Redis form, it **must** be dual-path correct:

1. Implement `check()` and a `lua` `LuaProgram` that produce the **same** decision.
2. Keep the math bit-identical: pass only integers in `ARGV` and derive any floats identically on
   both paths; store fractional state via Lua `string.format('%.17g', x)`; clamp persisted
   `ttl >= 1`; return the standard reply tuple `[allowed, limit, remaining, resetAt, retryAfterMs]`
   as integers.
3. Add a case to the conformance suite (`test/conformance/`) — it asserts the JS and Lua decision
   streams are identical across generated timelines.
4. Add boundary unit tests, and consider a `fast-check` invariant in `test/property/`.

See `docs/DESIGN-NOTES.md` for the verified math behind each algorithm (with citations).

## Custom stores

Implement the single `Store.apply` primitive and validate it with `runStoreConformance` from
`throttlekit/testkit` (pass your test runner's `{ describe, it, expect, beforeEach, afterEach }`).

## Commits & PRs

- Conventional Commits (`feat:`, `fix:`, `perf:`, `docs:`, `test:`, `refactor:`, `chore:`).
- Small, focused, bisectable commits; keep the build green at each one.
- CI must pass (lint, typecheck, the Node matrix with a Redis service, build).
