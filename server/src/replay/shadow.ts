/**
 * The deterministic-capture **shadow** (#299) — the replayable trace source the forensic capture (#289)
 * cannot be. For one leaf-rate policy it holds an isolated `recordLimiter` (which builds its *own* cold
 * `MemoryStore` + `ManualClock`, per the testkit), and `feed`s it each live decision's `(key, cost)` as a
 * post-decision, O(1), **never-throw** tail with the shadow's clock advanced to wall-clock. The resulting
 * trace is a genuine `clock:"manual"`, full-spec, cold-start `ReplayTrace` → actually replayable.
 *
 * **It cannot perturb production.** The shadow runs over its own store/clock and records its *own* decision;
 * production's decision is never read or changed. This is a stronger control-path guarantee than the
 * forensic tap (which at least reads the live decision).
 *
 * **Bounded (the load-bearing OOM guard).** `recordLimiter.checkSync` always runs its inner `checkSync`
 * (growing its MemoryStore + its `originalOf` map per distinct key) even past its own cap, so a naive shadow
 * fed a distinct-key flood would grow without limit. We therefore **stop feeding at `maxSteps`** — the
 * shadow's store-cardinality, its ring, and its key-map are all capped at `maxSteps`. Past the cap the trace
 * is honestly `truncated` (replay then refuses it, never understating a what-if).
 *
 * **PII-clean.** Keys are redacted **upstream** by the server {@link Redactor} (bounded, witness-based, no
 * raw retention) and the shadow is fed the *redacted ref*; `recordLimiter` gets an identity `redactKey`, so
 * its `originalOf` map holds `ref → ref` (never a raw key) and the trace is honestly stamped `redacted`.
 */

import type { LimiterSpec } from "throttlekit/config";
import { type ReplayTrace, recordLimiter } from "throttlekit/testkit";
import type { Redactor } from "../capture/redact.js";

/** Options for {@link createShadow}. */
export interface ShadowOptions {
  /** Reused server redactor — redacts the key (PII) before it ever enters the shadow. */
  readonly redactor: Redactor;
  /** Per-policy step cap = the OOM bound: feeding stops here, so the shadow store can't grow past it. */
  readonly maxSteps: number;
  /** Wall-clock source (epoch-ms), injected for deterministic tests. Default `Date.now`. */
  readonly now?: () => number;
}

/** A per-policy deterministic-capture shadow. */
export interface Shadow {
  /** Record one live decision's inputs. O(1), never throws (a capture fault can't reach the control path). */
  feed(key: string, cost?: number): void;
  /** Snapshot the replayable trace recorded so far (flagged `truncated` once the cap was hit). */
  trace(): ReplayTrace;
  /** Steps recorded so far (≤ `maxSteps`). */
  readonly steps: number;
  /** True once the cap was hit and at least one decision was dropped — the trace is a faithful prefix. */
  readonly truncated: boolean;
  /** True if a redaction collision poisoned the shadow (astronomically rare) — what-if then refuses it. */
  readonly poisoned: boolean;
}

/**
 * Build a shadow for `spec` (a leaf-rate `LimiterSpec`). Throws if `spec` is not rebuildable by the testkit
 * (an unrebuildable strategy / non-leaf) — the caller (wiring) only builds shadows for leaf-rate policies
 * and skips the rest, so a throw here is a misconfiguration, not a runtime hazard.
 */
export function createShadow(spec: LimiterSpec, options: ShadowOptions): Shadow {
  const now = options.now ?? ((): number => Date.now());
  const maxSteps = Math.max(1, Math.floor(options.maxSteps));
  // recordLimiter owns its cold MemoryStore + ManualClock. Identity `redactKey` because we pre-redact
  // upstream: it keeps recordLimiter's collision map PII-free (ref→ref) and stamps the trace `redacted:true`.
  const recording = recordLimiter(spec, { redactKey: (k) => k, maxSteps });

  let fed = 0;
  let rejected = 0;
  let poisoned = false;
  let lastAt = Number.NEGATIVE_INFINITY;

  const feed = (key: string, cost = 1): void => {
    if (poisoned) return;
    if (!(cost > 0) || !Number.isFinite(cost)) return; // a non-positive cost can't be a rate decision
    if (fed >= maxSteps) {
      rejected++; // STOP — never touch the shadow past the cap (the OOM bound)
      return;
    }
    try {
      const ref = options.redactor.redact(key); // bounded + witness-based; throws only on a real collision
      const t = now();
      const at = lastAt > t ? lastAt : t; // clamp non-decreasing (NTP backstep safe); now() read once
      lastAt = at;
      recording.clock.set(at);
      recording.limiter.checkSync(ref, cost); // the shadow's OWN store — production is untouched
      fed++;
    } catch {
      // A capture fault must never reach the decision path. A redaction collision (negligible with full
      // HMAC) poisons the shadow so the what-if refuses it honestly rather than reporting a wrong trace.
      poisoned = true;
    }
  };

  const trace = (): ReplayTrace => {
    const t = recording.trace();
    if (rejected === 0) return t;
    // Surface OUR cap as truncation IN the trace, so replay()'s own guard refuses it (honest, not silent).
    return { ...t, truncated: true, dropped: rejected };
  };

  return {
    feed,
    trace,
    get steps(): number {
      return fed;
    },
    get truncated(): boolean {
      return rejected > 0;
    },
    get poisoned(): boolean {
      return poisoned;
    },
  };
}
