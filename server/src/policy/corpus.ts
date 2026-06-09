/**
 * Server corpus adapters for Policy Plans (#309's server remainder). A {@link plan} diffs a candidate
 * policy set against the current one over a {@link TraceCorpus} — the **arrivals** `(key, cost, at)` a
 * policy actually saw. These build that corpus from the two sources a running server already has:
 *
 * 1. {@link corpusFromTraceFile} — a JSON file of recorded traces, keyed by policy name (the testkit's
 *    native interchange: the output of `capture export`, of library `recordLimiter`, or of a load test).
 * 2. {@link corpusFromCapture} — the server's own **durable capture store** (#289), read through the
 *    existing **fail-closed + audited** capture CLI: every leaf-rate segment is decrypted (under the same
 *    operator credential) and projected to a trace, grouped by policy. This is the "plan my candidate
 *    against my recorded production traffic" path.
 *
 * Honest boundary: a live capture is `clock:"system"` and therefore *replay-refused* downstream — but a
 * corpus only needs the **arrival timing** (clock-agnostic), which the plan cold-re-decides against both
 * the current and candidate specs. So a system-clock capture is a valid corpus *source* even though it is
 * not a valid replay *target* (see [[dashboard-future-designs]] / DESIGN §4). Only leaf-rate segments
 * project; meters / admitters / escrow segments are forensic-only and are reported as skipped, never faked.
 */

import { type TraceCorpus, corpusFromTraces } from "throttlekit/policy";
import type { ReplayTrace } from "throttlekit/testkit";
import type { CaptureCliDeps, CaptureExport, CaptureListRow } from "../capture/cli.js";
import { runCaptureCli } from "../capture/cli.js";
import type { Shadow } from "../replay/shadow.js";

/**
 * Parse a corpus JSON file — a map of policy name → one trace or an array of traces (the `corpusFromTraces`
 * input shape) — into a {@link TraceCorpus}. Fail-closed: a non-object file, or a value that is not a trace
 * (no `steps` array), throws with a clear message rather than silently planning over empty arrivals.
 */
export function corpusFromTraceFile(text: string): TraceCorpus {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`policy plan: corpus file is not valid JSON: ${(e as Error).message}`);
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(
      "policy plan: corpus file must be a JSON object { policyName: trace | trace[] }",
    );
  const out: Record<string, ReplayTrace[]> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const traces = Array.isArray(value) ? value : [value];
    for (const t of traces) {
      if (t == null || typeof t !== "object" || !Array.isArray((t as { steps?: unknown }).steps))
        throw new Error(
          `policy plan: corpus[${JSON.stringify(name)}] is not a trace (expected an object with a \`steps\` array)`,
        );
    }
    // corpusFromTraces reads only `steps[].{key,cost,at}` + `truncated`; the capture/testkit trace JSON is
    // structurally a ReplayTrace for those fields, so the cast is sound at the arrivals boundary.
    out[name] = traces as unknown as ReplayTrace[];
  }
  return corpusFromTraces(out);
}

/** A leaf-rate segment that contributed arrivals to a capture-sourced corpus. */
export interface CorpusSource {
  readonly policy: string;
  readonly segments: number;
}

/** A segment skipped while building a capture-sourced corpus (forensic-only or unreadable), with why. */
export interface CorpusSkip {
  readonly id: string;
  readonly policy?: string;
  readonly reason: "not-leaf-rate" | "unreadable" | "export-failed";
}

/** The outcome of {@link corpusFromCapture}. `ok:false` carries a fail-closed reason (e.g. unauthorized). */
export interface CaptureCorpusResult {
  readonly ok: boolean;
  readonly corpus?: TraceCorpus;
  readonly sources?: readonly CorpusSource[];
  readonly skipped?: readonly CorpusSkip[];
  readonly error?: string;
}

/** A request to {@link corpusFromCapture} — the operator credential + principal for the audited reads. */
export interface CaptureCorpusRequest {
  readonly credential?: string;
  readonly principal?: string;
}

