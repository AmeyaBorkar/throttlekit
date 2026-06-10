# 18 · ThrottleKit Lens — the terminal dashboard & Monitor door

> A built-in, **zero-dependency, read-only** monitoring dashboard that runs **in your terminal**
> (`throttlekit-server --tui`), across **eight tabbed views**, and answers the one question no other
> rate-limiter dashboard can: *which axis is throttling this key right now?* Its programmable sibling, the
> **Monitor door**, projects the same state over gRPC for any language. Source: `server/src/monitor/`,
> `server/src/tui.ts`, and the core taps in `src/admission/` + `src/observability/`.

## Purpose

Operating a limiter blind — "we're returning 429s, but *why*?" — is the common failure. ThrottleKit Lens
gives **every** policy the full operational board (throughput, deny rate, top denied keys, latency,
concurrency health, a live denial feed with exact per-axis numbers) and, because the core composes
**rate × concurrency × cost** in one [`unifiedAdmission`](07-unified-admission.md) decision, a view nothing
else renders: **live binding-axis attribution** — for each denial, *which* constraint actually bound it.

It is **read-only and control-path-safe by construction**: it observes the server's decisions through taps
that can never change, delay, or break one. It needs no browser and no metrics backend; for headless or
fleet-wide monitoring you still emit OpenTelemetry → Grafana ([10](10-observability.md)), and for remote /
any-language reads the **Monitor door** exposes the same state over gRPC. Marked **experimental** (it lives
in `throttlekit-server`, outside the core's 1.x SemVer surface; it builds on the core's `@experimental`
`admissionTap` / `withAdmissionAnalytics` primitives, which need `throttlekit ≥ 1.1.0`).

> **History.** The dashboard was once a separate browser app shipped as the `throttlekit-lens` npm package.
> That package is **deprecated**: a TUI owns the terminal, needs no web server, and survives over SSH, so the
> transport-agnostic hub was folded into `throttlekit-server` and re-rendered in the terminal. "Lens" is now
> the name of that built-in dashboard, not a package to install.

## Architecture

Four layers, each independently testable, with a single rule between them: **data flows one way, and the
observation path is sync + O(1) + exception-swallowing** so the limiter never pays for being watched.

```
 decisions ──► core taps ──► telemetry hub ──► snapshot ──┬──► pure renderer ──► TUI shell (terminal)
 (check/admit)  (sync,O(1))   (bounded rings)  (LensSnapshot)│
                                                             └──► Monitor door (gRPC GetSnapshot/Watch + /metrics)
```

### 1 · The core taps (the data source)

The hub never reaches into a limiter; it **wraps** one with an observer that fires *after* each decision
resolves. Two pairs exist, in the core and shipped `@experimental`:

- **`tapDecisions(limiter, onDecision)`** (`src/observability/tap.ts`) + **`withAnalytics`** — for a plain
  `Limiter`. Emits a `DecisionEvent` (key, cost, decision, strategy, durationMs, kind) per check; analytics
  keeps windowed allow/deny counters and a Space-Saving top-K of requested + denied keys.
- **`admissionTap(admitter, onAdmission)`** (`src/admission/tap.ts`) + **`withAdmissionAnalytics`**
  (`src/admission/analytics.ts`) — the multi-axis siblings for a `UnifiedAdmitter`. The `AdmissionEvent`
  carries the **`bindingAxis`** and a single `lane` per denial (`rate` / `concurrency` / `cost` / `policy`),
  plus a per-axis `Decision` snapshot; the analytics partition denials **and** top-K *by lane*
  (`Σ deniedByLane === denied`). The `bindingAxis` is minted end-to-end inside `unifiedAdmission`
  (`src/admission/unified.ts`) — the dashboard *surfaces* a value the core already computes, it doesn't
  re-derive it.

Every tap is **synchronous** (fires inline after the decision), **exception-swallowing** (a throwing observer
never reaches the control path), and **O(1)** (ring push / counter bump / Space-Saving observe — no
allocation on the hot path). This is what makes it safe to leave on in production: the gRPC decisions are
byte-for-byte identical whether or not the Lens is watching.

### 2 · The telemetry hub (`server/src/monitor/hub.ts`)

