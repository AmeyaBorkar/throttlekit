# ThrottleKit — Build Journey

A running, dated log of how ThrottleKit is built: decisions, dead-ends, and the
reasoning behind them. Newest entries at the top.

---

## 2026-05-25 — Kickoff & foundations

**Goal for the session.** Stand up a production-grade, framework-agnostic rate-limiting
library from the design doc (`THROTTLEKIT.md`), with provable correctness and measured
performance. Many small, bisectable commits.

**Decisions**

- **Toolchain.** TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`),
  Vitest (unit + property + bench), `fast-check` (property tests), Biome (lint+format, fast),
  `tsup` (dual ESM+CJS+`.d.ts`), Docker Redis for integration/conformance. Node `>=18`.
- **Package shape.** Single package with subpath exports (`throttlekit`, `/redis`, `/express`,
  `/fetch`, `/testkit`, `/otel`). Optional peers: `ioredis`, `express`, `@opentelemetry/api`.
- **Verified the risky math up front** (two parallel research passes, sources in
  `docs/DESIGN-NOTES.md`) before writing a line of algorithm code:
  - GCRA `tau = T·burst` admits exactly `burst` instantaneous requests from cold — matches the
    spec. (Canonical `throttled` uses `T·(burst+1)`; documented difference.)
  - Netflix **Gradient2** exact update rule (gradient clamped `[0.5,1.0]`, smoothing `0.2`,
    tolerance `1.5`, don't-grow-while-under-50%-utilized). The spec's `√limit` headroom comes
    from the older `GradientLimit`; I keep it configurable.
  - IETF RateLimit headers: current draft **-11** uses structured fields
    (`RateLimit` + `RateLimit-Policy`), not the legacy triple. Supporting both, documented.
  - Redis: `EVALSHA`→`NOSCRIPT`→`EVAL` fallback; `{tag}` hash slots; server `TIME` as clock.

**Architecture refinement (vs. the doc).** The single storage primitive becomes
`apply(key, transform)` where `transform(state) -> { state, result, ttlMs }` — the dynamic TTL
moves into the transform result (GCRA needs `ttl = ceil(new_tat − now)`), which is strictly more
capable than a fixed `ttlMs` argument. The optional atomic Lua form rides along as a property on
the transform, so Redis can fast-path built-ins to one round trip while custom strategies fall
back to optimistic concurrency — all behind the same one method a backend author implements.

**Status.** Repo initialized; tooling scaffolded; dependency install + first green CI next.
