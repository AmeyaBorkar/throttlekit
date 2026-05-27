/**
 * Transport-agnostic enforcement core. Every framework binding ultimately does the same three
 * things — turn a request into a key, run the limiter, and turn the {@link Decision} into a verdict
 * plus standards headers — independent of *how* bytes arrive (HTTP, gRPC, a queue consumer, a job
 * runner). {@link createEnforcer} packages exactly that, with the store-outage {@link FailMode}
 * folded in, so any transport adapter is a thin map from its request/response to these calls. The
 * HTTP adapters build their own responses on {@link createGate}; non-HTTP and custom transports use
 * this.
 */

import type { Decision, FailMode, Limiter } from "../core/types";
import { type CommonAdapterOptions, type LimiterOrStrategy, createGate } from "./core";

/** The classification of an {@link Enforcer.enforce} call, before any transport-specific rendering. */
export type EnforceOutcome =
  /** Under the limit — proceed (and apply {@link EnforceResult.headers}). */
  | "ok"
  /** Over the limit — reject with the standard `429` semantics. */
  | "limited"
  /** The store threw; {@link EnforceResult.allowed} already reflects the {@link FailMode}. */
  | "error";

/** The transport-neutral result of enforcing a limit for one key. */
export interface EnforceResult {
  /**
   * Whether to admit the request. `true` for {@link EnforceOutcome} `"ok"`, and also for `"error"`
   * under a fail-**open** policy; `false` for `"limited"` and for `"error"` under fail-**closed**.
   */
  allowed: boolean;
  /** Which branch produced this result — lets an adapter distinguish a `429` (limited) from a `503` (error). */
  outcome: EnforceOutcome;
  /** The rate-limit decision, or `undefined` when the store threw (outcome `"error"`). */
  decision: Decision | undefined;
  /** Standards-compliant response headers for the decision (empty on `"error"` or when emit is `false`). */
  headers: Record<string, string>;
  /** Milliseconds to wait before retrying; `0` unless `outcome` is `"limited"`. */
  retryAfterMs: number;
  /** The error the store threw, when `outcome` is `"error"`. */
  error?: unknown;
}

/** Options for {@link createEnforcer}: a limiter (or the pieces to build one) plus header/fail policy. */
export type EnforceOptions = LimiterOrStrategy &
  Pick<CommonAdapterOptions, "fail" | "emit" | "policyName"> & {
    /** Fired on every denial (`outcome: "limited"`), with the key and its decision. */
    onLimited?: (key: string, decision: Decision) => void;
    /** Fired when the store throws, before the fail policy is applied. */
    onError?: (key: string, err: unknown) => void;
  };

/** A resolved enforcer: call {@link Enforcer.enforce} for any key, from any transport. */
export interface Enforcer {
  /** The resolved limiter (for introspection, headers/policy, or direct `check` use). */
  readonly limiter: Limiter;
  /** The store-outage policy applied inside {@link Enforcer.enforce}. */
  readonly fail: FailMode;
  /** Run the limit for `key` at `cost` (default 1) and classify the outcome. Never throws on a store outage. */
  enforce(key: string, cost?: number): Promise<EnforceResult>;
}

/**
 * Build a transport-agnostic {@link Enforcer} from a limiter (prebuilt or constructed inline) plus
 * the shared header/fail policy. `enforce` runs the limiter, applies the {@link FailMode} on a store
 * outage (so it never throws for that), and returns a neutral {@link EnforceResult} an adapter renders
 * however its transport demands.
 *
 * @example A minimal Web-`fetch` gate built directly on the enforcer:
 * ```ts
 * const { enforce } = createEnforcer({ strategy: gcra({ limit: 30, periodMs: 10_000 }) });
 * const r = await enforce(clientIpFrom(request));
 * if (!r.allowed) return new Response("Too Many Requests", { status: r.outcome === "limited" ? 429 : 503 });
 * ```
 */
export function createEnforcer(options: EnforceOptions): Enforcer {
  const gate = createGate(options);
  const onLimited = options.onLimited;
  const onError = options.onError;

  return {
    limiter: gate.limiter,
    fail: gate.fail,
    async enforce(key: string, cost = 1): Promise<EnforceResult> {
      let decision: Decision;
      try {
        decision = await gate.limiter.check(key, cost);
      } catch (err) {
        onError?.(key, err);
        // The store is unreachable: the fail policy — not a decision — settles admission.
        return {
          allowed: gate.fail === "open",
          outcome: "error",
          decision: undefined,
          headers: {},
          retryAfterMs: 0,
          error: err,
        };
      }

      const headers = gate.headersFor(decision);
      if (decision.allowed) {
        return { allowed: true, outcome: "ok", decision, headers, retryAfterMs: 0 };
      }
      onLimited?.(key, decision);
      return {
        allowed: false,
        outcome: "limited",
        decision,
        headers,
        retryAfterMs: decision.retryAfterMs,
      };
    },
  };
}
