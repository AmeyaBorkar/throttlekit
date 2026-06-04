/**
 * Optional OpenTelemetry observability layer.
 *
 * `@opentelemetry/api` is an *optional* peer dependency. Everything here imports it
 * **type-only** ({@link Meter}), so the import is erased at compile time and this module carries
 * no runtime dependency on the OTel SDK — callers who never touch it pay nothing, and callers who
 * do pass in their own already-configured {@link Meter}.
 *
 * Two wrappers are provided:
 *
 * - {@link instrumentLimiter} returns a new {@link Limiter} that delegates to the inner one while
 *   recording a checks counter, a remaining histogram, and a store-latency histogram on every
 *   `check`/`checkSync`.
 * - {@link instrumentGuard} attaches OTel *observable* gauges to an existing
 *   {@link ConcurrencyGuard} that sample `guard.stats()` on each metric collection.
 */

import type { Meter } from "@opentelemetry/api";
import type {
  UnifiedAdmission,
  UnifiedAdmitOptions,
  UnifiedAdmitter,
  UnifiedAxis,
} from "../admission/unified";
import type { ConcurrencyGuard } from "../concurrency/adaptive";
import { forwardIntrospection } from "../core/limiter";
import type { Decision, Limiter } from "../core/types";

/**
 * The **stable** metric names ThrottleKit emits. Treated as a public contract: a name changes only
 * with a deliberate major bump (a renamed metric breaks dashboards), and the metrics-contract test
 * pins these exact strings. Reference them instead of hard-coding (e.g. in Grafana/alert config).
 * An OTel Prometheus exporter maps the dots to underscores (`throttlekit.checks` →
 * `throttlekit_checks`); see docs/METRICS.md.
 */
export const METRIC_NAMES = {
  /** Counter `+1` per check. Attributes: `{ strategy, allowed }`. */
  checks: "throttlekit.checks",
  /** Histogram of `decision.remaining`. Attribute: `{ strategy }`. */
  remaining: "throttlekit.remaining",
  /** Histogram (ms) of wall time inside the store per check. Attribute: `{ strategy }`. */
  storeLatency: "throttlekit.store.latency",
  /** Observable gauge: current inferred concurrency ceiling. */
  concurrencyLimit: "throttlekit.concurrency.limit",
  /** Observable gauge: concurrency leases outstanding. */
  concurrencyInflight: "throttlekit.concurrency.inflight",
  /** Observable gauge (ms): windowed no-load RTT baseline. */
  concurrencyRttNoload: "throttlekit.concurrency.rtt_noload",
  /**
   * Counter `+1` per **unified-admission denial**, attributed to the binding lane via a `{ lane }`
   * attribute ∈ `rate` | `concurrency` | `cost` | `policy` (the joint-LP bid-price filter). The metric
   * a span attribute can't be — it lets a Grafana board break denials down by *which axis* bound them.
   * Recorded by {@link instrumentAdmitter}. **Additive in 1.2.0** (a new name, not a changed one).
   */
  deniesByAxis: "throttlekit.denies_by_axis",
} as const;

/** Common options for the instrumentation wrappers. */
export interface InstrumentOptions {
  /**
   * Extra static attributes attached to every recorded measurement (e.g. `{ region: "us-east" }`).
   * Merged after the built-in attributes, so it can override `strategy`/`allowed` if desired.
   */
  attributes?: Record<string, string>;
}

/** High-resolution monotonic wall clock for latency measurement, in fractional milliseconds. */
const monoNowMs: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? (): number => performance.now()
    : (): number => Date.now();

/**
 * Wrap a {@link Limiter} so every check is observed through `meter`. The returned limiter is a
 * thin delegate: `reset` and `strategy` pass straight through, and both `check` (async) and
 * `checkSync` (sync) record:
 *
 * - `throttlekit.checks` — counter, `+1` per check, attributes
 *   `{ strategy, allowed, ...opts.attributes }`.
 * - `throttlekit.remaining` — histogram of `decision.remaining`, attribute `{ strategy }`.
 * - `throttlekit.store.latency` — histogram (unit `ms`) of the wall time spent inside the inner
 *   check, attribute `{ strategy }`.
 *
 * Instruments are created once, outside the hot path. If the inner `checkSync` throws (an
 * async-only store), the error propagates unchanged and no measurement is recorded.
 */
