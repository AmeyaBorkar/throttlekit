# ThrottleKit TUI dashboard — future panels & directions (roadmap)

Status as of 2026-06-05. The monitoring dashboard shipped as a **built-in terminal UI**:
`throttlekit-server --config … --tui` (`throttlekit-server@0.1.0-experimental.6`, live). The web
`throttlekit-lens` package is deprecated. This doc plans the deferred panels and the bigger directions, each
grounded in what the code exposes **today** vs. what is genuinely net-new.

## What ships today

Renderer (`server/src/monitor/render.ts`, `renderFrame`) panels: header · throughput + deny sparkline ·
**binding-axis hero** (rate/concurrency/cost/policy attribution — the niche no other limiter renders) · top
denied keys · concurrency health · live denial feed · status bar. The hub (`server/src/monitor/hub.ts`,
`createLensHub`) taps every limiter via `tapDecisions`+`withAnalytics` and every unified admitter via
`admissionTap`+`withAdmissionAnalytics`; taps are synchronous, exception-swallowing, O(1) — a dashboard can
never perturb the control path.

## Two facts that shape this plan

1. **The snapshot already anticipates most of these panels.** `server/src/monitor/types.ts` already defines
   and the hub already populates: `LensPolicySnapshot.latency {avgMs,maxMs,n}`, `.limit` (observed ceiling),
   the `stats[]` array (`LensStatsSnapshot`, built for WFE), `recentFences`, and `LensMode: "fleet"` /
   `meta.fleetNodes` (reserved). **They are simply not rendered.** So several "future panels" are
   render-only, or render + a thin server-side wire — not core work.
2. **Core already exposes the hard data** for most panels (verified): `WeightedFairEscrowStats`
   (`src/twotier/weighted-fair-escrow.ts:170`), `Forecast` on every strategy (`src/core/types.ts:85`, via
   `Limiter.forecast(Sync)?`), `durationMs` on taps, `ManualClock` (`src/core/clock.ts`), `MergeableSketch`
   (`src/sketch/index.ts`). The genuinely net-new core work is narrow: per-key admits-this-window, an
   overshoot-ceiling helper, a decision recorder/replayer, and a fleet transport.

## Design principles (carry into every panel)

