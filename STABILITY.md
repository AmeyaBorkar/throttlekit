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
- **Validation may tighten to reject inputs that could only misbehave.** A patch or minor may begin throwing
  a `RangeError` on an option or argument value that previously produced a *corrupt* result — a non-finite
  `Decision` field, an unbounded allocation, or a hang (e.g. a subnormal `limit`/`ratePerSec`, a
  `cost > Number.MAX_SAFE_INTEGER`, an oversized `slidingWindow.buckets`, a pathologically-nested config
  file). This is a **bug fix**, not a narrowing of the supported surface: such values could never yield a
  valid limit. No *valid* input changes behavior.

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
  `regionFairPool` / `RedisRegionFairPool` / `AsyncRegionFairPool`, `twoTier`'s `lease.adaptive`,
  `leaseSizer`, `predictiveLeaseSizer`, `learnedReservation`, `predictiveReservation`, `tokenBudget` /
  `distributedTokenBudget`, `fairShare` / `weightedFairShare`. (The `twoTier` *modes* — `strict` /
  `cached-deny` / fixed-`batch` `leased` — are stable; the learned sizers are the experimental part.)
- **Tier-2 fleet leasing:** `LeaseSpender` (`throttlekit/twotier`) — the client-side spend of a
  window-coupled lease taken from the server's `Fleet.Reserve` door. A verbatim port of the
  `twoTier(leased, windowCoupled)` L1 spend (byte-identical, conformance-tested + golden-vector-pinned),
  so the service stays the one oracle for the grant size; the client only spends what it is granted.
- **`GlobalCoordinator.leaseWindowed` (`throttlekit/federation`)** — an additive **optional** method
  (`leaseWindowed(key, tokens) → { granted, expiresAt }`, capability-detected by presence) that returns
  the authoritative store-clock window boundary atomically with the grant, so a Tier-2 client discards
  leftover credits exactly at the store window (eliminating node↔store clock skew). The stable `lease()`
  is unchanged; callers feature-detect and fall back. Implemented on the Redis + Postgres coordinators.
- **Sketches & analytics:** `sketchRateLimit`, `mergeableSketch`, `withAnalytics`, and the admission
  observability taps `admissionTap` / `withAdmissionAnalytics` (the in-process telemetry that powers the
  ThrottleKit Lens dashboard — both read only state `unifiedAdmission` already computes).
- **What-If Replay testkit:** the replay primitives on `throttlekit/testkit` (`recordLimiter`, `replay`,
  `candidateField`, `rebuildLimiter`, the trace/fingerprint/divergence types and `ReplayRefusedError`),
  the candidate-compare layer (`set`/`scale`/`swap` + `candidate`/`resolveCandidate`, the `ScoreReducer`
  metrics, and `scorecard`/`rankByFlips` for a multi-candidate comparison), and the one additive building
  block they rest on, `buildStrategy` on `throttlekit/config`. Library-only, read-only over the existing
  pure algorithms; the trace format (`TRACE_FORMAT_VERSION`) is versioned and rejects incompatible traces.
  Their shapes may change in a minor.
- **Admission Policy Plans:** the `throttlekit/policy` subpath — `policy` / `policySet` /
  `policySetFromConfig` / `parsePolicySet` (the content-addressed `Policy` / `PolicySet` artifact),
  `plan` (the recorded-traffic decision diff) with its `Plan` / `PolicyDiff` shapes, the corpus adapters
  (`corpusFromRecordings` / `corpusFromTraces`), `assertPlanAcceptable` (the CI gate), and the
  `renderPlan` / `planToJSON` renderers. A pure orchestration layer over the replay testkit; no core
  change. The artifact format (`POLICY_SET_FORMAT_VERSION`) is versioned and rejects incompatible sets.
  Their shapes may change in a minor.

## Explicitly out of scope at `1.0`

- **The Lua / SQL wire format is not frozen.** It is implicit and additive-only (new script names are a
  compatible change). Whether to publish a *versioned, frozen* wire protocol — the precondition for
  third-party/polyglot clients — is a separate, deliberate decision, **deferred** past `1.0`.

- **The gRPC service wire (`throttlekit.v1`) is additive-only, not frozen.** It grows by **adding** —
  the read-only `Monitor` service (`GetSnapshot` / `Watch`) and the Tier-2 `Fleet` service (`Reserve`)
  are new additive services; the existing decision RPCs and messages are unchanged. Compatibility is
  **machine-gated by `buf breaking` in CI**, so a breaking change to an existing field/RPC fails the
  build rather than shipping. (This is the `throttlekit-server` surface, versioned separately from the
  core library.)
