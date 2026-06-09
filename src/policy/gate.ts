import { ThrottleKitError } from "../core/errors";
import type { Plan } from "./plan";

/**
 * A blast-radius budget for {@link assertPlanAcceptable} — the "plan in CI" gate. A policy change is
 * allowed to merge only if its predicted effect stays within these bounds. Every field is optional;
 * an absent bound is not checked.
 */
export interface PlanBudget {
  /** Max requests that may newly flip allow→deny (the tightening blast radius). */
  readonly maxAllowToDeny?: number;
  /** Max requests that may newly flip deny→allow (the loosening). */
  readonly maxDenyToAllow?: number;
  /** Max total flips (allow→deny + deny→allow). */
  readonly maxFlippedTotal?: number;
  /** Max distinct keys/tenants affected by any flip. */
  readonly maxAffectedKeys?: number;
  /** Fail if any policy could not be replayed (state `refused` or `not-replayable`). */
  readonly requireAllReplayable?: boolean;
}

/** A {@link Plan} exceeded its {@link PlanBudget}. Carries the machine-readable list of violations. */
export class PlanRejectedError extends ThrottleKitError {
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(`plan rejected: ${violations.join("; ")}`, { code: "config_invalid" });
    this.name = "PlanRejectedError";
    this.violations = violations;
  }
}

/**
 * Fail-loud if a {@link Plan} breaches its {@link PlanBudget} — the adaptive promote-or-hold lever. Throws
 * {@link PlanRejectedError} (with every violation) so a CI step exits non-zero on a too-large change;
 * returns silently when the plan is within budget.
 *
 * @experimental Part of the opt-in Policy Plans surface; see STABILITY.md.
 */
export function assertPlanAcceptable(plan: Plan, budget: PlanBudget): void {
  const v: string[] = [];
  const s = plan.summary;
  if (budget.maxAllowToDeny !== undefined && s.allowToDeny > budget.maxAllowToDeny)
    v.push(`allow→deny ${s.allowToDeny} exceeds max ${budget.maxAllowToDeny}`);
  if (budget.maxDenyToAllow !== undefined && s.denyToAllow > budget.maxDenyToAllow)
    v.push(`deny→allow ${s.denyToAllow} exceeds max ${budget.maxDenyToAllow}`);
  if (budget.maxFlippedTotal !== undefined && s.flippedTotal > budget.maxFlippedTotal)
    v.push(`total flips ${s.flippedTotal} exceeds max ${budget.maxFlippedTotal}`);
  if (budget.maxAffectedKeys !== undefined && s.affectedKeys > budget.maxAffectedKeys)
    v.push(`affected keys ${s.affectedKeys} exceeds max ${budget.maxAffectedKeys}`);
  if (budget.requireAllReplayable) {
    const bad = plan.diffs.filter((d) => d.state === "refused" || d.state === "not-replayable");
    if (bad.length > 0)
      v.push(
        `${bad.length} policy(ies) not replayable: ${bad
          .map((d) => `${d.policy} (${d.refusal?.reason ?? d.state})`)
          .join(", ")}`,
      );
  }
  if (v.length > 0) throw new PlanRejectedError(v);
}
