/**
 * `runPolicyPlan` — the server's "terraform plan for limits", as a pure function over text + a prebuilt
 * corpus (the argv→stdout wiring lives in the bin). It classifies the **current** and **candidate** server
 * configs into policy sets ({@link policySetFromServerConfig}), diffs the candidate against the current over
 * the recorded {@link TraceCorpus} (the core `plan` — one oracle, cold-replay baseline), renders the result,
 * and optionally gates it against a blast-radius {@link PlanBudget}.
 *
 * **Fail-closed:** a config that won't parse/classify returns `ok:false` with the error and no plan; a plan
 * that breaches its budget returns `ok:false` with the gate violations (and still the rendered plan, so the
 * operator sees *why* it was rejected). Only a clean, within-budget plan returns `ok:true`.
 */

import {
  type Plan,
  type PlanBudget,
  PlanRejectedError,
  type TraceCorpus,
  assertPlanAcceptable,
  plan,
  planToJSON,
  renderPlan,
} from "throttlekit/policy";
import { policySetFromServerConfig } from "./policy-set.js";

/** A request to {@link runPolicyPlan}: the two configs, the corpus, and the render / gate knobs. */
export interface PolicyPlanRequest {
  /** The current (running) server config text. */
  readonly currentConfig: string;
  /** The candidate (proposed) server config text. */
  readonly candidateConfig: string;
  /** Recorded arrivals to diff over (from {@link corpusFromTraceFile} or {@link corpusFromCapture}). */
  readonly corpus: TraceCorpus;
  /** Optional CI gate — `ok:false` (non-zero exit) if the predicted blast radius exceeds these bounds. */
  readonly budget?: PlanBudget;
  /** Render the machine-readable JSON artifact instead of the human summary. */
  readonly json?: boolean;
  /** Top flipped keys to report per policy. */
  readonly topKeys?: number;
}

/** The outcome of {@link runPolicyPlan}. */
export interface PolicyPlanResult {
  /** True iff the plan built cleanly AND (if a budget was given) stayed within it. */
  readonly ok: boolean;
  /** The plan artifact (present whenever the configs classified — absent only on a parse/classify error). */
  readonly plan?: Plan;
  /** The rendered plan — `renderPlan` text, or `planToJSON` when `json` was set. */
  readonly rendered?: string;
  /** Budget violations, when a gate rejected the plan (`ok:false`). */
  readonly rejected?: readonly string[];
  /** A fail-closed build/parse error (`ok:false`, no plan). */
  readonly error?: string;
}

/** Build, render, and (optionally) gate a policy plan from server config text + a corpus. Never throws. */
export function runPolicyPlan(req: PolicyPlanRequest): PolicyPlanResult {
  let current: ReturnType<typeof policySetFromServerConfig>;
  let candidate: ReturnType<typeof policySetFromServerConfig>;
  try {
    current = policySetFromServerConfig(req.currentConfig, { label: "current" });
    candidate = policySetFromServerConfig(req.candidateConfig, { label: "candidate" });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const p = plan(
    current,
    candidate,
    req.corpus,
    req.topKeys !== undefined ? { topFlippedKeys: req.topKeys } : {},
  );
  const rendered = req.json
    ? planToJSON(p)
    : renderPlan(p, req.topKeys !== undefined ? { topKeys: req.topKeys } : {});

  if (req.budget !== undefined) {
    try {
      assertPlanAcceptable(p, req.budget);
    } catch (e) {
      if (e instanceof PlanRejectedError)
        return { ok: false, plan: p, rendered, rejected: e.violations };
      throw e; // a non-gate error is a real bug — surface it
    }
  }
  return { ok: true, plan: p, rendered };
}