export function instrumentLimiter(
  limiter: Limiter,
  meter: Meter,
  opts?: InstrumentOptions,
): Limiter {
  const strategyName = limiter.strategy.name;
  const extra = opts?.attributes;

  // Instruments are created once here, never on the per-check hot path.
  const checks = meter.createCounter(METRIC_NAMES.checks, {
    description: "Total rate-limit checks, labelled by strategy and allow/deny outcome.",
  });
  const remaining = meter.createHistogram(METRIC_NAMES.remaining, {
    description: "Units remaining reported by each rate-limit decision.",
  });
  const latency = meter.createHistogram(METRIC_NAMES.storeLatency, {
    description: "Wall time spent in the underlying store per check.",
    unit: "ms",
  });

  // Attributes for the remaining histogram never change, so build them once.
  const strategyAttrs: Record<string, string> = { strategy: strategyName };

  /** Record the three measurements for one completed inner check. */
  const record = (decision: Decision, elapsedMs: number): void => {
    const checkAttrs: Record<string, string> = {
      strategy: strategyName,
      allowed: String(decision.allowed),
    };
    if (extra !== undefined) Object.assign(checkAttrs, extra);

    checks.add(1, checkAttrs);
    remaining.record(decision.remaining, strategyAttrs);
    latency.record(elapsedMs, strategyAttrs);
  };

  return {
    get strategy() {
      return limiter.strategy;
    },

    async check(key: string, cost?: number): Promise<Decision> {
      const start = monoNowMs();
      const decision = await limiter.check(key, cost);
      record(decision, monoNowMs() - start);
      return decision;
    },

    checkSync(key: string, cost?: number): Decision {
      const start = monoNowMs();
      // If the inner store is async-only, checkSync throws here; let it propagate untouched.
      const decision = limiter.checkSync(key, cost);
      record(decision, monoNowMs() - start);
      return decision;
    },

    async checkMany(keys: readonly string[], cost?: number): Promise<Decision[]> {
      const start = monoNowMs();
      const decisions = await limiter.checkMany(keys, cost);
      // Per-key latency isn't separable in a batch; attribute an equal share of the wall time.
      const share = decisions.length > 0 ? (monoNowMs() - start) / decisions.length : 0;
      for (const d of decisions) record(d, share);
      return decisions;
    },

    checkManySync(keys: readonly string[], cost?: number): Decision[] {
      const start = monoNowMs();
      const decisions = limiter.checkManySync(keys, cost);
      const share = decisions.length > 0 ? (monoNowMs() - start) / decisions.length : 0;
      for (const d of decisions) record(d, share);
      return decisions;
    },

    reset(key: string): Promise<void> {
      return limiter.reset(key);
    },

    // Forward non-consuming introspection + disposal so instrumenting never hides them.
    ...forwardIntrospection(limiter),
  };
}

/**
 * Attach OpenTelemetry *observable* gauges to an existing {@link ConcurrencyGuard}. The same guard
 * is returned (its `acquire`/`limit`/`inflight`/`stats` are untouched) — this only registers
 * callbacks that sample {@link ConcurrencyGuard.stats} whenever the SDK collects metrics:
 *
 * - `throttlekit.concurrency.limit` — the current inferred ceiling.
 * - `throttlekit.concurrency.inflight` — outstanding leases.
 * - `throttlekit.concurrency.rtt_noload` — the windowed no-load RTT baseline (ms).
 *
 * A single batched callback feeds all three gauges, so `stats()` is read exactly once per
 * collection. Passive observation never perturbs the guard's adaptive estimate.
 */
export function instrumentGuard(
  guard: ConcurrencyGuard,
  meter: Meter,
  opts?: InstrumentOptions,
): ConcurrencyGuard {
  const extra = opts?.attributes;
  const attrs: Record<string, string> | undefined = extra !== undefined ? { ...extra } : undefined;

  const limitGauge = meter.createObservableGauge(METRIC_NAMES.concurrencyLimit, {
    description: "Current inferred concurrency ceiling.",
  });
  const inflightGauge = meter.createObservableGauge(METRIC_NAMES.concurrencyInflight, {
    description: "Concurrency leases currently outstanding.",
  });
  const rttGauge = meter.createObservableGauge(METRIC_NAMES.concurrencyRttNoload, {
    description: "Windowed no-load RTT baseline.",
    unit: "ms",
  });

  // One batched callback reads stats() once and feeds all three gauges per collection.
  meter.addBatchObservableCallback(
    (result) => {
      const s = guard.stats();
      result.observe(limitGauge, s.limit, attrs);
      result.observe(inflightGauge, s.inflight, attrs);
      result.observe(rttGauge, s.rttNoload, attrs);
    },
    [limitGauge, inflightGauge, rttGauge],
  );

  return guard;
}

