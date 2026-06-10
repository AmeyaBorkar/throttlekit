# 10 · Observability

> A small, **frozen** set of OpenTelemetry metrics and span attributes (dashboards-as-contract), plus
> dependency-free decision taps and in-process analytics. Source: `src/observability/`, `src/analytics/`.

## Purpose

Every decision is already a structured object; observability turns the stream of them into metrics, spans,
and aggregates without coupling the library to any vendor SDK. The defining constraint is **stability**: a
renamed metric silently breaks every dashboard and alert on a patch upgrade, so the names are a public
contract.

## The frozen OTel contract (`otel.ts`)

`METRIC_NAMES` and `SPAN_ATTRIBUTES` are exported, frozen `as const` objects (`src/observability/otel.ts:30`):

- Metrics: `throttlekit.checks` (counter, `{strategy, allowed}`), `throttlekit.remaining` (histogram),
  `throttlekit.store.latency` (histogram, ms), and three concurrency gauges
  (`throttlekit.concurrency.{limit,inflight,rtt_noload}`).
- Span attributes: `throttlekit.{strategy,allowed,limit,remaining,retry_after_ms}`, plus
  **`throttlekit.binding_axis`** — for a *denied* `unifiedAdmission`, the axis (`concurrency` | `rate` |
  `cost`) that bound the combined decision.

`instrumentLimiter(limiter, meter)` wraps a limiter, creating the instruments **once outside the hot path**
and recording the three measurements per check; for a batch it attributes an equal share of wall time per
key, and it forwards introspection so the wrapper doesn't drop `peek`/`forecast`. `instrumentGuard` attaches
the three concurrency gauges via a single batch-observable callback that reads `guard.stats()` once per
collection and returns the guard untouched — passive, never perturbing the adaptive estimate.
`@opentelemetry/api` is imported **type-only**, so it is erased at compile time — the zero-runtime-dependency
promise is intact.

