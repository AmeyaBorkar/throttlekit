<!-- Grounding artifact for the #281 / #282 design pass.
     Auto-extracted from the grounding-workflow synthesis (6 agents, anchors verified by parallel readers).
     Source of truth for the design notes in this folder. -->

# Codebase surface — grounding for #281 What-If Replay & #282 Token-Budget Control Room

> Synthesized from five parallel reader findings. Path:line anchors are preserved verbatim from the readers. Anything a reader did not confirm is marked **UNVERIFIED**. Accuracy over completeness.

---

## 1. What exists today (real primitives)

### 1a. Replay-relevant primitives (#281)

| Primitive | Anchor | Signature / shape | Notes |
|---|---|---|---|
| `Clock` interface | `src/core/types.ts:6-10` | `interface Clock { now(): number }` | Injected, epoch-ms, pure read. Limiter reads it once per `check`, never `Date`/`performance` directly. |
| `ManualClock` | `src/core/clock.ts:18-44` (also `:1-44`) | `class ManualClock implements Clock { constructor(start?); now(); advance(ms); set(ms) }` | Deterministic time source. `advance` is monotonic non-negative; `set` jumps absolute (backward jumps legal — "jump-safe" comment at `clock.ts:37`). `systemClock` uses `Date.now()`. |
| `Decision` | `src/core/types.ts:22-33` | `{ allowed; limit; remaining; resetAt; retryAfterMs }` (all integer) | Frozen 1.x contract. Integers → JS and Redis Lua produce bit-identical values. No cost/timestamp stored. |
| `Strategy<S>` | `src/core/types.ts:49-82` | `check(state, now, cost): StrategyOutcome<S>`; optional `lua`, `peek`, `forecast`, `readState` | Pure transition `(state, now, cost) ↦ {state, result: Decision, ttlMs, persist}`. No I/O/clock/randomness in main path. |
| `Strategy.check` | `src/core/types.ts:49-59` | `check(state, now, cost): StrategyOutcome<S>` | JS path and Lua path run the same math. Examples: `gcra.check` at `src/algorithms/gcra.ts:88-125`, `tokenBucket.check` at `src/algorithms/token-bucket.ts:92-134`. |
| `Limiter` | `src/core/types.ts:184-240` | `check/checkSync/checkMany/checkManySync/peek/peekSync/forecast/forecastSync/reset/close` | Hot path is `check/checkSync`. Single `clock.now()` per check, cached. `peek`/`forecast`/`checkSync` throw on async stores. |
| `rateLimit` factory | `src/core/limiter.ts:44-210` | `rateLimit<S>(options): Limiter` | Defaults `MemoryStore` + `systemClock`. Sync stores reuse `Transform` slots; async stores get a fresh `Transform` per call. |
| `Store` | `src/core/types.ts:161-179` | `apply / applySync? / reset / resetSync? / close?` | Atomic RMW. `applySync` only on in-process `MemoryStore` (the default, synchronous). Redis/Postgres are async-only. |
| `Transform<S,R>` | `src/core/types.ts:140-143` | `((state) => ApplyOutcome) & { lua? }` | JS closure is the determinism bottleneck; `now` captured at call time, not inside the closure. |
| `gcra` | `src/algorithms/gcra.ts:64-158` | `gcra(options): Strategy<number>` | State = single TAT number. Lua uses `string.format('%.17g')` for full-precision TAT round-trip. |
| `tokenBucket` | `src/algorithms/token-bucket.ts:71-168` | `tokenBucket(options): Strategy<TokenBucketState>` | State `{tokens, last}` (fractional). Lazy refill; `%.17g` in Lua for exact round-trip. |
| `quota` | `src/algorithms/quota.ts:149+` | `quota(options): Strategy<QuotaState>` | Period boundaries recomputed from `now` alone; calendar math embedded in both JS and Lua. |
| `DecisionEvent` (tap) | `src/observability/tap.ts:24-37` | `{ key; cost; decision; strategy; durationMs; kind }` | Sync, O(1), in the decision path. `kind` distinguishes batch from single. **`durationMs` is wall-clock — NOT usable for replay.** |
| `admissionTap` | `src/admission/tap.ts:94-145` | `admissionTap(admitter, onAdmission)` → `{ key, cost, value, decision, bindingAxis, lane, durationMs, kind }` | Sync, O(1), exception-swallowed. `durationMs` from `performance.now()`/`Date.now()` (non-deterministic). |
| `RingBuffer<T>` | `server/src/monitor/ring.ts:10-53` | `push / toArray / size / clear` | Fixed-capacity O(1) push, oldest evicted when full. Holds `recentDenials` (default 200), fences, latency samples. |
| `LensDenialRow` | `server/src/monitor/types.ts:90-102` (reader 3 cites `:91`) | `{ at; policy; key; lane?; allowed; decision; perAxis? }` | `at` is hub-clock epoch-ms (exact). `key` is raw PII. `perAxis` carries multi-axis breakdown. |
| `LensHub` / `createLensHub` | `server/src/monitor/hub.ts:100-252` (interface at `:74`) | `trackLimiter/trackAdmitter/trackGuard/trackStats/recordFence/setHealth/snapshot/subscribe` | In-process, no persistence — all ephemeral. `snapshot()` O(size) off hot path. Clock injectable (defaults `systemClock`). |
| `testkit` conformance | `src/testkit/index.ts:112-174` | `runStoreConformance(name, setup, harness)` | `StoreTestContext` exposes `advance(ms)` for clock control; time-travel capable. Existing `./testkit` subpath export at `package.json:259-268`. |
| `ManualClock`+`MemoryStore` | (composed) | — | Together yield full in-process determinism. With `systemClock`+`MemoryStore`, only partially deterministic (sync store, wall-clock time). |