`createLensHub(options?)` is the transport-agnostic aggregator. It registers sources —
`trackLimiter(name, limiter)` (wraps with `withAnalytics` + `tapDecisions`), `trackAdmitter(name, admitter)`
(wraps with `withAdmissionAnalytics` + `admissionTap`), `trackGuard(name, guard)` (reads `guard.stats()` at
snapshot time), and `trackStats(name, kind, read)` (a generic per-frame thunk, e.g. `kind:"wfe"` or
`"cost-room"`) — and exposes two outputs: **`snapshot(): LensSnapshot`** (a fresh, detached object built on
demand) and **`subscribe(listener)`** (fires on each denial / self-fence, every listener isolated in its own
try-catch). Memory is **bounded everywhere**: a per-policy latency ring, a `recentLimit`-sized denial ring and
fence ring, and Space-Saving top-K (`topK` entries) — none can grow with traffic. Each snapshot stamps a
`MONITOR_VERSION` into `meta.lensVersion` so a reader can detect shape drift.

### 3 · The snapshot (`server/src/monitor/types.ts`)

`LensSnapshot` is the serializable envelope the renderer and the Monitor door both consume:

- `meta` — `generatedAt`, `windowMs`, store `mode`, `lensVersion`, optional `nodeId`.
- `policies: LensPolicySnapshot[]` — per limiter/admitter: `analytics` (allow/deny/denyRate + top-K; for
  admitters also `deniedByLane` + `topDeniedByLane`), the observed `limit` (last-seen ceiling), a `latency`
  summary (avg/p50/p99/max + n), and for sync-store limiters a `forecast` (or an honest
  `forecastUnavailable: "async" | "idle" | "unsupported"`).
- `guards: LensGuardSnapshot[]` — concurrency: `inflight`, the **enforced** `limit` (`min(share, local)`, 0
  when fenced), `rttNoload` / `lastRtt`, and the distributed extras `share` / `lGlobal` / `nodes` / `fenced`.
- `recentDenials: LensDenialRow[]` + `recentFences: LensFenceRow[]` — the live feeds (oldest-first).
- Optional, opt-in: `costRooms: LensCostRoomSnapshot[]` (per-tenant cost burn), `replay: LensReplaySnapshot`
  (shadow status + last what-if), `plan: LensPlanSnapshot` (whole-config diff), `health`.

### 4 · The pure renderer (`server/src/monitor/render.ts`)

`renderFrame(snapshot, opts) → string[]` is **pure**: no I/O, no timers, no state. It works on a `Seg`
(`{text, color}`) / `Line` model and a `clamp(line, cols)` that pads or truncates every line to **exactly**
the terminal width (computed on plain-text width, ANSI-aware), so a frame is a deterministic function of
`(snapshot, cols, rows, viewState)` — which is why each tab body (`latencyBody`, `fairnessBody`,
`capacityBody`, `guaranteeBody`, `costRoomBody`, `replayBody`, `planBody`, plus the Overview's
`bindingAxisPanel` + `topKeysPanel`) is unit-tested without a terminal. The `TABS` table fixes the 1–8 order.

### 5 · The TUI shell (`server/src/tui.ts`)

`runTui(hub, opts)` owns the terminal: alt-screen + hidden cursor + raw mode on start, restored on stop
(idempotent). A ~4 Hz timer calls `hub.snapshot()`, optionally augments it with the live replay/plan
sub-snapshots, and writes `renderFrame(...)`. Keys (raw-mode parsed): `1`–`8` / `Tab` / `Shift-Tab` switch
views, `↑`/`↓` + `PgUp`/`PgDn` + `g`/`G` scroll the denial feed, `p` pauses (freezes the snapshot), `r` runs
the configured What-If Replay, `P` runs the whole-config Plan, `q` / `Ctrl-C` quits. `SIGWINCH` repaints on
resize. `canRunTui()` requires **both** stdin and stdout to be a TTY; without one the server prints a warning
and **serves normally without the dashboard** (the Monitor door + `/metrics` stay available) — a TUI can't be
on-by-default because it owns the terminal.

## The eight views

