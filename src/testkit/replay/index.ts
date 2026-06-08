/**
 * What-If Replay (#281) — P1 library primitives. Record a leaf limiter's synchronous decisions into a
 * self-contained, deterministic trace, then replay that trace — against the recorded policy (an
 * identity self-check that proves bit-exact reproducibility) or against a single-field **candidate**
 * policy (a what-if: how many admit/deny decisions would change).
 *
 * Built on the #286 determinism substrate: a strategy's transition is a pure function of
 * `(state, now, cost)`, and a limiter rebuilt over `MemoryStore({ sweepIntervalMs: 0 })` sharing one
 * `ManualClock` reproduces a recording exactly. Scope (v1): leaf `Limiter`, synchronous `check`,
 * `ManualClock` only — concurrency is not a decision axis and is refused, fail-loud.
 *
 * @experimental Opt-in; excluded from the `1.x` SemVer guarantee (see STABILITY.md).
 *
 * @example
 * import { ManualClock } from "throttlekit";
 * import { recordLimiter, replay, candidateField } from "throttlekit/testkit";
 *
 * const rec = recordLimiter({ strategy: "fixedWindow", limit: 3, windowMs: 1000 });
 * for (let i = 0; i < 5; i++) rec.limiter.checkSync("user-1"); // 3 allow, 2 deny
 * const trace = rec.trace();
 *
 * replay(trace);                                                   // identity: zero divergence (or throws)
 * const r = replay(trace, { candidate: candidateField(trace, "limit", 5) });
 * console.log(`${r.divergence.flipped} request(s) would change`);  // → 2
 */

export { ReplayRefusedError, type ReplayRefusal } from "./errors";
export {
  type Candidate,
  type CandidateOp,
  type ComparabilityClass,
  type ResolvedCandidate,
  type ScaleOp,
  type SetOp,
  type SpecPath,
  type SwapOp,
  candidate,
  resolveCandidate,
  scale,
  set,
  swap,
} from "./candidate";
export {
  type DecisionField,
  type DivergenceReport,
  type DivergenceStep,
  type FieldDiff,
  assertAcceptable,
  diffDecision,
  divergence,
  isIdentical,
} from "./divergence";
export {
  type ComparableAcross,
  type MetricKind,
  type ScoreReducer,
  DEFAULT_REDUCERS,
  allowCount,
  allowRate,
  denyCount,
  quantile,
  remainingP50,
  retryP99,
} from "./score";
export {
  type CandidateRefusal,
  type DirectionalFlips,
  type Scorecard,
  type ScorecardOptions,
  type ScorecardRow,
  type ScoreColumn,
  rankByFlips,
  scorecard,
} from "./scorecard";
export {
  type ReplayOptions,
  type ReplayResult,
  candidateField,
  replay,
} from "./engine";
export { assertReplayable, assertReplayableTrace, isRebuildableStrategy } from "./guards";
export { type RebuildOptions, rebuildLimiter } from "./rebuild";
export { type RecordOptions, type Recording, recordLimiter } from "./recorder";
export {
  type ReplayAxis,
  type ReplayClockSource,
  type ReplayFingerprint,
  type StrategyIdentity,
  fingerprint,
  luaSha1,
} from "./spec";
export {
  TRACE_FORMAT_VERSION,
  type ReplayStep,
  type ReplayTrace,
  assertWellFormedTrace,
  parseTrace,
  serializeTrace,
} from "./trace";