### 1b. Token-relevant primitives (#282)

| Primitive | Anchor | Signature / shape | Notes |
|---|---|---|---|
| Cost axis (unified) | `src/admission/unified.ts:19-20` | `cost?: Limiter` | Third axis (rate/concurrency/cost). Sequential `concurrency → rate → cost` (first deny short-circuits) or Lua-fused rate+cost. |
| `UnifiedAdmitter` | `src/admission/unified.ts:273-723`; lane fields `:136-146` | `unifiedAdmission(options): UnifiedAdmitter`; `{ bindingAxis?: 'rate'|'concurrency'|'cost'; policyDenied? }` | `bindingAxis` = first denying axis (undefined when allowed). `policyDenied` = joint-LP bid-price rejection. Warm-up Map iteration at `unified.ts:520` (`[...st.buckets.values()]`) — v8 insertion-order. |
| `tokenBudget` meter | `src/admission/index.ts:716-781` | `{ debitSync(tokens?); debit(); remaining(); reset() }` | Single-process streaming post-hoc cost meter. Stop-at-boundary: admit iff `served < L` before debit; overshoot ≤ tokens−1. Epoch-aligned window. |
| `distributedTokenBudget` meter | `src/admission/distributed-budget.ts:140-255` | `{ debit(tokens?); debitSync(tokens?); remaining(); reset() }` | Atomic fleet-wide RMW against shared `Store`. Window rolled server-side on Redis (skew-proof). **No `forecastSync` (async store).** |
| `WeightedFairEscrowStats` | `src/twotier/weighted-fair-escrow.ts:173-194` | `{ windowStart; limit; effectiveLimit; pool; totalUsed; tenants: [{tenant, weight, used}] }` | Per-tenant fair share `gᵢ = ⌊wᵢ/W·L_eff⌋`, work-conserving. `effectiveLimit` = L in L1-only; lazily-leased in L2. Surfaced to TUI via `LensStatsSnapshot` kind `'wfe'`. |
| `Forecast` | `src/core/types.ts:84-92` | `{ spendableNow; nextReplenishAt; fullAt }` (epoch-ms) | Non-mutating capacity readout. `forecastSync` sync-stores-only; `forecast` any store. **Admitters expose NO Forecast.** |
| `AdmissionAnalyticsSnapshot` | `src/admission/analytics.ts:55-76` | `{ ...; deniedByLane: Record<'rate'|'concurrency'|'cost'|'policy', number>; topDenied; topDeniedByLane }` | Per-window denials partitioned by lane. **Invariant: Σ deniedByLane === denied** (per `research/lens/DESIGN.md:46-72`); each denial attributed to exactly one lane. |
| `withAdmissionAnalytics` | `src/admission/analytics.ts:173-275` | `(admitter, options): AdmissionAnalyticsAdmitter` | Epoch-aligned window + Space-Saving top-K. **PII: keys observed per lane, no redaction.** |
| `withAnalytics` | `src/analytics/index.ts:177-299` | `(limiter, options): AnalyticsLimiter` | Per-window allow/deny + Space-Saving top-K (O(topK)). `StreamSummary.top()` at `:150` deterministic (sort by count+key). **PII: keys unredacted.** |
| `LensSnapshot` | `server/src/monitor/types.ts:119-128` (reader 2 cites `:120`) | `{ meta; policies; guards; stats; recentDenials; recentFences?; health? }` | Point-in-time per frame. **No time-series / history vector.** |
| `LensPolicySnapshot` | `server/src/monitor/types.ts:39` | `{ name; kind:'limiter'|'admitter'; strategy?; axes?; analytics; limit?; latency?; forecast?; forecastUnavailable?: 'async'|'idle'|'unsupported' }` | Carries lane analytics (admitter) or simple analytics (limiter). `forecast` absent for admitters. |
| `capacityBody` (TUI) | `server/src/monitor/render.ts:446-491` | `capacityBody(snap, cols): Line[]` | Per-policy hottest-key forecast: spendable-now / +1-in / full-in. ETAs anchored to `snap.meta.generatedAt`. Renders `n/a` for async store / admitter / idle. |
| `CountMinSketch` | `src/sketch/index.ts:44-204` | `add / estimate / mergeSnapshot` | Deterministic (seeded FNV-1a). `mergeSnapshot` supports merge but **no proto message** (fleet only). |