| # | View | Fed by | Honest non-claim |
|---|------|--------|------------------|
| 1 | **Overview** | analytics + denial ring | The **binding-axis hero** needs a `unifiedAdmission` admitter; a single-axis `rateLimit()` has nothing to decompose (the board still shows policy/key attribution). Top-K is Space-Saving — an **over-estimate** that never misses a true heavy hitter. |
| 2 | **Latency** | per-policy latency ring | Admit-path latency over a rolling ring; a policy with no samples this window says so. Warns p99 only when it's both above a floor and a multiple of p50. |
| 3 | **Fairness** | `wfe.stats()` (`kind:"wfe"`) | Per-tenant **guaranteed vs used vs borrowed** for a weighted-fair-escrow policy; recomputed over the *active* tenant set each frame. |
| 4 | **Capacity** | `forecastSync()` of the hottest key | **Sync-store limiters only**; an async store / admitter / idle policy reads `n/a` honestly, never a fabricated number. |
| 5 | **Guarantee** | `guard.stats()` | **Observed** inflight vs the guard's **enforced** ceiling (`min(share, limit)`) + self-fence status — *not* a live proof. The fleet bound `Σ inflight ≤ L_global` is machine-checked in TLA⁺ at design time ([06](06-concurrency.md)), not re-verified at runtime. |
| 6 | **Cost Room** | `wfe.stats()` + burn rings (`kind:"cost-room"`) | Per-tenant cost burn-down + ETA. The per-tenant ETA is to the **guarantee floor** and **does not count borrowing**; the **pool** ETA is the only true shared-exhaustion number. Burn rates degrade to an honest `warming` / `window-too-short` / `idle` rather than a guess. |
| 7 | **Replay** | deterministic shadow + what-if | The flip count is the candidate vs the **deterministic baseline over this traffic shape** — *not* a replay of production's exact decisions; a `truncated` / `poisoned` shadow is flagged, never understated silently. See [17](17-replay.md). |
| 8 | **Plan** | shadow corpus + `runPolicyPlan` | A whole-config [`terraform plan`](16-policy-plans.md) over the live shadow corpus; covers leaf-rate policies, reports every other axis `not-replayable`, and `truncated` understates. |

## How the server lights up Fairness / Guarantee / Cost Room

`wireMonitor` (`server/src/monitor/wire.ts`) builds the gRPC service from config and registers each source as
it goes: every limiter → `trackLimiter`, every unified admitter → `trackAdmitter`, every concurrency guard →
`trackGuard` (so **Guarantee** + the Overview concurrency readout populate on the *server*, not just an
embedded demo). A `fairEscrow` (or `federatedFairEscrow`) policy is served over the **`Check`** RPC with the
request key as the tenant; its `weightedFairEscrow.stats()` feeds **Fairness** via `trackStats(…, "wfe", …)`,
and — when its `costRoom` is enabled — a `costRoomSource` (`server/src/monitor/burn.ts`) accumulates bounded
per-tenant burn rings and emits a `LensCostRoomSnapshot` each frame for **Cost Room**. On the server the cost
*axis* is normally a `tokenBudget` / `fleetBudget` **meter** (the `Debit` RPC), not a lane of a unified
admitter — so the Overview hero's `cost` lane is usually dark, and the Cost Room tab exists precisely to
surface the per-tenant cost view the binding-axis hero can't.

## The Monitor door (the programmable sibling)

The same `LensSnapshot` is projected over a read-only gRPC service, `throttlekit.v1.Monitor`
(`server/src/monitor/service.ts`), so any language reads it remotely:

- **`GetSnapshot`** returns a typed projection (per-policy allow/deny/limit/latency + top keys, guard health,
  the recent denial feed) **plus a `raw_json` field carrying the full `LensSnapshot`** for depth and
  forward-compatibility (the wire stays decoupled from the evolving internal shape — [13](13-wire-protocol.md)).
- **`Watch`** server-streams the live denial feed (optionally filtered to one policy), **rate-capped and
  backpressured**: a slow reader **drops** events rather than growing server memory — it's best-effort
  observability, not a durable log (use *capture* for that).

Both are **strictly read-only** (they never compute or affect a decision). Because the snapshot carries
traffic keys (PII), the door is **loopback-only by default**; set `--monitor-secret` (presented as
`x-monitor-secret` or `authorization: Bearer …`, constant-time compared) to read it from another host, paired
with TLS. A Prometheus **`/metrics`** endpoint (`--metrics-port`) renders the **aggregate, PII-free** series —
`throttlekit_allowed_total`, `throttlekit_denied_total`, the per-axis `throttlekit_denied_by_axis_total`,
latency, guard health — plus `/healthz`; it defaults to loopback and needs no auth (no per-key data). The
standard `grpc.health.v1.Health` service is always on. Metric names are the frozen contract in
[`docs/METRICS.md`](../METRICS.md).

## Design decisions & rationale

- **Read-only, control-path-safe taps.** Observation is a sync, O(1), exception-swallowing tail on the
  decision — never a hook that can change, delay, or break it. This is the precondition for leaving the Lens
  on in production, and it's enforced structurally (the taps wrap, they don't intercept).