/**
 * Wrap a {@link UnifiedAdmitter} so every **denied** admission increments the
 * {@link METRIC_NAMES.deniesByAxis} counter with a `{ lane }` attribute identifying the binding lane —
 * `rate` / `concurrency` / `cost`, or `"policy"` for a joint-LP bid-price denial. This is the one signal
 * the `throttlekit.binding_axis` *span* attribute could never be: a metric label a Grafana board can group
 * by, so denials finally decompose by axis —
 * `sum by (lane) (rate(throttlekit_denies_by_axis_total[5m]))`.
 *
 * The returned admitter delegates `admit` / `admitSync` / `lastDecisions` to the inner one and records
 * **only denials** (an allow records nothing). The lane is read from the admission's own `bindingAxis`
 * (exact, never racy); a denied admission with no binding axis is — by the `unifiedAdmission` contract —
 * a joint-LP `policy` denial. `options.attributes` (e.g. `{ region }`) merge onto every measurement.
 *
 * @example
 * ```ts
 * import { instrumentAdmitter } from "throttlekit/otel";
 * import { metrics } from "@opentelemetry/api";
 *
 * const admit = instrumentAdmitter(
 *   unifiedAdmission({ rate, concurrency, cost }),
 *   metrics.getMeter("checkout"),
 * );
 * const { decision, release } = await admit.admit({ key: tenant, cost: tokens });
 * ```
 */
export function instrumentAdmitter(
  admitter: UnifiedAdmitter,
  meter: Meter,
  options: InstrumentOptions = {},
): UnifiedAdmitter {
  const denies = meter.createCounter(METRIC_NAMES.deniesByAxis, {
    description:
      "Unified-admission denials, attributed to the binding lane (rate/concurrency/cost/policy).",
  });
  const base = options.attributes;
  const record = (admission: UnifiedAdmission): void => {
    if (admission.decision.allowed) return;
    const lane: UnifiedAxis | "policy" = admission.bindingAxis ?? "policy";
    denies.add(1, base !== undefined ? { ...base, lane } : { lane });
  };
  return {
    async admit(opts?: UnifiedAdmitOptions): Promise<UnifiedAdmission> {
      const admission = await admitter.admit(opts);
      record(admission);
      return admission;
    },
    admitSync(opts?: UnifiedAdmitOptions): UnifiedAdmission {
      const admission = admitter.admitSync(opts);
      record(admission);
      return admission;
    },
    lastDecisions(): Readonly<Partial<Record<UnifiedAxis, Decision | undefined>>> {
      return admitter.lastDecisions();
    },
  };
}

/**
 * The **stable** span-attribute keys set by {@link recordDecisionOnSpan}. A public contract like
 * {@link METRIC_NAMES}; pinned by the metrics-contract test. See docs/METRICS.md.
 */
export const SPAN_ATTRIBUTES = {
  /** The active strategy name (e.g. `"gcra"`, `"quota"`). */
  strategy: "throttlekit.strategy",
  /** Whether the request was admitted (boolean). */
  allowed: "throttlekit.allowed",
  /** The effective ceiling. */
  limit: "throttlekit.limit",
  /** Units remaining after the decision. */
  remaining: "throttlekit.remaining",
  /** Milliseconds to wait before retrying (`0` when allowed). */
  retryAfterMs: "throttlekit.retry_after_ms",
  /**
   * For `unifiedAdmission`: the axis that bound the combined Decision
   * (`"concurrency"` | `"rate"` | `"cost"`). Only set when the combined
   * decision was denied — when admitted, no axis was binding. Set by
   * {@link recordUnifiedAdmissionOnSpan} from the
   * `UnifiedAdmitter.lastDecisions()` snapshot. (TK-1008)
   */
  bindingAxis: "throttlekit.binding_axis",
} as const;

/** The slice of an OpenTelemetry `Span` used to record decision attributes (structural; no import). */
export interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): unknown;
}

/**
 * Record a rate-limit {@link Decision} onto an OpenTelemetry span using the stable
 * {@link SPAN_ATTRIBUTES} keys, so a trace can be searched by `throttlekit.allowed=false` and
 * faceted by `throttlekit.strategy`. Pass the span you already have (e.g. `trace.getActiveSpan()`);
 * typing it structurally keeps this module dependency-free. `extra` adds your own attributes.
 *
 * @example
 * ```ts
 * import { trace } from "@opentelemetry/api";
 * import { recordDecisionOnSpan } from "throttlekit/otel";
 * const d = await limiter.check(key);
 * const span = trace.getActiveSpan();
 * if (span) recordDecisionOnSpan(span, d, limiter.strategy.name);
 * ```
 */
