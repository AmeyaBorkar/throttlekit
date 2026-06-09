/**
 * Wrap a {@link RateLimiterService} so every consuming decision is also handed to the capture recorder —
 * **after** the inner service has produced it, so capture can never change, delay, or break a decision.
 * `recorder.record()` is O(1), synchronous, and exception-swallowing, so this adds a bounded, never-throw
 * tail to each call. When capture is disabled the inner service is returned **unwrapped** (zero overhead).
 *
 * Non-consuming ops (`peek`/`forecast`) and lifecycle ops (`release`/`heartbeat`/`sweep`/`policies`) are
 * pure pass-throughs — only the decisions a policy actually *made* are recorded.
 */

import type { Decision } from "throttlekit";
import type { AdmitOptions, AdmitResult, HeartbeatResult, RateLimiterService } from "../service.js";
import type { CaptureRecorder } from "./recorder.js";

/** Return `inner` wrapped to record each decision into `recorder` — or `inner` itself when capture is off. */
export function captureService(
  inner: RateLimiterService,
  recorder: CaptureRecorder,
): RateLimiterService {
  if (!recorder.enabled) return inner; // no wrapping, no per-call cost when capture is disabled

  return {
    policies: () => inner.policies(),

    async check(policy, key, cost = 1): Promise<Decision> {
      const decision = await inner.check(policy, key, cost);
      recorder.record({ policy, key, cost, decision });
      return decision;
    },

    async checkMany(policy, keys, cost = 1): Promise<Decision[]> {
      const decisions = await inner.checkMany(policy, keys, cost);
      for (let i = 0; i < keys.length; i++) {
        const decision = decisions[i];
        const key = keys[i];
        if (decision !== undefined && key !== undefined)
          recorder.record({ policy, key, cost, decision });
      }
      return decisions;
    },

    peek: (policy, key) => inner.peek(policy, key),
    forecast: (policy, key, cost) => inner.forecast(policy, key, cost),

    async debit(policy, key, tokens = 1): Promise<Decision> {
      const decision = await inner.debit(policy, key, tokens);
      recorder.record({ policy, key, cost: tokens, decision });
      return decision;
    },

    async admit(policy, key, opts?: AdmitOptions): Promise<AdmitResult> {
      const result = await inner.admit(policy, key, opts);
      recorder.record({ policy, key, cost: opts?.cost ?? 1, decision: result.decision });
      return result;
    },

    release: (leaseId, dropped) => inner.release(leaseId, dropped),
    heartbeat: (leaseIds): HeartbeatResult => inner.heartbeat(leaseIds),
    sweep: () => inner.sweep(),
    close: () => inner.close?.() ?? Promise.resolve(), // forward fleet-guard shutdown (SC-16)
  };
}
