# #282 — LLM Token-Budget Control Room — Implementation-Ready Design Note

## 1. Thesis and the honest delta

The Token-Budget Control Room is a server-internal TUI view plus one bounded, snapshot-time hub accumulation and one opt-in server config flag, all confined to `server/src/**`. It answers a single operator question for the **cost axis**: *which tenant is draining its per-window token budget, how fast, and — within this window — when does it hit its share-floor.* Everything renders off the limiter that is already making the decision (`WeightedFairEscrowStats`, the one source with a real per-tenant roster), so the readout is the *enforcing* ledger, not a billing export. The architecture-first **D-spine** governs: a typed additive snapshot extension computed at `snapshot()` time, a pure-render view, the existing `trackStats` door reused (no new hub method), and every honest degradation encoded as a *typed field* so the renderer structurally cannot over-claim. Onto that spine we graft the one capability D under-specified — A's correct sub-window burn-rate math and its **mandatory ETA-capped-by-window clamp** — plus B's borrowing-honesty rendering and C's enforced-vs-observed and key→tenant discipline.

**What this view adds (the cost axis, stated as engineering).** Live burn-down is table stakes; this view does **not** claim to invent it. The three things it adds beyond a post-hoc spend readout are: (a) **binding-axis attribution on cost** — denials are partitioned to the lane that actually bound the request (`deniedByLane.cost`, `analytics.ts:68-75`) rather than mixed into one refusal count; (b) **fair-share-on-cost** — a per-tenant `guaranteed − used + borrowed` ledger from the work-conserving escrow (`weighted-fair-escrow.ts:173-194`); (c) **same-oracle enforcement** — the numbers come from the meter that denies, so an "enforced" reading is real, not observed-after-the-fact.

## 2. Goals and non-goals

**v1 goals.** (1) A `Cost Room` tab that renders, per opted-in `fairEscrow` policy: per-tenant `used / guaranteed (+borrowed)`, a window-aware burn-rate, and a within-window ETA. (2) The view is **pure render** over a new optional snapshot field; all math runs once at snapshot time. (3) Every degradation (warming, async, single-node, L1-only, window-too-short, no-paired-admitter) is a typed field the renderer echoes verbatim. (4) Default-on for any `fairEscrow` policy (universal-safe; empty-state otherwise), explicit opt-out. (5) Zero core change, zero proto change, zero decision-path tap.

**Non-goals / deferred, with reason.**
- **Fleet / cross-node rollup** — needs cross-node merge (CMS snapshots) which would touch the **frozen wire** (CODEBASE-SURFACE.md:138-139); that is #283 and carries its own wire-freeze reauthorization. The `scope` field is a **literal `"single-node"`** so adding `"fleet"` later is purely additive.
- **Plain `tokenBudget` meter source** — `tokenBudget` is a single global counter with **no per-tenant map and no `stats()`** (`admission/index.ts:716-781`), and meters are *served untapped* (`wire.ts`). There is no per-key surface to enumerate. Deferred as a follow-up requiring net-new plumbing (§7).
- **`distributedTokenBudget` source** — its `remaining()` is `Promise<number>` (`distributed-budget.ts:140-255`), i.e. **async**; a synchronous snapshot thunk cannot read it. Deferred; named explicitly in the honesty matrix (§3).
- **Cost-lane denial attribution as a shipping feature** — the cost lane is **structurally dark on the server today** (see §3 NET-NEW note and the blocker in §8). v1 ships the `costDenied`/`topCostKeys` fields as *optional-absent*, rendering "cost lane not configured", not an always-empty panel.
- **Per-window history ring / heatmap, drill-down interaction, key redaction beyond status quo, persistence** — YAGNI for v1; seams left for additive grafts (§7).

## 3. The data model

### NET-NEW vs REUSED

**REUSED (no new accumulation):**
- `WeightedFairEscrowStats` `{windowStart, limit, effectiveLimit, pool, totalUsed, tenants:[{tenant,weight,used}]}` (`weighted-fair-escrow.ts:173-194`) — the only per-tenant roster, already tapped via `trackStats(name,'wfe',read)` for the Fairness view.
- The fair-share floor `gᵢ = ⌊wᵢ·L_eff/ΣW⌋` — computed exactly as `fairnessBody` does (multiply-then-divide, bit-identical to the core).
- Cost-lane analytics `deniedByLane.cost` / `topDeniedByLane.cost` (`analytics.ts:68-75`), invariant `Σ deniedByLane === denied` — read off the admitter's existing `analytics()` accessor. **NET-NEW correctness note:** these fields exist and are typed but are **always 0 / empty on the server today**, because `buildAdmitter` (config.ts:307-342) assembles `unifiedAdmission({concurrency, rate?})` and **never passes a `cost:` Limiter**. So this is a *dark* field, surfaced as optional-absent, not a populated drill-down (see §8 blocker).