- **A pure renderer, split from the I/O shell.** `renderFrame` is a deterministic function of the snapshot +
  geometry, so every panel — including width-exact clamping and the binding-axis bars — is unit-tested
  without a terminal; `tui.ts` is the thin, untested-by-design I/O boundary (raw mode, alt-screen, SIGWINCH).
- **One hub, two faces.** The terminal dashboard and the Monitor door render the *same* `LensSnapshot`, so a
  feature added to the hub appears in both, and a polyglot client sees exactly what an operator sees.
- **Bounded by construction.** Latency/denial/fence rings and Space-Saving top-K mean a key flood or a denial
  storm can't grow hub memory — the same posture as the core meter's `maxKeys`.
- **Opt-in, interactive-TTY-gated.** A TUI owns the terminal, so it can't be on-by-default (unlike a loopback
  web page would have been); a non-TTY invocation degrades to a plain serve with the door + `/metrics` intact.
- **Loopback-first, auth-to-expose.** The snapshot is PII (traffic keys), so the gRPC door is loopback-only
  until a secret is set; `/metrics` is aggregate/PII-free and so needs no auth.
- **The hero is structural, not a UI trick.** `bindingAxis` is minted inside unified admission and exported as
  a metric label (`denies_by_axis`); the Lens renders the same signal per-key, live — the one thing a
  cardinality-bounded metric backend structurally can't.

## Honest boundary

- The **binding-axis lane** needs `unifiedAdmission`; a plain limiter has one axis and the board says so.
- **Guarantee** is *observed* per-node status, not a live proof; the fleet `Σ inflight ≤ L_global` bound is
  TLA⁺-checked at design time, and the per-key two-tier overshoot is a fleet property, not a needle.
- Numbers are **eventually-consistent and per-window**; top-K **over-estimates** (never misses a heavy hitter).
- It is a **single-process** view of the server you point it at — there is **no fleet merge in the terminal**;
  aggregate a fleet via OpenTelemetry → Grafana.
- It is **not bit-exact replay** of production — the Replay/Plan tabs are deterministic what-ifs over a cold
  shadow corpus, distinct from the durable forensic *capture* store.
- It is **read-only** and **opt-in**; headless / production monitoring belongs on OTel + the Monitor door.

## What proves it

- `server/test/hub.test.ts`, `server/test/ring.test.ts` — the hub's source registration, bounded rings, and
  the detached-snapshot contract.
- `server/test/render.test.ts` — the **pure** renderer: width-exact clamping and each tab body against
  synthetic snapshots (no terminal, no timing).
- `test/admission/lens-taps.test.ts`, `test/admission/binding-axis.test.ts`, `test/observability/tap.test.ts`
  — the core taps: sync / exception-swallowing / O(1), and exact lane attribution (`Σ deniedByLane === denied`).
- `server/test/monitor-service.test.ts`, `server/test/metrics.test.ts`, `server/test/health.test.ts` — the
  Monitor door's auth (loopback-only without a secret, constant-time compare), `Watch` rate-cap/backpressure,
  the `/metrics` PII-free series, and gRPC health.
- `server/test/cost-room-burn.test.ts`, `cost-room-burn-source.test.ts`, `cost-room-config.test.ts` — the
  per-tenant burn rings, window-roll handling, and the honest ETA scope.
- `server/test/replay-shadow.test.ts`, `replay-whatif.test.ts`, `plan-tab.test.ts` — the deterministic shadow,
  the `r` what-if, and the `P` whole-config plan surfaces.

## Source map

`server/src/monitor/hub.ts` (the hub) · `types.ts` (`LensSnapshot` + sub-shapes) · `ring.ts` (the O(1) ring) ·
`render.ts` (the pure renderer + tab bodies) · `burn.ts` (`costRoomSource`) · `service.ts` (the Monitor gRPC
door + auth) · `metrics.ts` (`/metrics` + `/healthz`) · `wire.ts` (`wireMonitor`, source registration) ·
`server/src/tui.ts` (the terminal shell). Core taps: `src/observability/tap.ts` (`tapDecisions`) ·
`src/admission/tap.ts` (`admissionTap`) · `src/admission/analytics.ts` (`withAdmissionAnalytics`) ·
`src/admission/unified.ts` (where `bindingAxis` is minted). Built on the OTel contract in
[10](10-observability.md) + [`docs/METRICS.md`](../METRICS.md); the Replay/Plan tabs on [17](17-replay.md) +
[16](16-policy-plans.md).