**`bindingAxisOf`** returns the first denying axis in concurrency → rate → cost order (matching the
sequential evaluation order, so it matches the user's mental model). This is the single function behind both
the `unifiedAdmission` result's `bindingAxis` field and the OTel `throttlekit.binding_axis` attribute, so
the two can never disagree.

## The analytics tap (`tap.ts`)

`tapDecisions(limiter, onDecision)` fires once per completed check with `{key, cost, decision, strategy,
durationMs, kind}`. It is the lowest-level, zero-dependency hook for shipping decisions to any sink. **A
throwing tap can never break the limiter** — exceptions are caught and dropped.

## In-process analytics (`withAnalytics`, experimental)

A drop-in wrapper adding `analytics()` (a snapshot) and `resetAnalytics()`, on a fixed epoch-aligned window.
Top-K heavy hitters use the **Space-Saving / Stream-Summary** algorithm (Metwally et al. 2005): at most
`topK` slots regardless of distinct-key cardinality, and it **over-estimates only — never drops a true
heavy hitter**. The snapshot reports allowed/denied/total/deny-rate plus the top requested and top denied
keys. Marked **experimental** (excluded from the 1.x SemVer surface).

## The Monitor door (the read API)

Everything above is a *producer* contract: OTel and the taps **push** decisions out to a sink you supply.
The [gRPC server](14-grpc-server.md) adds the complementary **pull/read** side — the **Monitor door**, a
remote, programmable read API over the same in-process telemetry hub the in-terminal dashboard renders. It
is strictly **non-mutating** and never returns or affects a rate-limit `Decision`.

The hub (`server/src/monitor/hub.ts`) is a zero-dependency in-process aggregator: register the served
limiters / unified admitters / concurrency guards and it returns **tapped** wrappers (built on
`tapDecisions` + `withAnalytics`, and `admissionTap` + `withAdmissionAnalytics` for the binding-axis lane),
then maintains one rolling per-window `LensSnapshot` (allow/deny, per-axis denials, Space-Saving top-K
keys, observed ceiling + admit-path latency, guard health) plus a bounded live denial/fence feed. The taps
are synchronous, exception-swallowing, and O(1), so the hub can never perturb the control path — the same
discipline the in-process tap holds itself to.

Three surfaces project that one hub:

- **`throttlekit.v1.Monitor`** (gRPC; [13](13-wire-protocol.md)) — `GetSnapshot` returns a typed envelope
  (`MonitorMeta` + per-policy/guard summaries + recent denials) **plus `raw_json`**, the full `LensSnapshot`
  as JSON; the typed fields are the stable wire contract while the evolving internal analytics ride in
  `raw_json`, so the additive wire is never coupled to the snapshot shape. `Watch` opens a live, filtered
  server-streamed denial feed that is **server-side rate-capped and backpressured** — a slow reader simply
  *drops* events, so the feed never grows server memory and never blocks the control path (best-effort
  observability, not a durable log — use [decision capture](17-replay.md) for that).
- **Prometheus `/metrics`** (`server/src/monitor/metrics.ts`; `--metrics-port`) — a small HTTP server
  rendering the hub as Prometheus text exposition, plus a `/healthz` liveness probe. It carries **only
  aggregate, PII-free series** (per-policy allow/deny, per-axis denials, observed ceiling, p50/p99 latency,
  guard health) — *no* per-key series.
- **gRPC health** — always-on `grpc.health.v1.Health` (vendored, outside the additive `wire/` contract;
  [13](13-wire-protocol.md), [14](14-grpc-server.md)).

**Auth posture.** The `Monitor` snapshot carries traffic keys (the limited identities = **PII**), so the
gRPC Monitor is **loopback-only** until a `--monitor-secret` is set (presented in call metadata, paired
with TLS to expose). `/metrics`, being aggregate and PII-free, needs no auth and defaults to loopback (a
host flag exposes it, with a warning).

**ThrottleKit Lens** is the *in-terminal* renderer of this same hub: `throttlekit-server --tui` draws the
`snapshot()` each frame across **eight tabs** (Overview, Latency, Fairness, Capacity, Guarantee, Cost Room,
Replay, Plan). Lens (the TUI) and the Monitor door (the programmable/remote read API) are two views of the
identical hub — distinct surfaces, one source of truth. (The legacy `throttlekit-lens` npm package is
deprecated; "Lens" now names the built-in `--tui` dashboard.) **[18 · ThrottleKit Lens](18-lens.md)** is the
full deep-dive — the hub, the core taps, the pure renderer, the TUI shell, and each tab's data source and
honest non-claim.

## Design decisions & rationale

- **Frozen metric/attribute names**, pinned by a contract test — the only safe way to let dashboards depend
  on them across patch upgrades.
- **Type-only OTel import** keeps the dependency footprint at zero while still emitting first-class OTel.
- **`bindingAxisOf` is the single source** for both the in-band result field and the span attribute, so a
  denial's binding axis is reported identically in code and in traces.
- **Taps swallow their own exceptions** — observability must never be able to break the control path.
- **Space-Saving for heavy hitters** — bounded memory over an unbounded key universe, with the one-sided
  error (over-estimate, never miss a true hitter) that is correct for abuse detection.
- **Producer vs read API are separate contracts.** OTel/taps are a *push* producer (you own the sink); the
  Monitor door is a *pull* read API (a client reads remotely). Splitting them lets the read API carry
  per-key/PII detail behind a secret while the push contract stays vendor-neutral and the metric names stay
  frozen.
- **Typed wire + `raw_json`** — the Monitor's typed fields are the stable wire contract; the full evolving
  `LensSnapshot` rides in `raw_json`, so the additive wire never has to chase the internal analytics shape.
- **`/metrics` is aggregate-only on purpose** — carrying no per-key series is what lets it default to
  loopback with no auth, while the gRPC snapshot (which has top-keys + the denial feed) requires a secret.

## Caveats

- The concurrency gauges are observable (pull-based) — they reflect `guard.stats()` at collection time,
  not a continuous series.
- `withAnalytics` is experimental and may change in a minor release.

## What proves it

- `test/observability/metrics-contract.test.ts` — `toEqual`-pins the exact `METRIC_NAMES` and
  `SPAN_ATTRIBUTES` objects (any rename fails CI), asserts `instrumentLimiter`/`instrumentGuard` create
  exactly the documented instruments, and verifies the full `bindingAxisOf` priority matrix.
- `test/observability/otel.test.ts`, `tap.test.ts`, `analytics/analytics.test.ts`.
- `docs/METRICS.md` — the reference, including the Prometheus name mapping and the stability policy the
  contract test enforces.

## Source map

`src/observability/otel.ts` (the frozen contract + instrumentation) · `tap.ts` (the decision tap) ·
`index.ts` · `src/analytics/index.ts` (`withAnalytics`) · `docs/METRICS.md`. The Monitor door lives in the
server: `server/src/monitor/hub.ts` (the telemetry hub), `service.ts` (the `throttlekit.v1.Monitor` gRPC),
`metrics.ts` (`/metrics`), `render.ts` (the Lens TUI frame) — contract in [13](13-wire-protocol.md),
server in [14](14-grpc-server.md).