**NET-NEW (the only new accumulation):**
- A **bounded per-tenant burn ring** — a fixed-capacity ring of `(at, used)` samples per (policy, tenant), wrapping the existing `RingBuffer` (`ring.ts:10-53`), updated once per frame inside `snapshot()`.
- An **ETA projection** derived from that ring, **capped at the window edge**.

### The math

**Burn-rate (graft from A — the gold-standard estimator; reject B/C's per-window-terminal model).** WFE `used` is *cumulative-this-window* and resets to 0 at `windowStart` roll (`windowStart = floor(now/windowMs)·windowMs`). The estimator is a sub-window sampler:

1. Each frame, compute `windowStart` from the live stats. If it advanced since last sample → **reset the ring** (clear, set `lastUsed = 0`): the cross-boundary delta is discarded, never read as negative burn.
2. `deltaUsed = max(0, used − lastUsed)` (negative delta = boundary race → discard); push `(now, deltaUsed)`; set `lastUsed = used`.
3. **Robust rate (graft from A, replacing D's bare two-endpoint):** `rate = Σ ring.deltaUsed / ((newest.at − oldest.at)/1000)` over the ring's *retained* span — the Prometheus `rate()` smoothing, which kills single-frame jitter and is self-correcting under ring eviction because the denominator is the real retained span, not a nominal `N·interval`.
4. `rate` is `null` (→ `n/a`) when `< 2` samples, or retained span `< minSpanMs` (default 1000), or `used` decreased without a window roll.

**ETA-to-exhaustion — honest linear extrapolation, with the load-bearing clamp.** `etaSec = remaining / rate` when `rate > 0`; `null` (→ `—`) when `rate == 0` (idle) or headroom unbounded. `etaToZeroAt = generatedAt + etaSec·1000`, anchored to `snap.meta.generatedAt` exactly like `capacityBody`. **MANDATORY invariant (graft #1 elevated to non-negotiable):** both `tokenBudget` and WFE budgets refill at `windowStart + windowMs`, so any `etaToZeroAt` beyond the window edge is a *false* number — the budget resets before it is reached. Therefore `etaCappedByWindow: boolean` is a **required typed field**: when `etaToZeroAt > windowStart + windowMs`, the renderer prints `(resets in Ns)` instead of the raw ETA. An uncapped ETA on a windowed budget is a dishonesty, not a math nit; this is the single load-bearing correctness guard.

**Per-tenant "remaining" is scoped honestly (must-fix, TALE-skeptic).** WFE exposes no per-tenant `remaining` — only `{tenant,weight,used}`. Because WFE is work-conserving, a tenant's real headroom is neither `guaranteed − used` (it can borrow idle surplus) nor the whole pool (it can be reclaimed). So **v1 does not render an unqualified per-tenant "exhausts in Ns" headline.** Per-tenant rows show the **ledger** (`used / guaranteed / +borrowed`) and a per-tenant burn-rate; the only true exhaustion ETA is **policy-level pool ETA** = `pool / Σ rate`, which is a real number (the shared budget genuinely hits zero). A per-tenant "eta to your guarantee floor at current burn (borrowing not counted)" may be shown only with that exact qualifier and the borrowed column visible.

**Fair-share ledger (graft from B's rendering/copy).** `guaranteed = gᵢ`; `borrowed = max(0, used − guaranteed)`, surfaced as an explicit `+N`, **never folded into `used`**. Borrowing is real and bounded (`Σ used ≤ L`); copy says "borrowing +N", never "over limit". Reserved headroom of a paused high-weight tenant is rendered as held (gray), so a starved guarantee is visibly retained, not silently lent. **Stability caveat (must-fix, data-model skeptic minor):** `gᵢ` is recomputed every frame from live weights, so `guaranteed`/`borrowed` are *functions of current weights*, not accumulated quantities — a mid-window reweight reframes past usage. The column is labeled "borrow (at current weights)" so the operator knows it is a live recomputation.

### Honest degradation (typed, not commented)

| Condition | Source signal | Typed field → render |
|---|---|---|
| Async store (`distributedTokenBudget`) | not a sync snapshot source | not wired in v1; rendered "async store — n/a" only if ever surfaced |
| Single-node | `scope: "single-node"` literal | header chip "single-node", always |
| L1-only fair-share | `fairShareReliable: false` (always in v1; `buildFairEscrow` is single-process, config.ts:348) | "fair-share: process-local" caveat |
| `< 2` samples / span `< minSpanMs` | `burnPerSec: null` | "burn n/a (warming)" |
| Window too short for burn | `burnReason: "window-too-short"` when `windowMs < ~N·minSpanMs` | "burn n/a (window < ~1.3s)" — not perpetual "warming" |
| No rate / unbounded headroom | `etaToExhaustMs: null` | "ETA —" |
| ETA beyond window edge | `etaCappedByWindow: true` | "(resets in Ns)" |
| No paired cost-axis admitter (always, today) | `costDenied`/`topCostKeys` absent | "cost lane not configured" — panel hidden, not zeroed |
| Per-window, not lifetime | `windowStart` in header | "this window"; never "total spend" |

**Degradation taxonomy correction (must-fix, data-model skeptic).** "Admitter has no Forecast" is *true* but is **not** why this view degrades — the burn/ETA source is WFE `used`-deltas, not `Forecast`. The real n/a triggers are exactly the rows above: WFE `< 2` samples (warming), window-too-short, idle (rate 0), and the deferred async/meter sources having no synchronous per-tenant surface. "No Forecast" is removed as a headline reason.

## 4. Architecture and API surface

### Bounded hub accumulation (`server/src/monitor/burn.ts`, new)

`TenantBurnRing` wraps `RingBuffer<{at,used,deltaUsed}>` (cap ~16): O(1) `push`, span-based `rate()` returning `number | null`, never throws. `BurnAccumulator` holds a per-tenant insertion-ordered `Map` with **its own `maxKeys`** independent of WFE's `maxKeys` — *doubly bounded*: WFE's `maxKeys` (default 100_000, config.ts:373) bounds which tenants exist; the accumulator's `maxKeys` bounds how many get a time-series. Eviction (must-fix, scale skeptic): **rank by activity (highest `used`) and bound to the render candidate set + headroom**, not arbitrary FIFO/256 — so the tenants actually shown always have a warm ring, eliminating the "256 of 100k → permanent warming flap" pathology. Stated memory bound: `accumulatorMaxKeys × ringSize × ~24B`. Dead tenants (absent from successive snapshots) are dropped on the next sweep.

### Snapshot extension (`types.ts` — additive, optional)

```
LensTenantBurnRow {
  tenant: string                 // PII; single redaction point (§5)
  weight, used, guaranteed, borrowed: number
  burnPerSec: number | null
  etaToExhaustMs: number | null
  etaCappedByWindow: boolean     // REQUIRED — the load-bearing clamp
  burnReason?: "warming" | "window-too-short" | "idle"
}
LensCostRoomSnapshot {
  policy: string
  windowStart, limit, effectiveLimit, pool, totalUsed: number
  scope: "single-node"           // literal, not boolean
  fairShareReliable: boolean     // false in L1-only (always, v1)
  unit: "tokens" | "requests" | "units (cost)"   // declared, echoed verbatim (§3 must-fix)
  enforced: boolean              // this WFE policy IS enforcing → true
  poolEtaToZeroAt?: number       // policy-level pool ETA (the real exhaustion number)
  costDenied?: number            // absent today (cost lane dark)
  topCostKeys?: Array<{ key: string; count: number }>  // absent today
  tenants: LensTenantBurnRow[]
}
```
Envelope: add `costRooms?: LensCostRoomSnapshot[]` to `LensSnapshot` (types.ts:119-128) — optional, absent when no policy opts in, so every existing consumer is untouched. Bump `MONITOR_VERSION` (hub.ts:46, `"0.2.0-experimental.2"`) — additive-optional, old binaries ignore it.

**Unit honesty (must-fix, data-model skeptic).** WFE does not know whether `cost` carries tokens or the default `cost=1` per request. The header label is **declared by config and echoed verbatim** — never hard-coded "tokens". Default label when undeclared: "units (cost)".

### Hub population (`hub.ts`) — reuse the `trackStats` door, no new method

**Graft conflict resolved (must-fix, TALE-skeptic):** take A's *math*, not A's *method*. Register through the existing door — either `trackStats(name, "cost-room", read)` directly (the `customStats` array, hub.ts:188-190) or a thin typed `trackCostRoom(name, read, opts)` wrapper that pushes into the same array. **Do NOT add a peer `trackBurn` hub method** — it would widen the `LensHub` interface and `wire.ts` surface for zero functional gain. All accumulation lives in `snapshot()` (hub.ts:208-243), which paints ~4Hz off the hot path; the decision path gains **zero** instructions. The new block, after the `stats` map:

```
for each registered cost-room source:
  stats = safeRead(read)                         // hub.ts:351-357
  if (!stats || 'error' in stats) continue       // see error-shape guard below
  acc.sample(stats, now)                          // O(min(tenants, renderCap)) — bounded to candidates
  analytics = costAnalytics ? safeRead(costAnalytics) : undefined
  push buildCostRoom(name, stats, acc, analytics)
```

**Error-shape guard (must-fix, security skeptic).** `safeRead` returns `{ error }` on throw, **not `undefined`** (verified hub.ts:351-357). Every body and builder must narrow on `if (!stats || 'error' in stats)`, never on `!stats` alone — otherwise the truthy error object slips the guard and `stats.windowStart` etc. yield NaN into the arithmetic. `buildCostRoom` is a pure function; per-frame pass is bounded to the render candidate set (top-N by `used`), so per-frame cost is `O(renderCap ≈ 12)` regardless of WFE `maxKeys` — the "O(1) decision path" claim holds and the per-frame cost is provably bounded.

**Analytics reuse (must-fix, security skeptic minor).** The admitter's `AdmissionAnalyticsSnapshot` is already materialized per frame for the admitter policy rendering (hub.ts:221-223). The Cost Room reads `deniedByLane.cost`/`topDeniedByLane.cost` **off the existing `LensPolicySnapshot.analytics`** rather than calling `analytics()` a second time — no redundant per-frame snapshot build.

### Server config to light it up (`config.ts` / `service.ts` / `wire.ts`)

**Mutual-exclusion guard — sidestepped, not touched (must-fix, TALE-skeptic minor).** The guard at config.ts:198-204 builds `kinds` from `[tokenBudget, fairEscrow, concurrency, twoTier]` and rejects `> 1`. The Control Room is **a sub-field of `FairEscrowConfig`** (config.ts:111), not a new `ServerLimiterSpec` sibling kind — so it cannot collide with the guard and **nothing is added to config.ts:198-204**. Reject the A/C variant that adds a sibling field.

```
FairEscrowConfig {
  ... limit, windowMs, weights?, maxKeys?
  costRoom?: boolean            // default-on for fairEscrow; explicit opt-out
  costRoomMaxKeys?: number      // accumulator bound, independent of maxKeys
  costRoomRingSize?: number
  unit?: "tokens" | "requests"  // declared label, echoed verbatim
}
```

`buildFairEscrow` (config.ts:348) is unchanged for gating. In `wireMonitor()` (wire.ts:26), adjacent to the existing `trackStats(name,'wfe', () => wfe.stats())`:

```
for (const [name, wfe] of Object.entries(svc.fairness)) {
  hub.trackStats(name, "wfe", () => wfe.stats());                 // existing — Fairness
  if (cfg.fairEscrow[name]?.costRoom !== false)                   // default-on, opt-out
    registerCostRoom(name, () => wfe.stats(), { ... });           // via the same door
}
```

`registerCostRoom` derives the cost-lane analytics only if a paired cost-axis admitter shares the key — which, given the exclusivity guard, is **permanently `undefined` in v1** (see §8 blocker). State that plainly: `costDenied`/`topCostKeys` are absent by default and that is the documented v1 state, not a TODO that will silently populate.

### The view (`render.ts`) — width-invariant, pure render

Per the 4-step recipe (CODEBASE-SURFACE.md:88-94): add `"cost"` to `TabId` (render.ts:23) and `{ id:"cost", label:"Cost Room" }` to `TABS` (render.ts:30); write `costRoomBody(snap, cols): Line[]` (peer of `fairnessBody:344`, `capacityBody:446`) returning **unclamped** lines; add a dispatch arm in `renderFrame` (render.ts:706) that clamps each line to `cols` via `clamp()` (render.ts:115). The body is pure projection over `snap.costRooms` — no math, only formatting — coerces every field (`Number(x)||0`, `String(t.tenant ?? "?")`) exactly as `fairnessBody:377-384`, and narrows on the `{error}` shape. Layout per policy:

```
COST ROOM · <policy>        window 60s · resets in 12s · single-node · L1-only · units(cost)
  L 1.0M  used 740k  pool 260k          pool ETA ~88s        cost lane not configured
  tenant       used / guar (+borrow)   burn/s   eta(floor)   [────────────]
  acct-7f…     900k / 750k (+150k)↗    3,200   (resets 12s)  ██████████░░░
  acct-2a…     140k / 250k             800     ~175s         ███░░░░░░░░░░
  acct-bc…      10k / 250k             0       —  idle       ░░░░░░░░░░░░░
  … +37 more (2 approaching guarantee floor)
```

Empty/degraded states reuse the established idiom: "no cost-axis policy configured — add `costRoom` to a fairEscrow policy", "burn n/a (warming)", "(resets in Ns)". Must pass `render.test.ts:115-129` width-invariance across ≥24-col / ≥6-row, plus a degraded-state pass.

## 5. Security and privacy

- **Per-tenant maps doubly bounded** (the explicit memory-DoS-over-PII-keys defense, CODEBASE-SURFACE.md:79). WFE's `l1.maxKeys` (default 100_000, applied even when omitted, config.ts:373) bounds the source; the accumulator's own `costRoomMaxKeys` bounds the time-series and is ranked by activity + scoped to render candidates, so worst-case memory is `costRoomMaxKeys × ringSize × ~24B`, stated and advertised — not a best-case figure. No unbounded `Map` is introduced.
- **Key → tenant mapping done safely (graft from C).** For `fairEscrow`, "the request key IS the tenant" (config.ts:108) — attribution is exact and free. For any future pure cost-lane source with no `fairEscrow`, there is genuinely no tenant dimension: label the column **`key`**, not `tenant`, with the footnote "per-key (no tenant mapping configured)", and never relabel PII as a tenant. The documented path to true tenant rollup is fronting with `fairEscrow`.
- **PII posture, honestly stated.** Tenant keys (raw IP / API key / user / tenant id) flow unredacted today through Fairness and `topDeniedByLane`, and this view adds a new pane that renders them. **Single redaction seam (graft from A's discipline, must-fix security skeptic):** route every tenant/key string through one optional `redactKey?: (s)=>string` hook (identity by default) at the single point keys enter `buildCostRoom`. This costs nothing unset, matches the existing no-redaction posture, and makes a later global redaction a one-line wire-up instead of a multi-site retrofit. **Do not claim it is redacted by default** — label the posture honestly.
- **Control-path safety.** No decision-path tap; all reads are O(1) `stats()`/`analytics()` thunks invoked only in `snapshot()`, `safeRead`-wrapped (throws swallowed → `{error}` → honest skip). No file I/O, crypto, or `HGETALL`.
- **Enforced-vs-observed badge (graft from C, scoped to the real source).** A `fairEscrow` policy **is** enforcing on cost (it denies on its own `check(tenant, cost)`), so its rows carry `enforced: true`. The badge is computed from the actual v1 source, **not** from C's unified-admitter-cost-lane check (which would wrongly mark WFE-on-cost "observed only"). The cost-lane *denial* drill-down (when a paired admitter ever exists) is the part that may be "observed via analytics"; it reuses the same `pairedAdmitter` gate.
- **Tenant-isolation seam (graft from C, must-fix security skeptic).** The TUI is a single-operator local-TTY surface (`canRunTui` gates on TTY), so cross-tenant mixing is acceptable for the operator. But thread an optional `tenantScope?: string` filter (no-op default) through `buildCostRoom` so a future per-tenant customer-facing surface is an additive filter, not a rewrite. Document that `costRooms` is operator-scoped and MUST be filtered before any per-tenant exposure.

## 6. Scalability

- **Bounded rings, ranked.** Memory is fixed at `costRoomMaxKeys × ringSize × ~24B`; rings are allocated only for render candidates (top-N by `used`) so a 100k-tenant flood does not produce 100k rings. Above `costRoomMaxKeys` active tenants, only the top-N show burn/ETA; the rest show `used` only with `burn n/a` — a *deterministic* degradation tied to the rendered set, not random FIFO churn (closes judged-gap #3 and the eviction-flap minor).
- **Snapshot cost with many tenants.** The per-frame `sample()` + `buildCostRoom()` pass is bounded to `O(min(tenants, renderCap))`, so the ~4Hz paint is provably bounded regardless of WFE `maxKeys`. The decision path is O(1) and untouched.
- **Burn-ring overflow honesty (judged-gap #2, security skeptic).** The burn ring's eviction is *by design* (sliding window) and `rate()` uses the real retained span, so eviction self-corrects — no warning needed there. The genuine truncation risk is the separate `recentDenials` ring (default 200), which can silently drop during a denial storm; that is a denial-feed concern, out of scope for this view, noted as a follow-up.
- **Deferred fleet rollup.** Cross-node cost merge would touch the **frozen wire** (CODEBASE-SURFACE.md:138-139) → #283, requires reauthorization. `scope: "single-node"` literal keeps `"fleet"` purely additive.

## 7. Flexibility and adaptability

- **Across cost configurations.** v1 lights up for `fairEscrow` (the only per-tenant source). It degrades **honestly** when a source is absent: plain `tokenBudget` → no `stats()`, rendered as out-of-scope/empty; `distributedTokenBudget` → async, named as a deferred source; WFE-on-cost present but idle → `burn 0, eta —`; no paired admitter → cost-denial panel hidden. The unit label adapts to the declared `unit`.
- **Extension seams for the deferred grafts (layering, the spine's defining property):**
  - **(A) burn-down history** — swap `TenantBurnRing`'s short sample ring for a closed-window-total ring; `burnPerSec`/`eta` fields unchanged; only `burn.ts` changes.
  - **(B) ledger-over-time** — `guaranteed`/`borrowed` already typed; a cumulative-borrow field is additive on `LensTenantBurnRow`.
  - **(C) attribution drill-down** — `topCostKeys` already seeded (when a cost axis exists); the `deniedByLane` stacked bar (`Σ === denied` invariant) and per-tenant heavy-hitters are an additive second-phase panel.
  - **fleet (#283)** — `scope` literal + `fairShareReliable` flag are the seams; `used`/`burn` are additive across nodes.

## 8. Integration surface

**Exact files / seams:** `server/src/monitor/burn.ts` (new — `TenantBurnRing`, `BurnAccumulator`); `types.ts` (+2 interfaces, +1 optional `costRooms?` field); `hub.ts` (register via existing `trackStats` door / thin `registerCostRoom` wrapper, snapshot block, `buildCostRoom`, bump `MONITOR_VERSION`); `config.ts` (+4 optional `FairEscrowConfig` fields; **nothing added to the exclusivity guard 198-204**); `wire.ts` (registration adjacent to the `'wfe'` tap, wire.ts:26); `render.ts` (`"cost"` in `TabId:23` + `TABS:30`, `costRoomBody`, dispatch `:706`).

**The no-wire / no-core-hot-path guardrail (explicit invariant block):** v1 = **WFE-only source, snapshot-pass accumulation, no `wire/throttlekit.proto` change, no `src/**` core change, no decision-path tap, no meter tap, no fleet transport.** Any graft that violates this (A's plain-meter source; any fleet rollup) is a separate, separately-authorized follow-up. The two named follow-ups are the cost-meter source and fleet rollup (#283); neither lands in v1.

**Two confirmed blockers the design resolves (must-fix, data-model skeptic — verified against source):**
1. **The cost lane is structurally dead.** `buildAdmitter` (config.ts:307-342) builds `unifiedAdmission({concurrency, rate?})` and **never passes `cost:`** — so `deniedByLane.cost` / `topDeniedByLane.cost` are always 0 / empty on the server. Resolution: ship cost-denial fields as **optional-absent by default**, render "cost lane not configured", and document that the server has no cost axis today. Do **not** present an always-empty panel as cost attribution. (Lighting it requires a new `cost` config surface wiring a Limiter into `unifiedAdmission` — out of scope for v1.)
2. **A WFE roster and a cost-lane admitter can never coexist under one policy** — the exclusivity guard (config.ts:198-204) rejects declaring both `fairEscrow` and `concurrency`. Resolution: they are **separate policies, two independent panels, never joined**; `pairedCostAnalytics(name)` returns `undefined` permanently in v1, and the design says so rather than implying a join.

**TALE engineering-framing guardrail (applied to ALL UI copy, CODEBASE-SURFACE.md:140).** Mechanism words only. **Compliant:** "burn-rate", "ETA-to-exhaustion", "linear extrapolation of observed burn", "projected at current burn", "fair-share ledger", "borrowing +N", "cost-lane attribution", "work-conserving". **Forbidden:** "optimal", "learned", "predict"/"predicted"/"will", "regret", "theoretical bound", "work-conservation proof", "learned reservation optimal quantile", any "forecast *model*" claim for the cost axis (admitters expose no Forecast), and any paper reference. Note: the *noun* "forecast" is **not** scrubbed where it names the existing `Forecast` primitive or the shipped "Capacity & Forecast" view — only a forecast/prediction *model* claim on the cost axis is forbidden. No competitor-comparison in shipped copy (the readout is rendered only from data this view holds).

## 9. Phased plan (bisectable; each green before the next; ask before any tag/publish)

- **P0 — confirm + spike.** Verify on a branch: (a) the cost lane is dark (`deniedByLane.cost` always 0 server-side — confirmed); (b) tenant attribution is exact only via `fairEscrow` (key===tenant — confirmed config.ts:108); (c) a spike proving WFE `used` resets at `windowStart` roll under `ManualClock`. *Verify:* notes + a throwaway test. *Gate:* none (no shippable change).
- **P1 — types only.** Add `LensTenantBurnRow` / `LensCostRoomSnapshot` + optional `costRooms?` on `LensSnapshot`; bump `MONITOR_VERSION`. No consumer reads it → no behavior change. *Verify:* core + server typecheck. *Gate:* full-repo `npm run lint` (whole repo incl. bench/), full suite green (read a real run).
- **P2 — bounded hub burn-series.** `burn.ts` (`TenantBurnRing` + `BurnAccumulator` with A's robust span-rate + windowStart-reset + negative-delta discard + the **`etaCappedByWindow`** clamp); register via the existing `trackStats` door (no new hub method); populate in `snapshot()` under `safeRead` with the `{error}`-shape guard. *Verify:* a **`ManualClock`-across-window-boundary** unit test proving (a) burn-rate resets at the roll, (b) ETA caps at the window edge — the single mandatory correctness test. *Gate:* full suite + lint green.
- **P3 — server config to populate.** `FairEscrowConfig.costRoom`/`costRoomMaxKeys`/`costRoomRingSize`/`unit`; `wire.ts` registration default-on with opt-out; nothing touched in the exclusivity guard. *Verify:* a server integration test that an opted-in `fairEscrow` policy produces a non-empty `costRooms` after debits. *Gate:* full suite + lint green.
- **P4 — the view + grafts.** `costRoomBody` (pure render, width-invariant, `{error}`-narrowing); B's borrowing/reserved-headroom rendering; C's enforced badge + key/tenant labeling + `tenantScope?` seam; A's `(resets in Ns)` annotation. *Verify:* `render.test.ts` width-invariance across sizes + degraded states (warming, window-too-short, idle, no-cost-lane, L1-only). *Gate:* full suite + lint green.
- **Release.** #282 is design-first/pending → v1 lands as a **PR on a branch, not a publish.** Any tag/publish requires a **read** full-suite green run for **both** core and server packages, whole-repo lint, and an **explicit ask before tagging** (no standing authorization).

## 10. Honest non-claims

- We did **not** invent burn-down; live token burn-down is table stakes — our delta is binding-axis attribution on cost, fair-share-on-cost, and same-oracle enforcement.
- **Single-node only.** No fleet/global fair-share today; WFE is L1-only (`effectiveLimit === limit`), and fleet-global fair-share is meaningless across processes — the view says so.
- Burn-rate/ETA are **linear extrapolation of observed burn**, not a forecast model; the ETA is **clamped to the window edge** because the budget refills.
- The **cost-denial attribution panel is dark** until a cost axis is wired into the server admitter; v1 renders "cost lane not configured", not an empty panel dressed as a feature.
- The axis label is **whatever unit the config declares** (default "units (cost)"); we do not assume "tokens" unless the policy is fed token costs.
- **No-research-claims guardrail:** zero TALE/GALE language, zero "optimal/learned/predict/regret/bound/proof", zero paper reference anywhere in UI or docs copy.

## 11. Open questions / decisions for the user

1. **Should v1 wire a real server cost axis?** Today no config surface populates `cost:` in `unifiedAdmission`. Option (a) v1 ships WFE-only and the cost-denial panel stays dark (recommended — smallest, honest); option (b) add a `cost` config block building a `tokenBudget`-style Limiter into the admitter (a real new config/core-adjacent surface — separate authorization).
2. **`costRoom` default-on for every `fairEscrow` policy, or opt-in?** Recommended default-on (universal-safe, ~bounded memory), but confirm given the new PII pane.
3. **Declared `unit` — require it, or default to "units (cost)"?** Requiring it forces honest labeling; defaulting is more ergonomic.
4. **Redaction posture for v1 — ship the `redactKey?` seam off-by-default (recommended), or defer the seam entirely?**
5. **Name the deferred sources in copy** (`distributedTokenBudget` async, plain-meter no-stats, fleet #283) as explicit "not included" lines, or keep them only in this note?

### §11 — Decisions (locked 2026-06-05, at #292/P1; chosen for long-term flexibility)

1. **No real server cost axis in v1.** WFE-only source; `costDenied?`/`topCostKeys?` ship as **optional-absent
   seams** (cost lane structurally dark, #291 P0). Lighting a cost axis later is purely additive and is its
   own separately-authorized design — we do **not** freeze a config/wire surface under feature pressure
   (respects the §8 no-core/no-wire guardrail; keeps optionality open).
2. **`costRoom` default-on** for every `fairEscrow` policy, explicit `costRoom: false` opt-out (available-by-
   default + universal; bounded memory; empty-state otherwise). *Config field lands in P3.*
3. **`unit` is optional, default `"units (cost)"`, echoed verbatim — and FREE-FORM `string`, not a closed
   union.** An operator metering tokens / requests / credits / USD labels it honestly; never hard-code
   "tokens". *Config field lands in P3.*
4. **Ship the `redactKey?` seam, OFF by default (identity).** Single redaction point at `buildCostRoom`
   (P2/P4). Costs nothing unset, matches the existing no-redaction posture, makes a later global redaction a
   one-line change. Posture stated honestly as "not redacted by default".
5. **Name the deferred sources in copy** (`distributedTokenBudget` async, plain-meter no-stats, fleet #283)
   as explicit "not included" lines in the view/docs (P4).

**Type-design calls (P1, for long-term consistency with the existing snapshot conventions):**
- **ETA fields are ABSOLUTE epoch-ms** — `LensTenantBurnRow.etaToExhaustAt` and
  `LensCostRoomSnapshot.poolEtaToExhaustAt` — matching every other snapshot timestamp (`forecast.fullAt`,
  `nextReplenishAt`, `resetAt`, `meta.generatedAt`). This **supersedes** the §3/§4 sketch's duration form
  (`etaToExhaustMs`) and the `poolEtaToZeroAt` name: a lone duration field would be inconsistent and goes
  stale on serialize; the renderer derives "in Ns" against `meta.generatedAt`.
- `scope: "single-node"` literal (fleet seam, #283) and `fairShareReliable: boolean` (L2 seam) retained
  verbatim. `enforced: boolean` is computed from the real WFE source (always `true` for a `fairEscrow`
  policy), never from a unified-admitter cost-lane check.

**P1 landed (#292):** the two additive interfaces above + optional `LensSnapshot.costRooms?` in
`server/src/monitor/types.ts`; `MONITOR_VERSION` bumped `0.2.0-experimental.2 → .3` (additive-optional, old
binaries ignore the field). No consumer reads it yet → zero behavior change. Server typecheck + lint + full
suite (88 passed / 2 skipped) green.

## 12. Appendix — six-dimension scorecard

| Dimension | Score | Basis |
|---|---|---|
| **Robust** | 9 | Only net-new accumulation is one bounded ring/tenant; all reads `safeRead`-wrapped with the `{error}`-shape guard; `buildCostRoom` pure, guards every divide + window-roll; `etaCappedByWindow` mandatory; optional snapshot field breaks no consumer. |
| **Scalable** | 10 | Doubly-bounded rings ranked to render candidates (stated memory bound); per-frame `O(min(tenants, renderCap))`; O(1) decision path; fleet deferred behind the frozen wire. |
| **Flexible** | 9 | Typed surface; works across `fairEscrow` today, degrades honestly when a source is absent; declared unit; A/B/C grafts are additive seams. |
| **Adaptable** | 10 | `scope`/`fairShareReliable`/`unit`/`tenantScope` literals are the seams for fleet, L2, labeling, and per-tenant scoping — all additive, no rewrite. |
| **Secure** | 9 | Doubly-bounded maps over untrusted keys; single redaction seam; enforced-vs-observed from the real source; `{error}`-narrowing; no decision-path tap; tenant-scope filter seam. |
| **Planned** | 10 | Bisectable P0→P4 ladder, each typecheck/lint/full-suite green; the `ManualClock`-across-boundary test is the mandatory gate; design-first PR, ask-before-tag. |
| **Data-model soundness** | 10 | A's correct sub-window span-rate + windowStart-reset + negative-delta discard; mandatory window-edge ETA clamp; policy-level pool ETA as the only true exhaustion number; per-tenant remaining honestly de-scoped; unit not assumed; dark cost-lane surfaced as optional-absent. |
| **Honesty** | 10 | Every degradation a typed field; no-invented-burn-down delta; single-node/L1-only stated; dark cost lane named, not faked; no competitor table in shipped copy; full TALE guardrail. |

**Key files (absolute):** `C:\Users\ameya\Documents\GreenfeildProject\server\src\monitor\burn.ts` (new), `C:\Users\ameya\Documents\GreenfeildProject\server\src\monitor\types.ts`, `C:\Users\ameya\Documents\GreenfeildProject\server\src\monitor\hub.ts`, `C:\Users\ameya\Documents\GreenfeildProject\server\src\monitor\render.ts`, `C:\Users\ameya\Documents\GreenfeildProject\server\src\monitor\wire.ts`, `C:\Users\ameya\Documents\GreenfeildProject\server\src\config.ts`; source-of-truth ledger `C:\Users\ameya\Documents\GreenfeildProject\src\twotier\weighted-fair-escrow.ts`; cost-lane analytics `C:\Users\ameya\Documents\GreenfeildProject\src\admission\analytics.ts`.