---

## 2. Determinism model

**Core claim (agreed across readers 1, 4):** every decision transition is a pure function `(state, now, cost) ↦ {state, Decision}`. The *only* source of wall-clock nondeterminism is `Clock.now()`. Under `ManualClock` + a synchronous store (`MemoryStore`, `applySync`), bit-exact replay is achievable. The five `Decision` fields are integers, so JS and Redis Lua paths are bit-identical by design.

**Conditions required for bit-exact replay:**
1. **`ManualClock` only.** A trace recorded under `systemClock` (wall-clock) is non-reproducible. The limiter spec must record which clock was used.
2. **No server-side clock substitution.** Redis Lua may use `redis.call('TIME')` (server CLOCK, `now=0` in buildArgv / `LUA_NOW` preamble, `src/core/types.ts:102-119`) instead of the passed `now`. A trace recorded against server time diverges under `ManualClock`. Capture which clock the recording used.
3. **No uninjected randomness.** Only `adaptiveThrottle` carries optional randomness — `random?: () => number` (`src/admission/index.ts:38-121`, also cited `:58`), default `Math.random`. Replay must inject a seeded PRNG or exclude adaptive throttle. Even seeded, cross-engine PRNG sequences may differ — **fail-fast if random is uninjected under replay.**
4. **Single-threaded, synchronous tape/playback.** Original concurrent races (async store interleaving) are not precisely reproducible; admission `perAxis` may capture stale state under concurrency (`src/admission/tap.ts:50`). Document replay as single-threaded.
5. **Fresh / reset state baseline.** Replaying against a warm limiter diverges; `reset()` all keys, rebuild from spec, or snapshot pre-replay state as a baseline.
6. **Stable Map iteration.** `multi.ts:68-91` (Decision combining) and `unified.ts:520` (warm-up `buckets.values()`) rely on v8 insertion-order — an engine-dependent assumption, **not** an ES guarantee. Sort by dimension/key before combining, or document the v8 dependency.
7. **Exclude wall-clock duration.** `DecisionEvent.durationMs` / `admissionTap.durationMs` use `performance.now()`/`Date.now()` — never use for logic or comparison.
8. **Lua script version pinning.** Redis caches Lua by SHA1; a script bug-fix makes old traces diverge against the new script. Record script SHA1/version in trace metadata.
9. **Composite boundary.** `twoTier`, `multi`, and unified admission produce synthetic combined decisions; replaying a leaf strategy's decision will not reproduce the composite. Record/replay at the composite boundary.

**Known FP hazards (reader 4):** token-bucket refill (`tokens += elapsed * refillPerMs`), GCRA `inc=T*cost`, quota period math, joint-LP duals. All must round-trip identically through Lua doubles; ULP drift may diverge after many epochs. `%.17g` formatting and consistent `tonumber()`/`math.floor()` are the existing mitigations — verify via cross-store (memory vs Redis) tests before shipping.

---

## 3. Security & PII surface

