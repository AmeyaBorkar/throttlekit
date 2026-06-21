import type { LimiterSpec } from "../config";
import { ManualClock } from "../core/clock";
import type { DivergenceReport } from "../testkit/replay/divergence";
import { replay } from "../testkit/replay/engine";
import { type ReplayRefusal, ReplayRefusedError } from "../testkit/replay/errors";
import { recordLimiter } from "../testkit/replay/recorder";
import type { ReplayTrace } from "../testkit/replay/trace";
import type { PolicySet } from "./artifact";
import type { Arrival, PolicyCorpus, TraceCorpus } from "./corpus";

/** Default number of top flipped keys/tenants reported per policy. */
export const DEFAULT_TOP_FLIPPED_KEYS = 10;

/**
 * The honest outcome for one policy's diff. Never a fabricated zero:
 * - `ok` — replayed cleanly; the flip ledger is exact.
 * - `empty` — no recorded traffic for this policy (nothing to diff).
 * - `truncated` — the corpus was a prefix (a source trace hit its cap); the ledger covers the prefix and
 *   *understates* the full effect.
 * - `not-replayable` — a known non-rate axis (concurrency / escrow / joint-LP): observe live via attribution.
 * - `refused` — a replay precondition was violated (carries the {@link ReplayRefusal} reason).
 */
export type PolicyDiffState = "ok" | "empty" | "truncated" | "not-replayable" | "refused";

/** A key/tenant whose admit/deny decision flipped, and in which direction(s). */
export interface KeyFlip {
  readonly key: string;
  readonly allowToDeny: number;
  readonly denyToAllow: number;
  readonly total: number;
}

export interface PolicyDiffRefusal {
  readonly reason: ReplayRefusal | "not-replayable";
  readonly message: string;
}

/** One policy's decision diff: the candidate vs the current-cold baseline over the recorded arrivals. */
export interface PolicyDiff {
  readonly policy: string;
  readonly state: PolicyDiffState;
  /** Requests the current policy admitted that the candidate would deny (a *tightening* — the blast radius). */
  readonly allowToDeny: number;
  /** Requests the current policy denied that the candidate would admit (a *loosening*). */
  readonly denyToAllow: number;
  /** `allowToDeny + denyToAllow` (== the divergence report's `flipped`). */
  readonly flippedTotal: number;
  /** Steps differing on any decision field (context — raising a limit shifts `remaining` everywhere). */
  readonly divergent: number;
  /** Arrivals replayed. */
  readonly steps: number;
  /** Distinct keys/tenants with at least one flip. */
  readonly affectedKeys: number;
  readonly topFlippedKeys: readonly KeyFlip[];
  readonly refusal?: PolicyDiffRefusal;
}

export interface PlanSummary {
  readonly policies: number;
  /** Policies in state `ok` or `truncated` (the diffs that produced a ledger). */
  readonly replayable: number;
  readonly allowToDeny: number;
  readonly denyToAllow: number;
  readonly flippedTotal: number;
  readonly affectedKeys: number;
  /** Policy names present in the candidate but not the current set. */
  readonly added: readonly string[];
  /** Policy names present in the current set but not the candidate. */
  readonly removed: readonly string[];
}

/** The whole plan: a serializable, diffable, CI-gateable artifact. */
export interface Plan {
  readonly current: { readonly contentHash: string; readonly label?: string };
  readonly candidate: { readonly contentHash: string; readonly label?: string };
  readonly corpus: {
    readonly policies: number;
    readonly steps: number;
    readonly truncated: boolean;
  };
  readonly diffs: readonly PolicyDiff[];
  readonly summary: PlanSummary;
}

export interface PlanOptions {
  /** How many top flipped keys to report per policy (default {@link DEFAULT_TOP_FLIPPED_KEYS}). */
  readonly topFlippedKeys?: number;
}

