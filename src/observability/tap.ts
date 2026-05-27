/**
 * The analytics **tap** — the lowest-level observability primitive: a callback fired once per
 * completed check with the decision and how long it took. Dependency-free (no OpenTelemetry, no
 * peer). Pipe decisions anywhere — your own metrics, structured logs, an audit stream, a custom
 * dashboard — without ThrottleKit prescribing the backend.
 *
 * `instrumentLimiter` (OTel) and `withAnalytics` (built-in counters) are higher-level consumers of
 * the same idea; reach for `tapDecisions` when you want the raw stream.
 */

import { forwardIntrospection } from "../core/limiter";
import type { Decision, Limiter } from "../core/types";

/** High-resolution monotonic clock (fractional ms), falling back to `Date.now` off the main path. */
const monoNowMs: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

/** Which limiter method produced a decision (so a tap can distinguish batch from single checks). */
export type DecisionKind = "check" | "checkSync" | "checkMany" | "checkManySync";

/** One observed decision handed to a {@link DecisionTap}. */
export interface DecisionEvent {
  /** The key that was checked. */
  key: string;
  /** The effective cost of the check (default 1). */
  cost: number;
  /** The decision returned to the caller. */
  decision: Decision;
  /** The active strategy's stable name (e.g. `"gcra"`, `"quota"`). */
  strategy: string;
  /** Wall time spent inside the inner check, in fractional ms (an equal share per key for batches). */
  durationMs: number;
  /** Which limiter method produced this event. */
  kind: DecisionKind;
}

/** A side-effecting observer of decisions. It must not throw — exceptions are swallowed. */
export type DecisionTap = (event: DecisionEvent) => void;

/**
 * Wrap `limiter` so `onDecision` fires once per completed check (after the decision resolves), then
 * return the decision unchanged. A throwing tap can never break the limiter — its exceptions are
 * caught and dropped. All limiter methods, including the optional `peek`/`forecast`/`close`, are
 * forwarded.
 *
 * @example
 * ```ts
 * const limiter = tapDecisions(rateLimit({ strategy: gcra({ limit: 100, periodMs: 60_000 }) }), (e) => {
 *   if (!e.decision.allowed) log.warn({ key: e.key, retryAfterMs: e.decision.retryAfterMs }, "rate limited");
 *   myHistogram.observe(e.durationMs);
 * });
 * ```
 */
export function tapDecisions(limiter: Limiter, onDecision: DecisionTap): Limiter {
  const strategyName = limiter.strategy.name;

  const emit = (
    key: string,
    cost: number,
    decision: Decision,
    durationMs: number,
    kind: DecisionKind,
  ): void => {
    try {
      onDecision({ key, cost, decision, strategy: strategyName, durationMs, kind });
    } catch {
      // A tap is an observer; its failure must never propagate into the request path.
    }
  };

  return {
    get strategy() {
      return limiter.strategy;
    },

    async check(key: string, cost = 1): Promise<Decision> {
      const t0 = monoNowMs();
      const d = await limiter.check(key, cost);
      emit(key, cost, d, monoNowMs() - t0, "check");
      return d;
    },

    checkSync(key: string, cost = 1): Decision {
      const t0 = monoNowMs();
      const d = limiter.checkSync(key, cost);
      emit(key, cost, d, monoNowMs() - t0, "checkSync");
      return d;
    },

    async checkMany(keys: readonly string[], cost = 1): Promise<Decision[]> {
      const t0 = monoNowMs();
      const ds = await limiter.checkMany(keys, cost);
      const share = ds.length > 0 ? (monoNowMs() - t0) / ds.length : 0;
      for (let i = 0; i < ds.length; i++)
        emit(keys[i] as string, cost, ds[i] as Decision, share, "checkMany");
      return ds;
    },

    checkManySync(keys: readonly string[], cost = 1): Decision[] {
      const t0 = monoNowMs();
      const ds = limiter.checkManySync(keys, cost);
      const share = ds.length > 0 ? (monoNowMs() - t0) / ds.length : 0;
      for (let i = 0; i < ds.length; i++)
        emit(keys[i] as string, cost, ds[i] as Decision, share, "checkManySync");
      return ds;
    },

    reset(key: string): Promise<void> {
      return limiter.reset(key);
    },

    ...forwardIntrospection(limiter),
  };
}