/**
 * Build a corpus from the durable capture store, **reusing the existing fail-closed + audited capture CLI**:
 * one authorized `list` enumerates segments, then each leaf-rate one is `export`ed (decrypted + projected +
 * audited) and its trace grouped by policy. An unauthorized credential yields `ok:false` with no corpus and
 * no reads (the capture CLI is fail-closed). Non-leaf-rate / unreadable / export-failed segments are skipped
 * and reported — never silently dropped, never faked into the corpus.
 */
export async function corpusFromCapture(
  deps: CaptureCliDeps,
  req: CaptureCorpusRequest = {},
): Promise<CaptureCorpusResult> {
  const auth = {
    ...(req.credential !== undefined ? { credential: req.credential } : {}),
    ...(req.principal !== undefined ? { principal: req.principal } : {}),
  };
  const listed = await runCaptureCli({ action: "list", ...auth }, deps);
  if (!listed.ok) return { ok: false, error: listed.error };
  const rows = listed.output as CaptureListRow[];

  const traces: Record<string, ReplayTrace[]> = {};
  const counts = new Map<string, number>();
  const skipped: CorpusSkip[] = [];
  for (const row of rows) {
    if (row.unreadable === true) {
      skipped.push({ id: row.id, reason: "unreadable" });
      continue;
    }
    if (row.replayable !== true) {
      skipped.push({
        id: row.id,
        ...(row.policy !== undefined ? { policy: row.policy } : {}),
        reason: "not-leaf-rate",
      });
      continue;
    }
    const exported = await runCaptureCli({ action: "export", id: row.id, ...auth }, deps);
    const out = exported.output as CaptureExport | undefined;
    if (!exported.ok || out === undefined || out.kind !== "replay-trace") {
      skipped.push({
        id: row.id,
        ...(row.policy !== undefined ? { policy: row.policy } : {}),
        reason: "export-failed",
      });
      continue;
    }
    const policyName = row.policy ?? "unknown";
    const bucket = traces[policyName] ?? [];
    bucket.push(out.trace as unknown as ReplayTrace);
    traces[policyName] = bucket;
    counts.set(policyName, (counts.get(policyName) ?? 0) + 1);
  }
  const sources: CorpusSource[] = [...counts.entries()].map(([policy, segments]) => ({
    policy,
    segments,
  }));
  return { ok: true, corpus: corpusFromTraces(traces), sources, skipped };
}

/** The outcome of {@link corpusFromShadow}: the corpus plus the policies that contributed nothing, and why. */
export interface ShadowCorpusResult {
  readonly corpus: TraceCorpus;
  /** Shadowed policies with no recorded steps yet (drive traffic first) — reported, never faked into arrivals. */
  readonly empty: readonly string[];
  /** Shadowed policies whose shadow was poisoned (a redaction collision) — excluded; its trace is unreliable. */
  readonly poisoned: readonly string[];
}

/**
 * Build a corpus from the LIVE deterministic-capture shadows (#290) — one trace per shadowed leaf-rate
 * policy — for the TUI Plan tab's whole-config plan over real recorded traffic. Each {@link Shadow}'s
 * `trace()` is already a manual-clock, full-spec `ReplayTrace`, so it feeds {@link corpusFromTraces}
 * directly (same type — no cast). A poisoned shadow is excluded (its trace can't be trusted); an empty
 * shadow contributes nothing and is reported, so the plan never invents arrivals.
 */
export function corpusFromShadow(shadows: ReadonlyMap<string, Shadow>): ShadowCorpusResult {
  const traces: Record<string, ReplayTrace[]> = {};
  const empty: string[] = [];
  const poisoned: string[] = [];
  for (const [policy, shadow] of shadows) {
    if (shadow.poisoned) {
      poisoned.push(policy);
      continue;
    }
    const t = shadow.trace();
    if (t.steps.length === 0) {
      empty.push(policy);
      continue;
    }
    traces[policy] = [t];
  }
  return { corpus: corpusFromTraces(traces), empty, poisoned };
}
