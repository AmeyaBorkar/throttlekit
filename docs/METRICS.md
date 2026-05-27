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

## Span attributes

For trace-level visibility, set the stable `SPAN_ATTRIBUTES` on a span you already have:

| Attribute (`SPAN_ATTRIBUTES`) | Type | Meaning |
|---|---|---|
| `throttlekit.strategy` | string | active strategy name (`"gcra"`, `"quota"`, …) |
| `throttlekit.allowed` | boolean | whether the request was admitted |
| `throttlekit.limit` | number | effective ceiling |
| `throttlekit.remaining` | number | units remaining after the decision |
| `throttlekit.retry_after_ms` | number | ms to wait before retry (`0` when allowed) |

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

## Stability policy

`METRIC_NAMES` and `SPAN_ATTRIBUTES` are frozen `as const` and asserted by
`test/observability/metrics-contract.test.ts`. Any rename fails that test, forcing a conscious,
documented, major-version change — your dashboards won't silently break under a patch upgrade.
