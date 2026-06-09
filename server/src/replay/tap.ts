/**
 * Wrap a {@link RateLimiterService} so each **leaf-rate** decision is also fed to the deterministic-capture
 * shadows — **after** the inner service produced it, so the shadow can never change, delay, or break a
 * decision. Only `check` / `checkMany` feed (a leaf-rate policy is served there); `debit` (meter) and
 * `admit` (admitter) are not leaf-rate, so feeding them would never match a shadow — they pass straight
 * through. `feed` is O(1), synchronous, exception-swallowing, and runs over the shadow's isolated store, so
 * this adds a bounded, never-throw tail. When replay is off (or no shadow was built) the inner service is
 * returned **unwrapped** (zero overhead). Compose this around the capture tap (or the bare service).
 */

import type { Decision } from "throttlekit";
import type { AdmitOptions, AdmitResult, HeartbeatResult, RateLimiterService } from "../service.js";
import type { WiredReplay } from "./wire.js";

/** Return `inner` wrapped to feed each leaf-rate decision into the shadows — or `inner` itself when off. */
export function replayService(inner: RateLimiterService, replay: WiredReplay): RateLimiterService {
  if (!replay.enabled || replay.shadows.size === 0) return inner; // nothing to feed ⇒ no wrapping cost

  return {
    policies: () => inner.policies(),

    async check(policy, key, cost = 1): Promise<Decision> {
      const decision = await inner.check(policy, key, cost);
      replay.feed(policy, key, cost);
      return decision;
    },

    async checkMany(policy, keys, cost = 1): Promise<Decision[]> {
      const decisions = await inner.checkMany(policy, keys, cost);
      for (const key of keys) replay.feed(policy, key, cost);
      return decisions;
    },

    // Non-leaf-rate / non-consuming / lifecycle ops pass straight through — they never match a shadow.
    peek: (policy, key) => inner.peek(policy, key),
    forecast: (policy, key, cost) => inner.forecast(policy, key, cost),
    debit: (policy, key, tokens) => inner.debit(policy, key, tokens),
    admit: (policy, key, opts?: AdmitOptions): Promise<AdmitResult> =>
      inner.admit(policy, key, opts),
    release: (leaseId, dropped) => inner.release(leaseId, dropped),
    heartbeat: (leaseIds): HeartbeatResult => inner.heartbeat(leaseIds),
    sweep: () => inner.sweep(),
    close: () => inner.close?.() ?? Promise.resolve(), // forward fleet-guard shutdown (SC-16)
  };
}