export function recordDecisionOnSpan(
  span: SpanLike,
  decision: Decision,
  strategyName: string,
  extra?: Record<string, string | number | boolean>,
): void {
  span.setAttribute(SPAN_ATTRIBUTES.strategy, strategyName);
  span.setAttribute(SPAN_ATTRIBUTES.allowed, decision.allowed);
  span.setAttribute(SPAN_ATTRIBUTES.limit, decision.limit);
  span.setAttribute(SPAN_ATTRIBUTES.remaining, decision.remaining);
  span.setAttribute(SPAN_ATTRIBUTES.retryAfterMs, decision.retryAfterMs);
  if (extra !== undefined) {
    for (const [k, v] of Object.entries(extra)) span.setAttribute(k, v);
  }
}

/** The lastDecisions snapshot shape from {@link UnifiedAdmitter.lastDecisions}. */
type UnifiedLastDecisions = Readonly<
  Partial<Record<"rate" | "concurrency" | "cost", Decision | undefined>>
>;

/**
 * Identify the **binding axis** for a unified admission — the first
 * denying axis in concurrency → rate → cost order (the same order
 * `unifiedAdmission`'s sequential mode evaluates in, so the result
 * matches the user's mental model of "which check blocked me first").
 *
 * Returns `undefined` when no axis denied (the combined decision was
 * either an allow, or no axis was configured).
 *
 * The fused backend evaluates rate and cost atomically — both can deny
 * in the same admission. We still return the first one in the
 * concurrency → rate → cost order so the attribute value is
 * deterministic and matches the sequential convention.
 *
 * @example
 * ```ts
 * import { trace } from "@opentelemetry/api";
 * import { bindingAxisOf } from "throttlekit/otel";
 *
 * const { decision } = await admit.admit({ key, cost: tokens });
 * if (!decision.allowed) {
 *   const axis = bindingAxisOf(admit.lastDecisions());
 *   span?.setAttribute("throttlekit.binding_axis", axis ?? "unknown");
 * }
 * ```
 */
export function bindingAxisOf(
  lastDecisions: UnifiedLastDecisions,
): "rate" | "concurrency" | "cost" | undefined {
  if (lastDecisions.concurrency?.allowed === false) return "concurrency";
  if (lastDecisions.rate?.allowed === false) return "rate";
  if (lastDecisions.cost?.allowed === false) return "cost";
  return undefined;
}

/**
 * Record a `unifiedAdmission` decision onto an OpenTelemetry span. Sets
 * the standard {@link SPAN_ATTRIBUTES} (`allowed`/`limit`/`remaining`/
 * `retryAfterMs`) plus the **`throttlekit.binding_axis`** attribute
 * identifying which axis (rate / concurrency / cost) bound the
 * decision when it was denied. The `strategy` attribute is *not* set
 * — unified admissions span multiple strategies, so the binding axis
 * is the analogous classifier. Pass `extra` for any additional
 * attributes you want on the span.
 *
 * @example
 * ```ts
 * import { trace } from "@opentelemetry/api";
 * import { recordUnifiedAdmissionOnSpan } from "throttlekit/otel";
 *
 * const { decision } = await admit.admit({ key, cost: tokens });
 * const span = trace.getActiveSpan();
 * if (span) recordUnifiedAdmissionOnSpan(span, decision, admit.lastDecisions());
 * ```
 */
export function recordUnifiedAdmissionOnSpan(
  span: SpanLike,
  decision: Decision,
  lastDecisions: UnifiedLastDecisions,
  extra?: Record<string, string | number | boolean>,
): void {
  span.setAttribute(SPAN_ATTRIBUTES.allowed, decision.allowed);
  span.setAttribute(SPAN_ATTRIBUTES.limit, decision.limit);
  span.setAttribute(SPAN_ATTRIBUTES.remaining, decision.remaining);
  span.setAttribute(SPAN_ATTRIBUTES.retryAfterMs, decision.retryAfterMs);
  if (!decision.allowed) {
    const axis = bindingAxisOf(lastDecisions);
    if (axis !== undefined) {
      span.setAttribute(SPAN_ATTRIBUTES.bindingAxis, axis);
    }
  }
  if (extra !== undefined) {
    for (const [k, v] of Object.entries(extra)) span.setAttribute(k, v);
  }
}
