# Stability & versioning policy

ThrottleKit is **`0.x`**: feature-complete and heavily tested, but pre-1.0. This document
states exactly what you can rely on today, what is still moving, and what `1.0` will commit
to — so you can adopt the parts that are stable without waiting for the frontier to settle.

## Versioning today (`0.x`)

- **Additive, opt-in changes ship as a patch** (e.g. `0.11.1` added the joint-LP policy,
  `0.11.2` adds the Postgres concurrency coordinator). New strategies, stores, adapters, and
  opt-in options are additive and do not change existing behavior.
- **Breaking changes are avoided** and, when unavoidable before `1.0`, are called out in the
  CHANGELOG. The one earmarked breaking change for `1.0` is the `Decision.bindingAxis` field
  (today exposed via the OTel `tk.binding_axis` attribute + `UnifiedAdmitter.lastDecisions()`).
- The **Lua / SQL wire format is implicit** and may gain new script names (a compatible,
  additive change); there is **no frozen wire protocol** yet (deliberately deferred).

## Two tiers

### Stable core — relied upon, frozen in intent

These surfaces have been stable across many releases and are what `1.0` will lock under
SemVer. Changes here will be additive or follow a deprecation cycle.

- **Types:** `Limiter`, `Store`, `Strategy`, `Decision`, `Clock`, `FailMode`.
- **Algorithms:** `gcra`, `tokenBucket`, `fixedWindow`, `slidingWindow`, `slidingWindowLog`,
  `quota`, `leakyBucket` — each pure, machine-checked, and dual-path conformant (JS ≡ Lua).
- **Core API:** `rateLimit`, `combineDecisions`, `ALLOW_FULL`, `systemClock`, `ManualClock`,
  the error types, `buildRateLimitHeaders`, `createEnforcer`.
- **Stores:** `MemoryStore`, Redis (`throttlekit/redis`), Postgres (`throttlekit/postgres`),
  DynamoDB, Deno KV, Cloudflare — all cross-conformant via the shared `testkit`.
- **Framework adapters** (`throttlekit/express`, `/fastify`, `/koa`, `/hono`, `/next`,
  `/nest`, `/sveltekit`, `/remix`, `/elysia`, `/trpc`, `/grpc`, `/lambda`, `/fetch`).
- **Cross-cluster federation** (`federate`, `GlobalCoordinator`, `RedisCoordinator`,
  `PostgresCoordinator`) — the K-independent overshoot bound is proven and shipped.

### Experimental frontier — opt-in, may be refined before `1.0`

These landed recently and may gain/rename options before `1.0`. They are **opt-in** — none
affects the stable core or default behavior — and each carries its own caveats in the docs.

- **Unified admission policy layer** — `unifiedAdmission` is stable; the `policy: "joint-lp"`
  bid-price filter, `solveFluidLp`, and the planned `jointLp.adaptive` are experimental
  (their value depends on workload modeling; see the joint-LP caveats).
- **Distributed adaptive concurrency** — `distributedAdaptiveConcurrency` and its coordinators
  are stable in their safety guarantee, but the tuning knobs (`acknowledgedHandoff`,
  `eagerHandoff`, `selfFence`, and the new `allocation: "demand-proportional"`) are still being
  calibrated and may change defaults.
- **Escrow / two-tier layer** — `weightedFairEscrow`, `twoTier`, `leaseSizer`,
  `predictiveLeaseSizer`, `learnedReservation`, `predictiveReservation`.
- **Sketches & analytics** — `sketchRateLimit`, `mergeableSketch`, `withAnalytics`.

## What `1.0` will commit to

1. No breaking changes to the **stable core** signatures within `1.x` (additive only;
   removals go through a deprecation cycle).
2. A decision on `Decision.bindingAxis` (add the field, or formally bless the current OTel +
   `lastDecisions()` path as the permanent API).
3. A documented wire-protocol versioning policy (whether the Lua/SQL format is frozen or stays
   additive-only) — currently **deferred**; reopening it is an explicit, separate decision.
4. Graduation of the experimental frontier items that have soaked, with any that remain in
   flux clearly marked `@experimental`.

We are intentionally **not rushing `1.0`**: declaring it commits to SemVer stability for all
`1.x`, and several frontier features are days-to-weeks old. The plan is a deliberate
stabilization milestone, not a date.
