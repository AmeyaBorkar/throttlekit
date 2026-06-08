import type { LimiterSpec } from "../../config";
import { ManualClock } from "../../core/clock";
import type { Decision } from "../../core/types";
import { type DivergenceReport, assertAcceptable, divergence } from "./divergence";
import { assertReplayable, assertReplayableTrace } from "./guards";
import { rebuildLimiter } from "./rebuild";
import type { ReplayTrace } from "./trace";

export interface ReplayOptions {
  /**
   * A candidate spec — the what-if. Omit for an **identity** replay (rebuild the recorded spec and
   * confirm it reproduces the recording bit-for-bit). With a candidate, the divergence of the
   * candidate's decisions from the recording is the result.
   */
  readonly candidate?: LimiterSpec;
  /**
   * Skip the identity self-check that runs before a candidate replay. OFF by default — the self-check
   * is the trust precondition: it proves the trace replays faithfully, so any candidate divergence is
   * attributable to the candidate, not a broken substrate.
   */
  readonly skipIdentityCheck?: boolean;
}

export interface ReplayResult {
  /** The decisions re-derived by replay (against the candidate if given, else the recorded spec). */
  readonly replayed: readonly Decision[];
  /** Divergence of `replayed` from the recorded decisions. Empty for an identity replay. */
  readonly divergence: DivergenceReport;
  /** The spec replay ran (`candidate` when given, else the recorded spec). */
  readonly spec: LimiterSpec;
  /** Whether a candidate (what-if) spec was used. */
  readonly isCandidate: boolean;
}

/**
 * Drive every recorded step through a freshly-rebuilt cold limiter. The clock is `set()` to each
 * step's absolute instant (never an accumulated delta), so coincident instants (zero delta) and any
 * recorded ordering reproduce exactly. When `verify` is set the rebuilt strategy is cross-checked
 * against the recorded fingerprint (identity + Lua-SHA-1) — meaningful only for an identity rebuild.
 */
function drive(trace: ReplayTrace, spec: LimiterSpec, verify: boolean): Decision[] {
  const first = trace.steps[0]?.at ?? 0;
  const clock = new ManualClock(first);
  const limiter = rebuildLimiter(spec, {
    clock,
    name: trace.fingerprint.strategy.name,
    ...(trace.fingerprint.prefix !== undefined ? { prefix: trace.fingerprint.prefix } : {}),
  });
  if (verify) assertReplayable(trace.fingerprint, limiter.strategy);
  const out: Decision[] = new Array(trace.steps.length);
  for (let i = 0; i < trace.steps.length; i++) {
    const step = trace.steps[i] as ReplayTrace["steps"][number];
    clock.set(step.at);
    out[i] = limiter.checkSync(step.key, step.cost);
  }
  return out;
}

/**
 * Replay a decision trace. Two modes:
 *
 * - **Identity** (no candidate): rebuild the recorded spec, reproduce the recording, and assert zero
 *   divergence. A non-zero divergence throws `identity-divergence` — the determinism substrate is
 *   broken. This is the v1 deliverable's core guarantee.
 * - **Candidate** (a what-if spec): first run the identity self-check (unless `skipIdentityCheck`), so
 *   the reported divergence is attributable to the candidate; then rebuild the candidate, reproduce the
 *   same `(key, cost, at)` stream, and return the divergence (its `flipped` count is the headline
 *   "how many requests would this change").
 *
 * Pairs with {@link candidateField} for the single-field what-if of v1.
 *
 * @experimental Part of the opt-in replay testkit (see STABILITY.md).
 */
export function replay(trace: ReplayTrace, options: ReplayOptions = {}): ReplayResult {
  assertReplayableTrace(trace);

  if (options.candidate === undefined) {
    const replayed = drive(trace, trace.fingerprint.spec, true);
    const div = divergence(trace.steps, replayed);
    assertAcceptable(div); // throws identity-divergence if the substrate broke
    return { replayed, divergence: div, spec: trace.fingerprint.spec, isCandidate: false };
  }

  if (!options.skipIdentityCheck) {
    assertAcceptable(divergence(trace.steps, drive(trace, trace.fingerprint.spec, true)));
  }
  const replayed = drive(trace, options.candidate, false);
  const div = divergence(trace.steps, replayed);
  return { replayed, divergence: div, spec: options.candidate, isCandidate: true };
}

/**
 * Single-field what-if: clone the trace's recorded spec with exactly **one** field overridden — the
 * v1 candidate form (a multi-field DSL is P2/#288). Type-checked to a real `LimiterSpec` field; the
 * resulting spec is validated when {@link replay} rebuilds it (e.g. an unrebuildable strategy is
 * refused).
 *
 * @example
 * const result = replay(trace, { candidate: candidateField(trace, "limit", 200) });
 * console.log(`${result.divergence.flipped} request(s) would change at limit=200`);
 */
export function candidateField<K extends keyof LimiterSpec>(
  trace: ReplayTrace,
  field: K,
  value: LimiterSpec[K],
): LimiterSpec {
  return { ...trace.fingerprint.spec, [field]: value };
}
