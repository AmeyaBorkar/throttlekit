# Stability & versioning policy

ThrottleKit follows [Semantic Versioning](https://semver.org). This document is the **1.0 promise**:
what is frozen, how it may still evolve without breaking you, and what is explicitly *not* covered.

## The promise (`1.x`)

- **No breaking changes to the stable surface within `1.x`.** Removals and renames go through a
  deprecation cycle (a minor marks `@deprecated`; removal waits for the next major).
- **The library only adds, never narrows.** New strategies, stores, adapters, options, result fields,
  and subpath entry points ship as **minor** releases. Bug fixes are **patches**.
- **Experimental surface is carved out** (listed below) and may change in a minor — it is opt-in and
  never affects the stable core or default behavior.

## How a frozen API still evolves (the flexibility rules)

The surface is designed so it can grow for years without a major bump. Two rules, by direction:

- **Producer types** — values the library *returns* and you *read* (`Decision`, `Forecast`, `*Stats`,
  `UnifiedAdmission`): grow **only by appending optional `readonly` fields**. Therefore **do not
  reject unknown keys** on them (no `zod.strict()` / exhaustive "no extra properties" validation on a
  `Decision`) — a future minor may add an optional field, and strict consumers would break.
- **Consumer interfaces** — contracts *you* implement and the library *calls* (`Store`, `Strategy`,
  `Clock`, `ConcurrencyCoordinator`): grow **only by adding optional members**; a required member,
  a narrowed parameter, or a widened return would be breaking and waits for a major. **Capability
  detection is by presence:** an optional method that's present means the capability is available
  (e.g. `store.applySync`, `limiter.peek`, `limiter.checkSync` throwing when unsupported). New
  capabilities (e.g. a future `Store.applyMany?`) arrive this way, as minors.
- **Closed string unions are major-version boundaries.** `FailMode` (`"open" | "closed"`),
  `TwoTierMode`, `QuotaCadence`, and `DecisionKind` are conceptually-complete sets; adding a member is
  a major. `UnifiedAxis` (`"rate" | "concurrency" | "cost"`) is the one union we expect *might* grow —
  so every snapshot that keys on it is a `Partial<Record<UnifiedAxis, …>>`, which makes adding a 4th
  axis a **minor**, not a major.
- **Errors carry a frozen `code`.** Every `ThrottleKitError` has a `readonly code`
  (`"store_unavailable" | "rate_limit_exceeded" | "not_implemented" | "queue_full" | "config_invalid"
  | "throttlekit_error"`). Prefer it over `instanceof` when robustness across realms / duplicate
  bundles matters. The value set grows additively.

These rules are **mechanically enforced**, not just documented: type-level tests (`test/types/`) pin
the frozen shapes — `readonly` fields, the exact members of each closed union, `bindingAxis`'s shape,
and the error-`code` set — and fail the typecheck (CI's `tsc`) on any drift, while `attw` + `publint`
lock the ESM/CJS `.d.ts`/`.d.cts` resolution matrix across all 24 subpaths on every push.

## Stable core — frozen under SemVer at `1.0`

- **Types:** `Limiter`, `Store`, `Strategy`, `Decision`, `Clock`, `FailMode`, `Forecast`, and the
  error family (`ThrottleKitError` + subclasses, with `code`).
- **Algorithms:** `gcra`, `tokenBucket`, `fixedWindow`, `slidingWindow`, `slidingWindowLog`, `quota`,
  `leakyBucket` — each pure, machine-checked, and dual-path conformant (JS ≡ Lua).
- **Core API:** `rateLimit`, `combineDecisions`, `ALLOW_FULL`, `systemClock`, `ManualClock`,
  `buildRateLimitHeaders`, `createEnforcer`, `multiRateLimit` / `all` / `any`, `tapDecisions`,
  the security helpers (`clientIp`, `hashKey`, `hmacKeyer`), and the config loader (`throttlekit/config`).
- **Stores:** `MemoryStore`, Redis (`throttlekit/redis`), Postgres (`throttlekit/postgres`), DynamoDB,
  Deno KV, Cloudflare — all cross-conformant via the shared `throttlekit/testkit`.
- **Framework adapters** (`throttlekit/express`, `/fastify`, `/koa`, `/hono`, `/next`, `/nest`,
  `/sveltekit`, `/remix`, `/elysia`, `/trpc`, `/grpc`, `/lambda`, `/fetch`).
- **Cross-cluster federation** (`throttlekit/federation`: `federate`, `GlobalCoordinator`,
  `RedisCoordinator`, `PostgresCoordinator`) — the K-independent overshoot bound is proven and shipped.
- **Unified admission core:** `unifiedAdmission` and its `UnifiedAdmitter` / `UnifiedAdmission` shape
  (including `bindingAxis` and `lastDecisions()`) and the OTel layer (`throttlekit/otel`).
- **Pure-math helpers** (frozen signatures — fixed formulas, positional by design):
  `eoqOptimum`, `guaranteedShare`, `weightedMaxMin`, `criticalFractile`.

## Experimental — opt-in, excluded from the `1.x` SemVer guarantee

These are tagged `@experimental` in their JSDoc. They ship and are tested, but their options/shapes
may change in a **minor**; none affects the stable core or any default. Pin an exact version if you
depend on their exact shape.

- **Joint-LP admission policy:** `unifiedAdmission`'s `policy: "joint-lp"` filter, `jointLp.*`
  (incl. `jointLp.adaptive`), and `solveFluidLp`. (`unifiedAdmission` itself with the default
  `policy: "marginal"` is stable.)
- **Distributed adaptive concurrency tuning knobs:** `distributedAdaptiveConcurrency`'s safety bound
  is stable, but `acknowledgedHandoff`, `eagerHandoff`, `selfFence`, `recalibration`, and
  `allocation: "demand-proportional"` are still being calibrated and may change defaults.
- **Escrow / two-tier learned layer:** `weightedFairEscrow`, `federatedWeightedFairEscrow`,
  `regionFairPool`, `twoTier`'s `lease.adaptive`, `leaseSizer`, `predictiveLeaseSizer`,
  `learnedReservation`, `predictiveReservation`, `tokenBudget` / `distributedTokenBudget`,
  `fairShare` / `weightedFairShare`. (The `twoTier` *modes* — `strict` / `cached-deny` / fixed-`batch`
  `leased` — are stable; the learned sizers are the experimental part.)
- **Sketches & analytics:** `sketchRateLimit`, `mergeableSketch`, `withAnalytics`.

## Explicitly out of scope at `1.0`

- **The Lua / SQL wire format is not frozen.** It is implicit and additive-only (new script names are a
  compatible change). Whether to publish a *versioned, frozen* wire protocol — the precondition for
  third-party/polyglot clients — is a separate, deliberate decision, **deferred** past `1.0`.