- **Untrusted keys are PII and never redacted by default.** `LensDenialRow.key` (`server/src/monitor/types.ts:90-102`), `DecisionEvent.key` (`src/observability/tap.ts:24-37`), and the analytics recorders (`withAnalytics`, `withAdmissionAnalytics`) all pass the raw rate-limit key (IP / API key / user ID / tenant ID) through unredacted. Recording a trace creates an audit trail of customer identities (GDPR/privacy exposure).
- **Map bounds / unbounded growth.** WFE `activeSet` and per-tenant state grow without limit if `l1.maxKeys` is unset on untrusted tenant input. Analytics top-K is a *global* `topK` cap (`StreamSummary.capacity`), **not** a distinct-key cap — there is no per-tenant key bound today.
- **`RingBuffer` overflow is silent.** `recentDenials` default 200 (global `recentLimit`, not per-policy); under high denial rate, old trace data is silently evicted with no viewer warning.
- **Tenant isolation.** A single hub snapshot mixes denials from multiple customers. If replay or the Control Room is exposed as a multi-tenant service, traces must be scoped per tenant and never cross-mixed. Cost axis is keyed on any string — **no tenant metadata on the Limiter/tap**, so attributing cost denials to tenants requires replicating the key→tenant mapping.
- **Redaction / opt-in needs (genuine gaps):** automatic key redaction/hashing in analytics + denial feeds; opt-in recording control (recordings are always-on whenever analytics/taps are used — no per-key/per-tenant disable flag); per-policy/per-tenant bounded retention; encrypt traces at rest + redact keys in human-readable diffs + bounded trace retention.

---

## 4. Integration surface

### 4a. Adding a new TUI view (server-internal, no core change)

All in `server/src/monitor/render.ts` (pure) + driven by `server/src/tui.ts` (impure shell). Pattern (reader 3):
1. Add a literal to the `TabId` union — `render.ts:23` (`"overview" | "latency" | "fairness" | "capacity" | "guarantee"`).
2. Add an entry to the exported `TABS` array — `render.ts:30` (`{ id, label }`, in cycle order). Keys **1-5 / Tab / Shift-Tab** auto-bind to `TABS` index; `tabStrip()` at `render.ts:261` renders the bar.
3. Write a `*Body(snap: LensSnapshot, cols: number): Line[]` builder (peers: `latencyBody:285`, `fairnessBody:344`, `capacityBody:446`, `guaranteeBody:515`). Return **unclamped** `Line[]`.
4. Add a dispatch case in `renderFrame(snap, opts): string[]` — `render.ts:706` — which clamps each line to exactly `opts.cols` via `clamp()` (`render.ts:115`) and emits exactly `opts.rows` lines.

Contract: **width invariance** — every emitted line must equal `cols` after clamp; verified by `render.test.ts:115-129` across terminal sizes (≥20×6 / ≥24 cols min). Bodies must coerce malformed data and never throw. `ViewState` (`render.ts:39`: `{ scroll; paused; tab }`) is the only mutable state, owned by `tui.ts`. `runTui(hub, opts)` (`tui.ts:45`) paints ~4×/s from `hub.snapshot()`; `canRunTui()` (`tui.ts:15`) gates on TTY.

If the view needs new data: bump `MONITOR_VERSION` (`hub.ts:46`, currently `"0.2.0-experimental.2"`) and extend the snapshot shape (`LensMeta:19` / `LensPolicySnapshot:39` / a `LensStatsSnapshot:83` source via `hub.trackStats(name, kind, read)`). Custom-stat rendering is hardcoded per `kind` (e.g., `fairnessBody` coerces `kind='wfe'`) — **no registry/dispatch for custom stats kinds.**

### 4b. Adding a new server config block

All in `server/src/config.ts`; pattern (reader 3):
1. Add an optional field to `ServerLimiterSpec` — `config.ts:127` (peers `twoTier?` / `tokenBudget?` / `concurrency?` / `fairEscrow?`).
2. Define the `*Config` interface (peers `TwoTierConfig:56`, `TokenBudgetConfig:70`, `ConcurrencyConfig:86`, `FairEscrowConfig:111`).
3. Add the spec field name to the **mutually-exclusive guard** at `config.ts:198-204` (rejects specs declaring >1 kind block) and add a dispatch arm to the **first-match-wins** multi-block guard at `config.ts:206-218`.
4. Write a `build*` factory (peers `buildTwoTier:242`, `buildMeter:282`, `buildAdmitter:307`, `buildFairEscrow:348`) returning the appropriate policy object.
5. Register output into the right `ServiceConfig` record namespace (`config.ts:150`: `limiters / meters / admitters / guards / fairness`), built by `buildServiceConfig(text, options)` (`config.ts:177`). Service dispatch lives in `createRateLimiterService` (`server/src/service.ts:193`) against `RateLimiterService` (`service.ts:132`); `wireMonitor()` (`server/src/monitor/wire.ts:26`) taps every policy into a fresh hub.

