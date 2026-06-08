import type { LimiterSpec } from "../../config";
import type { Decision } from "../../core/types";
import { type Candidate, type ComparabilityClass, resolveCandidate } from "./candidate";
import type { DivergenceReport } from "./divergence";
import { replay } from "./engine";
import { type ReplayRefusal, ReplayRefusedError } from "./errors";
import { DEFAULT_REDUCERS, type ScoreReducer } from "./score";
import type { ReplayTrace } from "./trace";

/**
 * Directional admit/deny flips vs the recording — the exact, strategy-agnostic headline of a what-if.
 * `allowedToDenied` = a request the recording admitted that the candidate denies (a *tightening*);
 * `deniedToAllowed` = the reverse (a *loosening*). `total` equals `DivergenceReport.flipped`.
 */
export interface DirectionalFlips {
  readonly allowedToDenied: number;
  readonly deniedToAllowed: number;
  readonly total: number;
}

/** One scored metric for one row. `comparable:false` ⇒ reported for context but not rankable for this row. */
export interface ScoreColumn {
  readonly id: string;
  readonly value: number;
  readonly kind: ScoreReducer["kind"];
  /** Whether this column is meaningfully comparable to the baseline for this row's class. */
  readonly comparable: boolean;
}

/** A loud refusal: the candidate's delta or rebuilt spec was invalid — never a silent zero-change row. */
export interface CandidateRefusal {
  readonly reason: ReplayRefusal;
  readonly message: string;
}

/** One candidate's row in the scorecard. */
export interface ScorecardRow {
  readonly name: string;
  readonly class: ComparabilityClass;
  readonly status: "ok" | "refused";
  /** Present when `status === "refused"` — the machine-readable reason + message. */
  readonly refusal?: CandidateRefusal;
  /** The resolved candidate spec (present once the delta resolved, even if rebuild later failed). */
  readonly spec?: LimiterSpec;
  /** Directional admit/deny flips vs the recording (present when `status === "ok"`). */
  readonly flips?: DirectionalFlips;
  /**
   * Steps differing on **any** decision field vs the recording (present when `status === "ok"`). Broader
   * than {@link DirectionalFlips}: it includes strategy-specific field noise (raising `limit` shifts
   * `remaining` on every step), so it is context, not the headline. `flips` is the admit/deny signal.
   */
  readonly divergent?: number;
  /** Scored columns over the candidate's replayed decisions (empty when refused). */
  readonly columns: readonly ScoreColumn[];
}

/** The result of comparing candidates against a recorded trace. */
export interface Scorecard {
  /** Columns scored over the recorded decisions — the reference every row is read against. */
  readonly baseline: { readonly columns: readonly ScoreColumn[] };
  /** One row per candidate, in input order. */
  readonly rows: readonly ScorecardRow[];
}

/** Options for {@link scorecard}. */
export interface ScorecardOptions {
  /** Metrics to score (default {@link DEFAULT_REDUCERS}). */
  readonly reducers?: readonly ScoreReducer[];
}

function refusalOf(e: unknown): CandidateRefusal {
  if (e instanceof ReplayRefusedError) return { reason: e.reason, message: e.message };
  // buildStrategy / rebuild throw a ThrottleKitError (e.g. a swap missing a required field) — that is
  // still an invalid candidate spec, surfaced loudly under the candidate-invalid reason.
  return { reason: "candidate-invalid", message: e instanceof Error ? e.message : String(e) };
}

/**
 * Best-effort comparability class for a candidate that failed to **resolve** (so it has no resolved
 * spec): derived from whether any op targets the strategy, so a refused strategy-swap is labelled
 * `cross-strategy`, not mislabelled `comparable`. A refused row carries no columns and is never ranked,
 * so this is advisory honesty, not a load-bearing value.
 */
function intendedClass(base: LimiterSpec, cand: Candidate): ComparabilityClass {
  let strategy: LimiterSpec["strategy"] = base.strategy;
  for (const op of cand.ops) {
    if (op.kind === "swap") strategy = op.strategy;
    else if (op.kind === "set" && op.path === "strategy")
      strategy = op.value as LimiterSpec["strategy"];
  }
  return strategy !== base.strategy ? "cross-strategy" : "comparable";
}