- **Universal + on by default within the TUI.** A panel renders whenever its data source is present — no
  per-panel opt-in flags. (Matches the project's "default ON + universal" posture.)
- **Honesty in copy.** The Guarantee panel is *headroom to a known line*, never "the proof is holding".
  Forecasts degrade to "n/a" where a store can't answer synchronously. Top-K is an upper bound.
- **The server taps in-process only.** No new wire/HTTP for the single-node panels; gRPC decisions stay
  byte-identical. (Fleet, T8, is the one place a transport is reopened — see its caveat.)

---

## Near-term panels

These fit behind a new view switcher (T1) so an 80×24 terminal isn't overcrowded.

### T1 — View navigation (tabs) — *enabler*
The current layout is one vertical stack with the denial feed as the flex region; adding 4 multi-line panels
would crowd it out. Add a view switcher (number keys `1`–`5` + `Tab` to cycle), default **Overview** =
today's panels. Extend `ViewState` + `renderFrame` dispatch (`render.ts`), key handling + status-bar tabs
(`tui.ts`), width-invariant tests. No core changes. **Blocks T2–T5.**

### T2 — Latency view
Render `LensPolicySnapshot.latency` — **already populated** by the hub (`hub.ts` `withMeta`, a 256-sample
ring per policy). MVP is render-only (avg/max/n per policy). Optional: upgrade the hub ring from avg/max to a
**p50/p99 histogram** (the samples are already retained). No core changes.

### T3 — Fairness (WFE) view  — **DONE (view #278, served on the server #284)**
Per-tenant **guaranteed-share vs used vs borrowed**. Core data is ready and rich
(`WeightedFairEscrowStats`: `tenants[{tenant,weight,used}]`, `effectiveLimit`, `pool`, `totalUsed`).
- **Render (DONE, #278):** `stats[]` by `kind:"wfe"` → per-tenant bars; guaranteed = `floor(weight/ΣW ·
  effectiveLimit)` over the reporting tenants, borrowed = `max(0, used − guaranteed)`; the bar splits each
  tenant's use into green (within guarantee) + yellow (borrowed surplus). Renders from any
  `hub.trackStats(name, "wfe", …)` source (wired in the demo).
- **Finding:** in the installed `throttlekit@1.1.0`, `WeightedFairEscrowLimiter` is **not** a `Limiter`
  (it has `check`/`checkSync(tenant,cost)`/`reset`/`stats()` but no `.strategy`/`.peek`/`.checkMany`/
  `.forecast`), so it can't flow through the server's `createEnforcer` / `trackLimiter` limiter path.
- **Server source (DONE, #284):** a `fairEscrow:` config block builds a core `weightedFairEscrow` (L1-only,
  `maxKeys`-bounded) served by a dedicated fair-limiter path (route `check(policy,key,cost)` →
  `wfe.check(key,cost)`, key = tenant; wrong ops → UNIMPLEMENTED); `wireMonitor` `trackStats`-es it. The
  Fairness view now populates on the server. (L2 / fleet-shared fair budget remains a follow-up.)

### T4 — Capacity & Forecast view
Per-policy remaining + a "refilled in X ms" ETA. Core `Forecast {spendableNow, nextReplenishAt, fullAt}`
exists on every strategy. Work: add optional `forecast` to `LensPolicySnapshot`; the hub calls
`limiter.forecastSync?.(hotKey)` on snapshot for the hottest keys. **Caveat:** `forecastSync` is in-memory
only — Redis/Postgres are async and `snapshot()` is sync, so those render **"n/a"** (honest) rather than
blocking. Render remaining p50/p99 + ETA.

### T5 — Guarantee view (+ fence feed)
The flagship deferred panel — framed as **headroom to a known line**, never "proof holding". Three parts:
- **(a) Invariant chips (DONE, #280)** — per-node `inflight <= node ceiling` (`share ?? limit`) + no
  self-fence, from `snap.guards`.
- **(c) Fence feed (DONE, #280)** — renders `snap.recentFences` (was in the snapshot, never rendered).
- **Headroom (DONE, #280)** — per-guard `headroom = ceiling − inflight`, framed as headroom to the proven
  line, with the TLA+/fleet caveat in the footer.
- **(b) Admitted-vs-ceiling — DEFERRED to the Fleet view (#283).** The per-key two-tier overshoot ceiling
  `Limit + N·(B-1)` and the fleet `Σinflight ≤ L_global` are **fleet** properties: a single process only
  ever sees its own (non-overshooting) allows, so this is meaningless single-node and belongs to fleet
  aggregation.
- **Server source (DONE, #285).** `UnifiedAdmitter` exposes no guard/`stats()`, but `buildAdmitter` already
  *creates* the `adaptiveConcurrency` guard — so it now returns it, `buildServiceConfig` collects it, and
  `wireMonitor` `trackGuard`-s the same instance the tapped admitter drives. Guarantee + the Concurrency
  panel now populate on the server (no core change needed). Distributed-guard `onFenced` wiring stays a
  follow-up (the server builds local `adaptiveConcurrency`, which doesn't fence).

---

## Bigger directions (design-first; own workstreams)

Each starts with a short design note; none is blocked by T1 (they're separate tracks, though T7 would render
as a TUI view if T1 lands first).

### T6 — What-If Replay
Record a bounded ring-buffer of decisions (the hub already has `RingBuffer` and sees every decision) →
**deterministic bit-exact replay** of `(key, cost, at)` against a *candidate* policy using the exported
`ManualClock` → a divergence report (allow/deny diffs, remaining/retry deltas). The deterministic oracle is
what makes this uniquely possible. Likely a `throttlekit` **testkit** addition (`DecisionRecorder` +
`DecisionReplayer`); a TUI trigger comes later. **Not** the live click-to-snapshot drawer — this is true
replay.

### T7 — LLM Token-Budget Control Room
Per-tenant **cost burn-down + forecast-to-exhaustion + weighted fair-share on the cost axis**. Core has the
cost-lane analytics (`deniedByLane.cost`) and the `tokenBudget` / `distributedTokenBudget` meters; burn-rate
and ETA are a client-side roll-up over `remaining` deltas. Ties to the **TALE** research direction — keep all
framing as engineering; the TALE paper stays local until arXiv. Could be a TUI view (`5`/`tokens`) or a
focused mode.

### T8 — Fleet-global aggregation
Merge additive per-axis/per-policy counters + **`MergeableSketch`** top-K across nodes; compute the **true
fleet-global** admitted-vs-ceiling from federation L2/L3 state; add a per-process ⇄ fleet toggle (`LensMode`
"fleet" / `meta.fleetNodes` are already reserved in `types.ts`). **Key decision — reopens a transport
question:** the TUI reads an in-process hub and we deliberately removed the web/HTTP Lens, so collecting N
nodes needs a transport (a tiny read-only snapshot endpoint, a new gRPC streaming RPC, or push-to-aggregator).
The design note must settle this first, and **must not freeze the raw wire without explicit reauthorization.**
Biggest lift; most architectural.

---

## Ordering & dependencies

```
T1 (tabs) ──┬─ T2 Latency        (render-only; data present)
            ├─ T3 Fairness/WFE    (config + trackStats + render)
            ├─ T4 Capacity        (snapshot field + sync-only forecast)
            └─ T5 Guarantee       (net-new per-key allow accumulation + guard exposure)

T6 What-If Replay      ── design-first, testkit track (independent)
T7 Token-Budget Room   ── design-first (soft-renders as a T1 view)
T8 Fleet aggregation   ── design-first, transport decision (independent; wire-freeze needs reauth)
```

Rough effort: T1 S · T2 S · T3 M · T4 M · T5 L · T6 L · T7 M–L · T8 L.

## When shipping any of these

Bump `MONITOR_VERSION` + the server `CHANGELOG.md`; run the full core lint (whole repo, not just the
sub-package) + the server suite green from a real run; **ask before any tag/publish** (one "ship" is not
standing authority).