**Hazard:** if you forget step 3's exclusivity list, two blocks can be declared and the second is silently dropped (first-match-wins). `server/` is a separate package (`throttlekit-server@0.1.0-experimental.7`, depends `throttlekit@1.1.0`) — both features are server-internal + testkit, **no core package change** unless the core must emit new data.

---

## 5. Net-new work required, per feature (genuine gaps only)

### #281 What-If Replay
- **`DecisionRecorder`** — tap/decorator hooking `DecisionEvent` (`tap.ts`) that appends the canonical `{key, cost, at, decision, strategy, policyName}` to a bounded ring. Must capture at the exact decision-emit moment, O(1), FIFO-drop-oldest, exception-swallowed.
- **Trace serialization format** — durable per-policy schema `{at, key, cost, decision, preState?}`; discriminate polymorphic strategies by `strategy.name`; serialize `Decision` identically across JS/Lua.
- **Limiter spec / policy fingerprint** — serializable `{strategy, strategyOptions, store:{type,config?}, clock:'system'|'manual', prefix}`. Config loader exists (`throttlekit/config`) but needs export. Must also record which optional methods (`peek`/`forecast`) are available, and the Lua script SHA1/version.
- **`LimiterRebuilder`** — reconstruct a `Limiter` from a spec (strategy name → factory; store type → ctor; clock → `ManualClock` for replay), covering all factory signatures (gcra, tokenBucket, quota, fixedWindow, slidingWindow, slidingWindowLog, leakyBucket).
- **`ReplayEngine`** — drive `checkSync` in deterministic order with `ManualClock`; group same-`at` keys into `checkManySync`/`checkMany` to preserve one timestamp per batch (handle `DecisionEvent.kind`); replay non-consuming `peek`/`forecast` calls and verify without advancing state; return `{actual, expected, mismatches}`.
- **Divergence reporter** — per-key actual-vs-recorded deltas on `allowed/remaining/resetAt/retryAfterMs`; highlight determinism violations.
- **Golden-trace storage** — keyed by `{policyName, dateRange}`.
- **What-If policy builder** — config-delta DSL ("same as prod but limit=200") feeding `LimiterRebuilder`.
- **Replay player + divergence framework** — no wire format for divergences (per reader 4); build as testkit harness / ad-hoc TUI. New testkit primitives `DecisionRecorder`/`DecisionReplayer` go in `src/testkit/` (auto-exposed via `./testkit` subpath), marked `@experimental` (`STABILITY.md:64-83`). They read/write only stable types (`Decision`, `Forecast`, `ManualClock`) → composition-safe, no core change.

### #282 Token-Budget Control Room
- **Per-tenant burn-rate accumulation** — cost/tokens-per-second over time (rolling multi-window or window-boundary deltas). Today only current-window total + per-tenant `used` exist in WFE stats; **no historical series**.
- **ETA-to-exhaustion projection** — extrapolate from burn-rate + remaining; requires a time-series of `remaining` deltas / cumulative burn.
- **Time-series retention in the hub** — `LensSnapshot` is point-in-time with no history vector; need a ring of prior-window totals per policy / per-tenant cumulative burn.
- **Per-tenant cost decision tap** — today the tap identifies the *lane* but not the per-tenant cost breakdown; need a key→tenant mapping to attribute cost denials to tenants (no tenant metadata on the cost-axis Limiter today).
- **Cost-axis fair-share rollup view** — per-tenant WFE stats + cost-lane denial breakdown + per-tenant burn-rate. Hub carries per-*policy* cost denials but not per-*tenant*.
- **Dedicated Control Room panel** — new tab/sub-pane: burn-down bar, per-tenant allocation+usage (guaranteed − used + borrowed ledger), projected ETA-to-zero, approaching-fair-share warnings, hot-spot heatmap. `capacityBody` does a *single-key* forecast only; Control Room is multi-tenant, multi-window. Render-only against existing snapshot fields **once** the time-series/per-tenant data above is added — plus a cost-lane drill-down UI on `topDeniedByLane.cost`.

---

## 6. Freeze / constraint guardrails