/** Directional flips from a divergence report: which way each `allowed` change went. */
function directionalFlips(div: DivergenceReport): DirectionalFlips {
  let allowedToDenied = 0;
  let deniedToAllowed = 0;
  for (const step of div.steps) {
    const f = step.diffs.find((d) => d.field === "allowed");
    if (f === undefined) continue;
    if (f.recorded === true && f.replayed === false) allowedToDenied++;
    else if (f.recorded === false && f.replayed === true) deniedToAllowed++;
  }
  return { allowedToDenied, deniedToAllowed, total: allowedToDenied + deniedToAllowed };
}

function score(
  reducers: readonly ScoreReducer[],
  decisions: readonly Decision[],
  klass: ComparabilityClass,
): ScoreColumn[] {
  return reducers.map((r) => ({
    id: r.id,
    value: r.reduce(decisions),
    kind: r.kind,
    // A same-strategy metric is only comparable on a row whose strategy is unchanged.
    comparable: r.comparableAcross === "any" || klass === "comparable",
  }));
}

function scoreCandidate(
  trace: ReplayTrace,
  cand: Candidate,
  reducers: readonly ScoreReducer[],
): ScorecardRow {
  let spec: LimiterSpec;
  let klass: ComparabilityClass;
  try {
    const resolved = resolveCandidate(trace, cand);
    spec = resolved.spec;
    klass = resolved.class;
  } catch (e) {
    // The delta itself was ill-formed — no spec to report; class is best-effort from the ops.
    return {
      name: cand.name,
      class: intendedClass(trace.fingerprint.spec, cand),
      status: "refused",
      refusal: refusalOf(e),
      columns: [],
    };
  }

  try {
    // Identity was proved once up front, so skip the per-candidate self-check.
    const result = replay(trace, { candidate: spec, skipIdentityCheck: true });
    return {
      name: cand.name,
      class: klass,
      status: "ok",
      spec,
      flips: directionalFlips(result.divergence),
      divergent: result.divergence.divergent,
      columns: score(reducers, result.replayed, klass),
    };
  } catch (e) {
    // The delta resolved but the spec could not be rebuilt/replayed (e.g. a swap missing a field).
    return {
      name: cand.name,
      class: klass,
      status: "refused",
      refusal: refusalOf(e),
      spec,
      columns: [],
    };
  }
}

/**
 * Score a list of candidate what-ifs against a recorded decision trace.
 *
 * The trust precondition runs **once**: an identity self-check (replay the recorded spec, assert it
 * reproduces the recording bit-for-bit). If it fails — or the trace is itself unreplayable (truncated /
 * malformed / non-rate) — `scorecard` **throws** (the whole comparison is untrustworthy; it does not emit
 * misleading rows). Each candidate is then scored **failure-isolated**: an ill-formed delta or an
 * unbuildable spec becomes a loud `refused` row carrying the reason, never a silent zero-change result, so
 * one bad candidate does not sink the batch.
 *
 * Each row carries the exact, strategy-agnostic {@link DirectionalFlips} headline plus the reducer
 * columns; a `cross-strategy` row's strategy-specific columns are flagged `comparable:false` (reported,
 * not ranked).
 *
 * @experimental Part of the opt-in replay testkit (see STABILITY.md).
 */
export function scorecard(
  trace: ReplayTrace,
  candidates: readonly Candidate[],
  options: ScorecardOptions = {},
): Scorecard {
  const reducers = options.reducers ?? DEFAULT_REDUCERS;

  // Identity self-check ONCE — the trust precondition for the whole card. Throws on a broken substrate or
  // an unreplayable trace (assertReplayableTrace runs inside replay()).
  replay(trace);

  const recorded = trace.steps.map((s) => s.decision);
  const baseline = { columns: score(reducers, recorded, "comparable") };
  const rows = candidates.map((cand) => scoreCandidate(trace, cand, reducers));
  return { baseline, rows };
}

/**
 * The successfully-scored rows, ordered by **most behavioural change first** (descending total flips) —
 * the universally-valid ranking (admit/deny flips compare across any strategy). Refused rows are omitted;
 * read their `refusal` directly. Strategy-specific columns remain only comparable within a class.
 */
export function rankByFlips(card: Scorecard): readonly ScorecardRow[] {
  return card.rows
    .filter((r) => r.status === "ok")
    .slice()
    .sort((a, b) => (b.flips?.total ?? 0) - (a.flips?.total ?? 0));
}
