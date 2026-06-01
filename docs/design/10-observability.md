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

## Design decisions & rationale

- **Frozen metric/attribute names**, pinned by a contract test — the only safe way to let dashboards depend
  on them across patch upgrades.
- **Type-only OTel import** keeps the dependency footprint at zero while still emitting first-class OTel.
- **`bindingAxisOf` is the single source** for both the in-band result field and the span attribute, so a
  denial's binding axis is reported identically in code and in traces.
- **Taps swallow their own exceptions** — observability must never be able to break the control path.
- **Space-Saving for heavy hitters** — bounded memory over an unbounded key universe, with the one-sided
  error (over-estimate, never miss a true hitter) that is correct for abuse detection.

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
`index.ts` · `src/analytics/index.ts` (`withAnalytics`) · `docs/METRICS.md`.