- **Do NOT touch the wire.** The gRPC service door `wire/throttlekit.proto:1-172` is **frozen**: `Decision` tags 1-5 frozen, tags 6-15 reserved for additive optional attributes. Both features are explicitly **in-process only** (testkit + TUI) and do **not** access the proto or the unfrozen raw-Lua wire. There is no replay/token-debit-record message in the proto, and none should be added. The `Debit` RPC is synchronous window-based, not post-hoc async — the Control Room must synthesize from `Debit` + cost-axis analytics, not a new RPC.
- **Per memory + reader 5:** do NOT freeze the API/wire without explicit reauthorization (DR-14; Polyglot/wire-freeze #78 deferred). Any fleet-global aggregation (#283/T8 — cross-node cost merge via CMS snapshots) is a deferred follow-up that *would* touch the wire and must carry its own wire-freeze decision. The Token Control Room ships **single-node-safe**; state whether it is single-node-only or composition-ready for a future fleet merge.
- **TALE engineering-framing guardrail.** Per `research/dashboard/ROADMAP.md:110-115` and the auto-memory: the TALE/GALE research is embargoed until arXiv. Control Room copy and TUI text must stay **purely engineering** — describe the mechanism (per-tenant ledger, fair-share borrowing, cost-lane attribution, burn-down forecast, ETA) but make **no** claims about "optimal", "learned", "predict", "regret", "theoretical bound", "work-conservation proof", or "learned reservation optimal quantile", and do not cite or hint at the paper (local at `research/paper/DRAFT.md`). Update with citations only post-publication.
- **Fair-share honesty.** Do not overstate guarantee fairness — borrowing is real; the ledger must show `(guaranteed − used + borrowed)`. WFE in the current server config is **L1-only** (`buildFairEscrow` is single-process, no L2 store), so fleet-global fair-share is meaningless today and must say so. `effectiveLimit` equals L only in L1-only mode.
- **Control-path safety.** Any new `trackXyz()` tap / `trackStats` `read()` thunk must be O(1), never throw (hub swallows), and never do expensive sync work (file I/O, crypto, `HGETALL`) — it runs inside every decision and is invoked every ~250ms frame paint.

---

## 7. Flags — contradictions & UNVERIFIED anchors

**Line-number discrepancies on shared primitives (same file, readers disagree on exact line):**
- `LensDenialRow` — `server/src/monitor/types.ts:90-102` (readers 1, 4) vs `:91` (reader 3). Treat the range `90-102` as authoritative; **start line UNVERIFIED between 90/91.**
- `LensSnapshot` — `server/src/monitor/types.ts:119-128` (reader 2) vs `:120` (reader 3). Range vs single-line; **UNVERIFIED exact start.**
- `LensHub`/`createLensHub` — `hub.ts:100-252` (reader 1) and `:100-145` (reader 4) cite the *factory*; reader 3 cites the *interface* at `hub.ts:74`. Not a contradiction (factory vs interface), but the factory end-line (`145` vs `252`) is **UNVERIFIED**.

**Version stamps (not a contradiction, two different artifacts):**
- `MONITOR_VERSION = "0.2.0-experimental.2"` (`hub.ts:46`, reader 3) is the *snapshot/dashboard* version.
- `throttlekit-server@0.1.0-experimental.7` (`server/package.json`, reader 5) is the *server package* version. (Memory notes the last *published* server release as `0.1.0-experimental.6` — local `.7` is ahead/unreleased; harmless here.)

**UNVERIFIED / partial anchors flagged by the readers themselves:**
- `gcra.ts:64-158` — reader 1 notes "first 100 lines show constructor and check signature"; the `check` body beyond ~line 100 is **inferred, not fully read**.
- `quota.ts:149+` — "constructor only visible"; `check` body **UNVERIFIED**.
- `token-bucket.ts:71-168` — "constructor and check visible to line 100"; remainder **UNVERIFIED**.
- `src/core/types.ts` for Decision/Forecast — reader 5 says "verified in `index.ts` exports:13-27", i.e., confirmed via the barrel re-export, not the `types.ts` definition directly. The `types.ts:22-33` / `:84-92` anchors come from readers 1-2-4 and are consistent.
- `multi.ts` Decision-combining Map iteration at `lines 68-91` / `combine function line 68` (reader 1 hazards) — file path `src/.../multi.ts` not fully qualified by the reader; treat the **path as UNVERIFIED** (line range cited consistently).
- `adaptiveThrottle` random injection cited as both `src/admission/index.ts:38-121` (reader 4) and "line 58" (reader 1) — same option, **exact line UNVERIFIED.**

**No substantive contradictions** on the load-bearing facts: all five readers agree that (a) determinism reduces to the injected `Clock`, (b) keys are raw PII, (c) admitters expose no `Forecast` and the snapshot carries no time-series, (d) the proto is frozen and untouched by both features, and (e) both features are server-internal + testkit with no required core change.