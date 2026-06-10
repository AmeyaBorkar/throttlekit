# Metrics & span attributes

ThrottleKit's OpenTelemetry layer (`throttlekit/otel`) emits a small, **stable** set of metrics and
span attributes. The names are a public contract — exported as `METRIC_NAMES` / `SPAN_ATTRIBUTES`,
pinned by a contract test, and changed only with a deliberate major version bump (renaming a metric
breaks dashboards and alerts). Reference the exported constants from your dashboard-as-code instead
of hard-coding strings.

`@opentelemetry/api` is an *optional* peer dependency, imported **type-only**, so this layer carries
no runtime dependency — you pass in your own configured `Meter`.

## Metrics

A Prometheus exporter lowercases and replaces `.` with `_` (and appends `_total` to counters, `_ms`
suffixes per the unit), so `throttlekit.checks` is scraped as `throttlekit_checks_total`.

| Metric (`METRIC_NAMES`) | Instrument | Unit | Attributes | Meaning |
|---|---|---|---|---|
| `throttlekit.checks` | Counter | — | `strategy`, `allowed` | `+1` per check; split by strategy and allow/deny. The deny rate is `sum(allowed="false") / sum(*)`. |
| `throttlekit.remaining` | Histogram | — | `strategy` | Distribution of `decision.remaining` — how close clients run to the limit. |
| `throttlekit.store.latency` | Histogram | `ms` | `strategy` | Wall time spent inside the store per check (the network cost of a distributed backend). |
| `throttlekit.concurrency.limit` | ObservableGauge | — | — | Current inferred ceiling of an `adaptiveConcurrency` guard. |
| `throttlekit.concurrency.inflight` | ObservableGauge | — | — | Concurrency leases outstanding right now. |
| `throttlekit.concurrency.rtt_noload` | ObservableGauge | `ms` | — | Windowed no-load RTT baseline the guard adapts against. |
| `throttlekit.denies_by_axis` | Counter | — | `lane` | `+1` per **unified-admission denial**, split by binding lane (`rate` / `concurrency` / `cost` / `policy`). The breakdown a span facet can't be: `sum by (lane) (rate(throttlekit_denies_by_axis_total[5m]))`. Recorded by `instrumentAdmitter` (1.2.0+). |

Wiring:

```ts
import { instrumentLimiter, instrumentGuard } from "throttlekit/otel";
import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("my-service");
const limiter = instrumentLimiter(rateLimit({ strategy: gcra({ limit: 100, periodMs: 60_000 }) }), meter);
instrumentGuard(myConcurrencyGuard, meter);
```

`instrumentLimiter` records `checks`/`remaining`/`store.latency` on every `check`/`checkSync`/
`checkMany`; `instrumentGuard` registers one batched observable callback feeding the three
concurrency gauges (it reads `guard.stats()` once per collection). Pass `{ attributes: { region } }`
to add static labels to every measurement.

