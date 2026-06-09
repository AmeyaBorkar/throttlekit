import type { Recording } from "../testkit/replay/recorder";
import type { ReplayTrace } from "../testkit/replay/trace";

/**
 * One recorded arrival — the `(key, cost, instant)` inputs a policy saw, *without* the recorded decision.
 * A {@link plan} re-derives the baseline by cold-replaying the *current* policy over these arrivals, so
 * the diff is candidate-vs-current-from-a-clean-start over your real arrival timing — never a comparison
 * against a warm production node's exact decisions (which a cold replay cannot reproduce; see DESIGN §4).
 */
export interface Arrival {
  readonly key: string;
  readonly cost: number;
  readonly at: number;
}

/** One policy's slice of the corpus: its arrival stream, whether the source was capped, and trace count. */
export interface PolicyCorpus {
  readonly arrivals: readonly Arrival[];
  /** True if any source trace hit its recording cap — the arrivals are a prefix, so a diff understates. */
  readonly truncated: boolean;
  readonly traces: number;
}

/** Recorded traffic to plan against, grouped by policy name. */
export type TraceCorpus = Readonly<Record<string, PolicyCorpus>>;

/** Extract the arrival stream `(key, cost, at)` from a recorded {@link ReplayTrace}. */
export function arrivalsFromTrace(trace: ReplayTrace): Arrival[] {
  return trace.steps.map((s) => ({ key: s.key, cost: s.cost, at: s.at }));
}

/** Fold one or more traces (for the same policy) into a {@link PolicyCorpus}. */
export function policyCorpus(traces: readonly ReplayTrace[]): PolicyCorpus {
  const arrivals: Arrival[] = [];
  let truncated = false;
  for (const t of traces) {
    if (t.truncated) truncated = true;
    for (const s of t.steps) arrivals.push({ key: s.key, cost: s.cost, at: s.at });
  }
  return { arrivals, truncated, traces: traces.length };
}

function asArray<T>(v: T | readonly T[]): readonly T[] {
  return Array.isArray(v) ? (v as readonly T[]) : [v as T];
}

/**
 * Build a corpus from recorded {@link ReplayTrace}s, keyed by policy name (each value is one trace or an
 * array of traces). Manual-clock traces (from `recordLimiter` or the server shadow) are replayable as-is.
 *
 * @experimental Part of the opt-in Policy Plans surface; see STABILITY.md.
 */
export function corpusFromTraces(
  traces: Readonly<Record<string, ReplayTrace | readonly ReplayTrace[]>>,
): TraceCorpus {
  const out: Record<string, PolicyCorpus> = {};
  for (const [name, t] of Object.entries(traces)) out[name] = policyCorpus(asArray(t));
  return out;
}

/** Build a corpus directly from `recordLimiter` {@link Recording}s, keyed by policy name. */
export function corpusFromRecordings(
  recordings: Readonly<Record<string, Recording | readonly Recording[]>>,
): TraceCorpus {
  const out: Record<string, PolicyCorpus> = {};
  for (const [name, r] of Object.entries(recordings))
    out[name] = policyCorpus(asArray(r).map((rec) => rec.trace()));
  return out;
}

/** An empty corpus — every policy then plans to the honest `empty` state (nothing to diff). */
export function emptyCorpus(): TraceCorpus {
  return {};
}
