/**
 * Admission Policy Plans (#306–#313) — a `terraform plan` for rate / cost limits. Replay your own
 * *recorded* traffic against a *candidate* policy set and read the exact, per-policy, per-key
 * **allow↔deny decision diff** before you deploy.
 *
 * Built on `throttlekit/config` (`buildStrategy`, `LimiterSpec`) + `throttlekit/testkit` (the deterministic
 * recorder/replayer). The baseline is always the *current* policy cold-replayed over your arrival timing —
 * **not** a comparison against a warm production node's exact decisions (a cold replay can't reproduce
 * those; see `research/policy/DESIGN.md` §4). Scope: leaf rate + cost limiters; concurrency / escrow /
 * joint-LP axes are surfaced as `not-replayable` (observe live via binding-axis attribution), never faked.
 *
 * @experimental Opt-in; excluded from the `1.x` SemVer guarantee (see STABILITY.md). Shapes may change in
 * a minor.
 *
 * @example
 * import { recordLimiter } from "throttlekit/testkit";
 * import { policy, policySet, corpusFromRecordings, plan, renderPlan } from "throttlekit/policy";
 *
 * // record real traffic against today's limiter, then ask what limit=5 would have done
 * const rec = recordLimiter({ strategy: "fixedWindow", limit: 3, windowMs: 1000 });
 * for (let i = 0; i < 6; i++) rec.limiter.checkSync("tenant-a");
 *
 * const current   = policySet([policy("api", { strategy: "fixedWindow", limit: 3, windowMs: 1000 })]);
 * const candidate = policySet([policy("api", { strategy: "fixedWindow", limit: 5, windowMs: 1000 })]);
 * const corpus    = corpusFromRecordings({ api: rec });
 *
 * console.log(renderPlan(plan(current, candidate, corpus))); // "api: 0 allow→deny, 2 deny→allow over 6…"
 */

export {
  type Policy,
  type PolicySet,
  type PolicySetOptions,
  type PolicySetFromConfigOptions,
  type UnreplayablePolicy,
  POLICY_SET_FORMAT_VERSION,
  parsePolicySet,
  policy,
  policySet,
  policySetFromConfig,
  serializePolicySet,
} from "./artifact";
export {
  type Arrival,
  type PolicyCorpus,
  type TraceCorpus,
  arrivalsFromTrace,
  corpusFromRecordings,
  corpusFromTraces,
  emptyCorpus,
  policyCorpus,
} from "./corpus";
export {
  type KeyFlip,
  type Plan,
  type PlanOptions,
  type PlanSummary,
  type PolicyDiff,
  type PolicyDiffRefusal,
  type PolicyDiffState,
  DEFAULT_TOP_FLIPPED_KEYS,
  plan,
} from "./plan";
export { type PlanBudget, PlanRejectedError, assertPlanAcceptable } from "./gate";
export { type RenderPlanOptions, planToJSON, renderPlan } from "./render";