For a `unifiedAdmission`, **`instrumentAdmitter`** records `denies_by_axis` with a `{ lane }` label so a
Grafana board can finally split denials by *which axis* bound them — the metric the
`throttlekit.binding_axis` span attribute could never be (a span facet isn't a Prometheus label):

```ts
import { instrumentAdmitter } from "throttlekit/otel";

const admit = instrumentAdmitter(unifiedAdmission({ rate, concurrency, cost }), meter);
const { decision, release } = await admit.admit({ key: tenant, cost: tokens }); // only denials are counted
```

A denied admission with no binding axis is a joint-LP bid-price denial → `lane="policy"`. The live,
per-key, exact-per-axis view (without a metrics backend) is the [ThrottleKit
Lens](https://github.com/AmeyaBorkar/throttlekit/wiki/Monitoring-and-the-Lens); this counter is the
aggregate Grafana escape hatch.

## Span attributes

For trace-level visibility, set the stable `SPAN_ATTRIBUTES` on a span you already have:

| Attribute (`SPAN_ATTRIBUTES`) | Type | Meaning |
|---|---|---|
| `throttlekit.strategy` | string | active strategy name (`"gcra"`, `"quota"`, …) |
| `throttlekit.allowed` | boolean | whether the request was admitted |
| `throttlekit.limit` | number | effective ceiling |
| `throttlekit.remaining` | number | units remaining after the decision |
| `throttlekit.retry_after_ms` | number | ms to wait before retry (`0` when allowed) |
| `throttlekit.binding_axis` | string | `unifiedAdmission` only (via `recordUnifiedAdmissionOnSpan`): which axis bound a denial — `rate` / `concurrency` / `cost`. Omitted on an allow, or a joint-LP `policy` denial. |

```ts
import { trace } from "@opentelemetry/api";
import { recordDecisionOnSpan } from "throttlekit/otel";

const d = await limiter.check(key);
const span = trace.getActiveSpan();
if (span) recordDecisionOnSpan(span, d, limiter.strategy.name); // + optional extra attributes
```

Then search traces by `throttlekit.allowed = false` or facet latency by `throttlekit.strategy`.

## Lower-level: the analytics tap

`tapDecisions(limiter, onDecision)` (dependency-free, root export) hands you the raw
`{ key, cost, decision, strategy, durationMs, kind }` per check, so you can feed any backend the OTel
layer doesn't cover. See [Operations](https://github.com/AmeyaBorkar/throttlekit/wiki/Operations).

## The Monitor door — the read API on `throttlekit-server`

The sections above are the **producer** side (what your in-process limiter *emits*). When you run
`throttlekit-server` (0.3.0+), the same operational state is also exposed as a **read API** — distinct
from the [ThrottleKit Lens](https://github.com/AmeyaBorkar/throttlekit/wiki/Monitoring-and-the-Lens)
TUI (same state, a programmable/remote surface instead of a terminal). Two read transports, both
aggregate and **PII-free**:

### `throttlekit.v1.Monitor` (read-only gRPC)

A read-only gRPC service with two RPCs — it never makes a decision, only observes:

| RPC | Returns |
|---|---|
| `GetSnapshot` | a typed, per-policy snapshot (counts, observed ceiling, latency percentiles, concurrency-guard health) plus a `raw_json` field carrying the full state for clients that want everything without a proto bump. |
| `Watch` | a live, server-filtered **denial stream** — rate-capped and backpressured, so a slow consumer can never push memory on the server (the stream drops to stay within its cap rather than buffering unboundedly). |

**Auth posture:** the Monitor gRPC binds **loopback-only until `--monitor-secret`** is set; supplying
the secret is what opens it to remote scrapers. gRPC **health** (`grpc.health.v1.Health`) is served
alongside it. The Monitor service is **additive** under `throttlekit.v1` (buf-gated) and carries no
PII — it surfaces aggregates, not request bodies or keys.

### Prometheus `/metrics` (HTTP)

Enabling `--metrics-port` exposes an HTTP `/metrics` endpoint with aggregate, PII-free series a
Prometheus server scrapes directly (no OTel pipeline required):

| Series | Meaning |
|---|---|
| `throttlekit_allowed_total` | cumulative admitted decisions. |
| `throttlekit_denied_total` | cumulative denied decisions. |
| `throttlekit_denied_by_axis_total` | denials split by binding axis (`rate` / `concurrency` / `cost` / `policy`). |
| observed ceiling | the effective limit / inferred ceiling currently in force. |
| p50 / p99 admit latency | admission-decision latency percentiles. |
| concurrency-guard health | the adaptive-concurrency guard's current ceiling / in-flight health. |

`/metrics` is **loopback by default** and PII-free (aggregate counters only — no keys, no request
content). A `/healthz` liveness endpoint is served on the same port. This is the server-process
equivalent of the in-process OTel counters above: reach for it when the limiter runs inside
`throttlekit-server` rather than in your own process.

## Reference Grafana dashboard

A ready-to-import dashboard lives at [`grafana/throttlekit-dashboard.json`](../grafana/throttlekit-dashboard.json):
check rate by outcome, deny rate, remaining-headroom and store-latency percentiles, and the adaptive-
concurrency gauges — with `$datasource` and `$strategy` template variables. Import via Grafana →
Dashboards → New → Import. It targets the Prometheus names above (`throttlekit_checks_total`,
`throttlekit_remaining_bucket`, …); if your OTel exporter appends a unit suffix to the latency
histogram (e.g. `throttlekit_store_latency_milliseconds_bucket`), tweak that one panel's metric name.
A seventh panel — **Denials by binding axis** — stacks `throttlekit_denies_by_axis_total` by `lane`; it
populates once you wrap a `unifiedAdmission` with `instrumentAdmitter`.

## Stability policy

`METRIC_NAMES` and `SPAN_ATTRIBUTES` are frozen `as const` and asserted by
`test/observability/metrics-contract.test.ts`. Any rename of an existing name fails that test, forcing a
conscious, documented, **major**-version change — your dashboards won't silently break under a patch
upgrade. *Adding* a new name (like `denies_by_axis` in 1.2.0) is additive — a **minor** — but still trips
the `toEqual`, so it too is a deliberate, reviewed change, never an accident.