/**
 * Diff a candidate policy set against the current one over recorded traffic — the hero of Policy Plans.
 *
 * For each policy present in **both** sets, it cold-records the *current* spec over that policy's recorded
 * arrivals to derive the baseline, then replays the *candidate* spec over the same arrivals and folds the
 * divergence into a directional flip ledger + top movers. The baseline is therefore always the current
 * policy from a clean start (never stale, never a warm-production comparison). Policies only in the
 * candidate / current set are reported as added / removed; declared non-replayable axes are surfaced as
 * `not-replayable` rows. **Pure and never-throws** — every unreplayable policy maps to a typed state, so a
 * caller can always read a result.
 *
 * @experimental Part of the opt-in Policy Plans surface (`throttlekit/policy`); see STABILITY.md.
 */
export function plan(
  current: PolicySet,
  candidate: PolicySet,
  corpus: TraceCorpus,
  options: PlanOptions = {},
): Plan {
  const topK = options.topFlippedKeys ?? DEFAULT_TOP_FLIPPED_KEYS;
  const currentByName = new Map(current.policies.map((p) => [p.name, p] as const));
  const candByName = new Map(candidate.policies.map((p) => [p.name, p] as const));

  const added = [...candByName.keys()].filter((n) => !currentByName.has(n)).sort();
  const removed = [...currentByName.keys()].filter((n) => !candByName.has(n)).sort();

  const diffs: PolicyDiff[] = [];
  let corpusSteps = 0;
  let corpusTruncated = false;
  const corpusPolicies = Object.keys(corpus).length;

  const sortedCandidates = [...candByName.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  for (const [name, cand] of sortedCandidates) {
    const cur = currentByName.get(name);
    if (cur === undefined) continue; // added → summary only (no current baseline to diff against)
    const pc = corpus[name];
    if (pc !== undefined) {
      corpusSteps += pc.arrivals.length;
      if (pc.truncated) corpusTruncated = true;
    }
    diffs.push(diffPolicy(name, cur.spec, cand.spec, pc, topK));
  }

  for (const u of candidate.unreplayable ?? []) {
    diffs.push({
      ...zeroLedger(u.name, "not-replayable"),
      refusal: { reason: "not-replayable", message: u.reason },
    });
  }

  const ledgered = diffs.filter((d) => d.state === "ok" || d.state === "truncated");
  const summary: PlanSummary = {
    policies: diffs.length,
    replayable: ledgered.length,
    allowToDeny: sum(ledgered, (d) => d.allowToDeny),
    denyToAllow: sum(ledgered, (d) => d.denyToAllow),
    flippedTotal: sum(ledgered, (d) => d.flippedTotal),
    affectedKeys: sum(ledgered, (d) => d.affectedKeys),
    added,
    removed,
  };

  return {
    current: {
      contentHash: current.contentHash,
      ...(current.label !== undefined ? { label: current.label } : {}),
    },
    candidate: {
      contentHash: candidate.contentHash,
      ...(candidate.label !== undefined ? { label: candidate.label } : {}),
    },
    corpus: { policies: corpusPolicies, steps: corpusSteps, truncated: corpusTruncated },
    diffs,
    summary,
  };
}

function diffPolicy(
  name: string,
  currentSpec: LimiterSpec,
  candidateSpec: LimiterSpec,
  pc: PolicyCorpus | undefined,
  topK: number,
): PolicyDiff {
  if (pc === undefined || pc.arrivals.length === 0) return zeroLedger(name, "empty");

  let baseline: ReplayTrace;
  try {
    baseline = coldRecord(currentSpec, pc.arrivals);
  } catch (e) {
    return { ...zeroLedger(name, "refused"), refusal: refusalOf(e) };
  }

  try {
    // `baseline` was just cold-recorded over the SAME deterministic substrate `replay` rebuilds on
    // (rebuildLimiter + MemoryStore + ManualClock), so the engine's identity self-check — which exists
    // to catch a broken substrate for *externally-supplied* traces — is provably redundant here. Skip it
    // to avoid a third full O(steps) replay pass per policy; the divergence is still computed against the
    // baseline's recorded decisions, so the result is identical.
    const result = replay(baseline, { candidate: candidateSpec, skipIdentityCheck: true });
    const folded = foldDivergence(result.divergence, topK);
    return {
      policy: name,
      state: pc.truncated ? "truncated" : "ok",
      allowToDeny: folded.allowToDeny,
      denyToAllow: folded.denyToAllow,
      flippedTotal: result.divergence.flipped,
      divergent: result.divergence.divergent,
      steps: result.divergence.total,
      affectedKeys: folded.affectedKeys,
      topFlippedKeys: folded.topFlippedKeys,
    };
  } catch (e) {
    return { ...zeroLedger(name, "refused"), refusal: refusalOf(e) };
  }
}

/**
 * Cold-record `spec` over the arrival stream to derive a faithful, manual-clock baseline trace — the same
 * deterministic construction replay uses (fresh `MemoryStore` + `ManualClock`). Arrivals are expected in
 * chronological order (as recorded); `clock.set` to each absolute instant reproduces coincident arrivals.
 */
function coldRecord(spec: LimiterSpec, arrivals: readonly Arrival[]): ReplayTrace {
  const first = arrivals[0]?.at ?? 0;
  const clock = new ManualClock(first);
  // Size the recorder cap to the input so an internal cap can never masquerade as a user-supplied
  // truncation: recordLimiter's drop guard is `steps.length >= maxSteps`, so `maxSteps === arrivals.length`
  // admits all N arrivals. Without this, a corpus larger than the recorder's 1,000,000 default was
  // re-recorded as `truncated`, and replay refused the (complete) baseline as `trace-truncated`. The
  // corpus's OWN truncation flag is honored separately, so a genuinely-prefixed source stays honest.
  const rec = recordLimiter(spec, { clock, maxSteps: arrivals.length });
  for (const a of arrivals) {
    clock.set(a.at);
    rec.limiter.checkSync(a.key, a.cost);
  }
  return rec.trace();
}

interface Folded {
  readonly allowToDeny: number;
  readonly denyToAllow: number;
  readonly affectedKeys: number;
  readonly topFlippedKeys: KeyFlip[];
}

function foldDivergence(div: DivergenceReport, topK: number): Folded {
  let allowToDeny = 0;
  let denyToAllow = 0;
  const perKey = new Map<string, { a2d: number; d2a: number }>();
  for (const step of div.steps) {
    const f = step.diffs.find((d) => d.field === "allowed");
    if (f === undefined) continue; // a non-flip diff (e.g. `remaining` shifted) — not a directional flip
    const e = perKey.get(step.key) ?? { a2d: 0, d2a: 0 };
    if (f.recorded === true && f.replayed === false) {
      allowToDeny++;
      e.a2d++;
    } else if (f.recorded === false && f.replayed === true) {
      denyToAllow++;
      e.d2a++;
    }
    perKey.set(step.key, e);
  }
  const topFlippedKeys = [...perKey.entries()]
    .map(([key, v]) => ({ key, allowToDeny: v.a2d, denyToAllow: v.d2a, total: v.a2d + v.d2a }))
    .sort((a, b) => b.total - a.total)
    .slice(0, topK);
  return { allowToDeny, denyToAllow, affectedKeys: perKey.size, topFlippedKeys };
}

function zeroLedger(name: string, state: PolicyDiffState): PolicyDiff {
  return {
    policy: name,
    state,
    allowToDeny: 0,
    denyToAllow: 0,
    flippedTotal: 0,
    divergent: 0,
    steps: 0,
    affectedKeys: 0,
    topFlippedKeys: [],
  };
}

function refusalOf(e: unknown): PolicyDiffRefusal {
  if (e instanceof ReplayRefusedError) return { reason: e.reason, message: e.message };
  // buildStrategy / rebuild throw a ThrottleKitError for an invalid spec — still an invalid replay input.
  return { reason: "candidate-invalid", message: e instanceof Error ? e.message : String(e) };
}

function sum<T>(items: readonly T[], f: (x: T) => number): number {
  let s = 0;
  for (const x of items) s += f(x);
  return s;
}
