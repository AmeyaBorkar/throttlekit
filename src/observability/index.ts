/**
 * Optional OpenTelemetry observability layer for ThrottleKit.
 *
 * Import via the `throttlekit/observability` entry point. Requires `@opentelemetry/api` (an
 * optional peer dependency) only at the call site — pass in your own configured `Meter`.
 *
 * @packageDocumentation
 */

export {
  instrumentGuard,
  instrumentLimiter,
  METRIC_NAMES,
  recordDecisionOnSpan,
  SPAN_ATTRIBUTES,
} from "./otel";
export type { InstrumentOptions, SpanLike } from "./otel";
