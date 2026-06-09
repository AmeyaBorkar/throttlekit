import type { Plan, PolicyDiff } from "./plan";

/** Serialize a {@link Plan} to pretty JSON — the machine-readable artifact (PR comment, CI evidence). */
export function planToJSON(plan: Plan): string {
  return JSON.stringify(plan, null, 2);
}

export interface RenderPlanOptions {
  /** Top flipped keys to show per policy line (default 3). */
  readonly topKeys?: number;
}

/**
 * Render a {@link Plan} as a human-readable summary — the default CLI / TUI output. Pure (no I/O, no
 * color); a caller can print it, log it, or diff it. Carries the honest non-claims (truncation, the
 * non-replayable axes) inline so the reader is never misled.
 *
 * @experimental Part of the opt-in Policy Plans surface; see STABILITY.md.
 */
export function renderPlan(plan: Plan, options: RenderPlanOptions = {}): string {
  const topKeys = options.topKeys ?? 3;
  const short = (h: string): string => h.slice(0, 12);
  const curLabel = plan.current.label ? `${plan.current.label} ` : "";
  const candLabel = plan.candidate.label ? `${plan.candidate.label} ` : "";

  const lines: string[] = [];
  lines.push(
    `Policy Plan: ${curLabel}${short(plan.current.contentHash)} → ${candLabel}${short(plan.candidate.contentHash)}`,
  );
  const truncNote = plan.corpus.truncated ? " — TRUNCATED (diff covers a prefix)" : "";
  lines.push(
    `Corpus: ${plan.corpus.steps} arrival(s) across ${plan.corpus.policies} policy(ies)${truncNote}`,
  );
  lines.push("");
  for (const d of plan.diffs) lines.push(renderDiffLine(d, topKeys));
  if (plan.summary.added.length > 0) lines.push(`  + added: ${plan.summary.added.join(", ")}`);
  if (plan.summary.removed.length > 0)
    lines.push(`  - removed: ${plan.summary.removed.join(", ")}`);
  lines.push("");

  const s = plan.summary;
  lines.push(
    `Summary: ${s.allowToDeny} newly DENIED, ${s.denyToAllow} newly ALLOWED across ${s.affectedKeys} key(s); ${s.replayable}/${s.policies} policies replayable.`,
  );
  return lines.join("\n");
}

function renderDiffLine(d: PolicyDiff, topKeys: number): string {
  if (d.state === "ok" || d.state === "truncated") {
    const trunc = d.state === "truncated" ? " [prefix]" : "";
    const top =
      d.topFlippedKeys.length > 0
        ? `  top: ${d.topFlippedKeys
            .slice(0, topKeys)
            .map((k) => `${k.key}(${k.total})`)
            .join(", ")}`
        : "";
    return `  ${d.policy}: ${d.allowToDeny} allow→deny, ${d.denyToAllow} deny→allow over ${d.steps} arrival(s)${trunc}${top}`;
  }
  if (d.state === "empty") return `  ${d.policy}: no recorded traffic (nothing to diff)`;
  if (d.state === "not-replayable")
    return `  ${d.policy}: not replayable — ${d.refusal?.message ?? ""} (observe live via attribution)`;
  // refused
  return `  ${d.policy}: REFUSED — ${d.refusal?.reason ?? "?"}: ${d.refusal?.message ?? ""}`;
}
