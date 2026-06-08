import type { Decision } from "../../core/types";
import { ReplayRefusedError } from "./errors";
import type { ReplayStep } from "./trace";

/**
 * The five frozen {@link Decision} fields compared for divergence. This is deliberately a fixed field
 * list, **not** a structural deep-equal: `Decision` is a producer type that may grow by appending
 * optional fields (STABILITY.md), and a future optional field must never make a faithful replay look
 * divergent. Mirrors the `differs()` predicate the #286 cross-store gate uses.
 */
export type DecisionField = "allowed" | "limit" | "remaining" | "resetAt" | "retryAfterMs";

/** One field that differs between the recorded and replayed {@link Decision}. */
export interface FieldDiff {
  readonly field: DecisionField;
  readonly recorded: number | boolean;
  readonly replayed: number | boolean;
}

/** Field-level diff of two Decisions. An empty array means bit-identical on the frozen fields. */
export function diffDecision(recorded: Decision, replayed: Decision): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  if (recorded.allowed !== replayed.allowed)
    diffs.push({ field: "allowed", recorded: recorded.allowed, replayed: replayed.allowed });
  if (recorded.limit !== replayed.limit)
    diffs.push({ field: "limit", recorded: recorded.limit, replayed: replayed.limit });
  if (recorded.remaining !== replayed.remaining)
    diffs.push({ field: "remaining", recorded: recorded.remaining, replayed: replayed.remaining });
  if (recorded.resetAt !== replayed.resetAt)
    diffs.push({ field: "resetAt", recorded: recorded.resetAt, replayed: replayed.resetAt });
  if (recorded.retryAfterMs !== replayed.retryAfterMs)
    diffs.push({
      field: "retryAfterMs",
      recorded: recorded.retryAfterMs,
      replayed: replayed.retryAfterMs,
    });
  return diffs;
}

/** A step at which replay diverged from the recording. */
export interface DivergenceStep {
  readonly index: number;
  readonly key: string;
  readonly cost: number;
  readonly at: number;
  readonly diffs: readonly FieldDiff[];
  /** True when `allowed` flipped — the headline what-if signal (an allow became a deny, or vice-versa). */
  readonly flipped: boolean;
}

/** The result of comparing a replay's decisions against the recorded ones. */
export interface DivergenceReport {
  /** Steps compared (`min(recorded, replayed)` — equal by construction for an engine replay). */
  readonly total: number;
  /** Steps with at least one differing field. */
  readonly divergent: number;
  /** Steps where `allowed` flipped — the count that matters for a what-if. */
  readonly flipped: number;
  /** Index of the first divergent step, or `-1` when none. */
  readonly firstDivergenceIndex: number;
  /** The divergent steps only (an identical replay yields `[]`). */
  readonly steps: readonly DivergenceStep[];
}

/** Compare recorded steps against a replay's decisions, returning a {@link DivergenceReport}. */
export function divergence(
  recorded: readonly ReplayStep[],
  replayed: readonly Decision[],
): DivergenceReport {
  const steps: DivergenceStep[] = [];
  let flipped = 0;
  let firstDivergenceIndex = -1;
  const total = Math.min(recorded.length, replayed.length);
  for (let i = 0; i < total; i++) {
    const step = recorded[i] as ReplayStep;
    const diffs = diffDecision(step.decision, replayed[i] as Decision);
    if (diffs.length === 0) continue;
    if (firstDivergenceIndex === -1) firstDivergenceIndex = i;
    const flip = diffs.some((d) => d.field === "allowed");
    if (flip) flipped++;
    steps.push({ index: i, key: step.key, cost: step.cost, at: step.at, diffs, flipped: flip });
  }
  return { total, divergent: steps.length, flipped, firstDivergenceIndex, steps };
}

/** Whether a report shows zero divergence. */
export function isIdentical(report: DivergenceReport): boolean {
  return report.divergent === 0;
}

/**
 * The identity self-check, as an assertion: throw `identity-divergence` unless `report` is fully
 * identical. Used after replaying the **recorded** spec — a non-zero divergence there means the
 * determinism substrate is broken, so any what-if built on it is meaningless and must be refused.
 */
export function assertAcceptable(report: DivergenceReport): void {
  if (report.divergent === 0) return;
  const f = report.steps[0];
  const detail = f
    ? `First diff at step ${f.index} (key=${JSON.stringify(f.key)}, at=${f.at}): ${f.diffs.map((d) => `${d.field} ${d.recorded}→${d.replayed}`).join(", ")}`
    : "";
  throw new ReplayRefusedError(
    "identity-divergence",
    `replay: identity self-check FAILED — replaying the recorded spec diverged from the recording (${report.divergent}/${report.total} steps differ). The determinism substrate is broken; refusing to report. ${detail}`,
  );
}
