# ThrottleKit — Scoreboard

Tracks whether the project meets its stated expectations. Updated as features land and
benchmarks run. Legend: ✅ met · 🟡 in progress · ⬜ not started · ❌ regressed.

## Performance budgets (design targets from §11)

Measured by the bundled `npm run bench` harness on commodity hardware. Numbers are filled in by
the benchmark suite; targets are fixed.

| Path | Target | Measured | Status |
|---|---|---|---|
| In-memory `checkSync` (GCRA) | sub-microsecond; **0 steady-state allocations** | _pending_ | ⬜ |
| In-memory `check` (async) | low single-digit microseconds | _pending_ | ⬜ |
| Redis `strict` decision | exactly **1** round trip | _pending_ | ⬜ |
| `leased` steady state | ~**1 round trip per B** requests | _pending_ | ⬜ |
| Multi-dimensional (k axes) on Redis | **1** round trip regardless of k | _pending_ | ⬜ |

## Correctness guarantees (§12)

| Guarantee | How proven | Status |
|---|---|---|
| Atomicity: N concurrent at limit K ⇒ exactly K allowed (memory) | concurrency test | ⬜ |
| Atomicity in Redis (Lua / OCC) | env-gated concurrency test | ⬜ |
| JS ↔ Lua dual-path bit-identical decisions | conformance vector suite | ⬜ |
| `remaining` never negative; never allow above limit+overshoot | property tests | ⬜ |
| Leased overshoot ≤ L×B | property test | ⬜ |
| Clock-jump safety (negative elapsed clamped) | unit tests | ⬜ |
| Defined fail-open / fail-closed on store error | unit + chaos tests | ⬜ |

## Feature matrix (§18 differentiators)

| Capability | Status |
|---|---|
| GCRA (single-timestamp) default | ⬜ |
| Token bucket | ⬜ |
| Fixed window | ⬜ |
| Sliding window counter (sub-bucketed) | ⬜ |
| Sliding window log (exact) | ⬜ |
| Leaky bucket / queueing (`schedule`) | ⬜ |
| Adaptive concurrency (gradient2 + aimd) | ⬜ |
| MemoryStore (timer wheel + approx-LRU) | ⬜ |
| RedisStore (atomic Lua, 1 RTT) | ⬜ |
| Two-tier local cache (strict/cached-deny/leased) | ⬜ |
| Token leasing (network-light) | ⬜ |
| Multi-dimensional, 1 round trip (`all`/`any`) | ⬜ |
| Express adapter | ⬜ |
| Web `fetch` / edge adapter | ⬜ |
| Injectable clock / determinism (`ManualClock`) | ⬜ |
| OpenTelemetry metrics | ⬜ |
| IETF + legacy headers, `Retry-After` | ⬜ |
| Proxy-correct IP + IPv6 prefix + HMAC keys | ⬜ |
| Store conformance testkit | ⬜ |
| TypeScript-first, ESM + CJS | 🟡 |

## Quality gates

| Gate | Status |
|---|---|
| `biome check` clean | ⬜ |
| `tsc --noEmit` clean (strict) | ⬜ |
| Test coverage ≥ 90% lines on `src` | ⬜ |
| CI green (lint, typecheck, test, build, Redis matrix) | ⬜ |
| Build emits valid ESM + CJS + types | ⬜ |
