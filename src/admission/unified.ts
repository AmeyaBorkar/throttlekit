import type { ConcurrencyGuard } from "../concurrency/adaptive";
import { systemClock } from "../core/clock";
import { ALLOW_FULL, combineDecisions } from "../core/combine";
import { ThrottleKitError } from "../core/errors";
import type { Clock, Decision, Limiter } from "../core/types";
import { type FluidLpInput, solveFluidLp } from "./fluid-lp";
import { type FusedAdmissionOptions, FusedDispatcher } from "./fused-lua";
import { type LeaseAdmitter, leaseAsAdmission } from "./lease-shim";

/** The three axes a unified admission can compose. Used as the key type for {@link UnifiedAdmitter.lastDecisions}. */
export type UnifiedAxis = "rate" | "concurrency" | "cost";

/** Options for {@link unifiedAdmission}. Every axis is optional; at least one must be set. */
export interface UnifiedAdmissionOptions {
  /** The rate axis — a {@link Limiter} returning a {@link Decision} for `(key, 1)`. Optional. */
  rate?: Limiter;
  /** The concurrency axis — an {@link ConcurrencyGuard} from `adaptiveConcurrency(...)`. Optional. */
  concurrency?: ConcurrencyGuard;
  /** The cost axis — a {@link Limiter} returning a {@link Decision} for `(key, cost)`. Optional. */
  cost?: Limiter;
  /**
   * `"sequential"` (default) runs the three axes in turn; first deny short-circuits.
   * `"lua-fused"` (TK-1005) collapses rate + cost into one Redis EVALSHA — requires
   * the {@link UnifiedAdmissionOptions.fused} option group; throws if `fused` is missing.
   * Concurrency stays in-process in either backend (its state is local).
   */
  backend?: "sequential" | "lua-fused";
  /**
   * Required when `backend: "lua-fused"`. Specifies the Redis client and the per-axis
   * strategy params for the fused atomic script. The `rate` / `cost` Limiters above
   * are NOT used in fused mode (the script runs the transitions directly against the
   * Redis client) — pass them anyway only if you want to fall back to sequential at
   * the call site by re-wrapping; or omit them.
   * Scope (D-U14): 0.9.0 supports gcra + tokenBucket only; other pairs throw.
   */
  fused?: FusedAdmissionOptions;
  /** Injectable time source. Defaults to {@link systemClock}; forwarded to the lease shim. */
  clock?: Clock;
  /**
   * Admission policy. `"marginal"` (DEFAULT) = the 0.9.0 marginal-AND behavior
   * (each axis allows independently). `"joint-lp"` = additionally apply a
   * bid-price filter (admit iff `value ≥ p_R + p_C·cost`) on top of marginal
   * feasibility — opt-in, research-backed (research/bigger-bets/joint-lp-admission).
   * Strictly more selective than `"marginal"`: it only ever *removes* admits, so
   * it cannot break any existing limit/safety property (D-JLP-5).
   */
  policy?: "marginal" | "joint-lp";
  /**
   * Required iff `policy: "joint-lp"`. Supply EXACTLY ONE of:
   *  - `duals`: precomputed bid prices (you solved the LP elsewhere); or
   *  - `workload`: a model the library solves once, at construction, via {@link solveFluidLp}.
   * Requires a `cost` axis (the bid-price test is over the cost budget; D-JLP-11).
   */
  jointLp?: {
    duals?: { rate: number; cost: number; conc?: number };
    workload?: FluidLpInput;
    /**
     * Opt-in **online dual refinement** (D-JLP-8; Devanur–Hayes "sample-then-price").
     * REQUIRES the `workload` form (not bare `duals`): the model is the only input that
     * carries both the construction **prior** AND the per-arrival budget normalization
     * (`workload.rateBudget` / `workload.costBudget`) that the online re-solve and the
     * on-sample self-test both need.
     *
     * During the first `sampleWindow` policy-evaluated requests the filter prices with
     * the prior while tallying the observed `(cost, value)` type mixture. At the window
     * boundary it re-solves the fluid LP from what it actually saw and adopts the learned
     * bid prices **only if they strictly beat the prior on the buffered sample** (replayed
     * under the window-scaled budget `rateBudget·W` / `costBudget·W`), else keeps the
     * prior — then freezes for the lifetime of this admitter.
     *
     * Self-validating (the load-bearing property): it is **never worse than the static
     * prior on the observed sample**, yet **escapes a misspecified prior** — a
     * catastrophically wrong prior that would admit nothing is rescued. Until the window
     * fills, behavior is byte-identical to static joint-LP with `workload`.
     *
     * **Scope of the guarantee.** Non-inferiority holds on the *observed sample* only; it does
     * NOT imply full-horizon dominance. Under non-stationary / autocorrelated arrivals the
     * window can be unrepresentative, so an adopted dual may do *slightly* worse over the full
     * stream (the autocorrelation cousin of the ρ=+1 foil — bounded and small in practice, and
     * still far better than no policy). With a `concurrency` axis configured, "policy-evaluated"
     * counts requests that PASSED concurrency (the bid filter sits after it), so the window
     * reflects the post-concurrency mixture. See
     * `research/bigger-bets/joint-lp-admission/DESIGN.md` §6 + the gate (`adaptive-gate.ts`).
     */
    adaptive?: { sampleWindow: number };
  };
}

/** Per-call options to {@link UnifiedAdmitter.admit} / {@link UnifiedAdmitter.admitSync}. */
export interface UnifiedAdmitOptions {
  /**
   * Key passed to the rate / cost axes. Concurrency is keyless. Defaults to the empty string
   * (interpreted as the "global" rate / cost bucket by the underlying limiters).
   */
  key?: string;
  /**
   * Cost weight passed to the cost axis (matches `Limiter.check(key, cost)`'s second arg).
   * Defaults to 1.
   */
  cost?: number;
  /**
   * The request's value `vᵢ` for the joint-LP bid-price test. Ignored unless
   * `policy: "joint-lp"`. Defaults to 1 (D-JLP-10) — a workload that doesn't set
   * per-request value collapses joint-LP to a cost-threshold filter.
   */
  value?: number;
  /**
   * The request's expected HOLD (service) time for the **3-axis** joint-LP concurrency
   * term (TK-1405): the bid test becomes `value ≥ p_R + p_C·cost + p_K·hold`. Ignored
   * unless `policy: "joint-lp"` with a concurrency budget configured (`jointLp.workload`
   * with `concBudget`, or `jointLp.duals.conc`). Must be in the SAME units as the workload
   * model's `hold`. **Defaults to 0**, and a missing, non-finite (`NaN`/`Infinity`), or negative
   * `hold` all contribute NO concurrency term (fail-open: the concurrency price only ever
   * *rejects* when you give it a positive finite hold — a bad estimate never wrongly rejects, and
   * a hog cannot dodge the price by reporting a negative hold). A 3-axis admitter with `hold`
   * omitted therefore behaves exactly like 2-axis.
   */
  hold?: number;
}

/** The result of one admit call. `release` is the lifecycle hook for the concurrency slot (or a no-op when denied). */
export interface UnifiedAdmission {
  /** The combined Decision across all configured axes (per {@link combineDecisions}). */
  decision: Decision;
  /**
   * Release the held concurrency slot when the work finishes. Pass `dropped: true`
   * to signal an overload (timeout / error) — the adaptive concurrency limit
   * contracts on a drop. On a denied admission this is a no-op (any lease that
   * was transiently acquired has already been released as part of the short-circuit).
   * Idempotent: second and later calls do nothing.
   */
  release(opts?: { dropped?: boolean }): void;
  /**
   * The axis whose denial bound this admission (`"rate"` / `"concurrency"` / `"cost"`), or `undefined`
   * when admitted, or when the joint-LP policy filter bound (see {@link UnifiedAdmission.policyDenied}).
   * The ergonomic form of {@link UnifiedAdmitter.lastDecisions} for the common "why was this denied?"
   * case; equal to the OTel `throttlekit.binding_axis` attribute. Append-only-optional (SemVer).
   */
  readonly bindingAxis?: UnifiedAxis;
  /**
   * True iff this admission was denied specifically by the joint-LP bid-price
   * filter (every per-axis budget had slack, but `value < p_R + p_C·cost`).
   * Absent/falsy under `policy: "marginal"` or any axis-bound denial. Lets the
   * TK-1008 OTel `throttlekit.binding_axis` attribute report `"policy"`.
   */
  policyDenied?: boolean;
}

/**
 * A constructed unified admitter — see {@link unifiedAdmission}. Two entry points
 * (matching the existing {@link Limiter.check} / {@link Limiter.checkSync} pattern):
 *
 * - {@link UnifiedAdmitter.admit} is async; works for any backend mix.
 * - {@link UnifiedAdmitter.admitSync} is sync; throws when any configured axis
 *   lacks a synchronous code path (i.e. a Redis-backed limiter without
 *   `applySync`).
 *
 * Plus per-axis introspection via {@link UnifiedAdmitter.lastDecisions} (used by
 * TK-1008's `throttlekit.binding_axis` OTel attribute).
 */
export interface UnifiedAdmitter {
  admit(opts?: UnifiedAdmitOptions): Promise<UnifiedAdmission>;
  admitSync(opts?: UnifiedAdmitOptions): UnifiedAdmission;
  /**
   * Snapshot of the most recent admit's per-axis decisions. Unconfigured axes are
   * `undefined`; short-circuit decisions also leave downstream axes `undefined`
   * (so the caller can see *which* axis bound). Each call returns a fresh frozen
   * object — safe to leak into telemetry.
   */
  lastDecisions(): Readonly<Partial<Record<UnifiedAxis, Decision | undefined>>>;
}

/** Shared no-op release — used by denied admissions where no slot is held. */
const NOOP_RELEASE = (): void => {};

/**
 * Turn an all-axes-allowed snapshot into a joint-LP policy denial: flip `allowed`
 * to false and zero `remaining`; preserve `limit`/`resetAt` so headers stay
 * coherent. `retryAfterMs` is 0 — a bid-price rejection is value-based, not
 * temporal, so there is nothing to wait for (retrying the identical request
 * yields the same deny). The header renderer floors `Retry-After` at 1s anyway.
 */
function denyByPolicy(d: Decision): Decision {
  return { ...d, allowed: false, remaining: 0, retryAfterMs: 0 };
}

/**
 * Cap on distinct `(cost, value)` archetypes the online warm-up will model
 * (D-JLP-8). The intended workloads have a handful of request classes (e.g. an
 * LLM gateway's small/large completions, or a few model tiers); this bound keeps
 * the one-shot re-solve cheap and bounds the type-model at O(min(window, cap))
 * entries (the replay buffer is separately bounded at O(window)).
 * If a workload presents more distinct pairs, later-seen NEW pairs are not added
 * to the type model (existing pairs keep counting) — and that approximation is
 * SAFE: the learned duals are adopted only if they beat the prior on the *true*
 * buffered sample, so a degraded model simply keeps the validated prior.
 */
const MAX_OBSERVED_TYPES = 64;

/** Warm-up state for the online (sample-then-price) dual refinement (D-JLP-8). */
interface AdaptiveState {
  /** `sampleWindow`: number of policy-evaluated requests to observe before freezing. */
  window: number;
  /** Per-arrival rate budget (`workload.rateBudget ÷ Σ weight`) — the re-solve + replay scale. */
  perArrivalRate: number;
  /** Per-arrival cost budget (`workload.costBudget ÷ Σ weight`). */
  perArrivalCost: number;
  /** The construction-time prior duals; kept to fall back to (never worse than this). */
  prior: { rate: number; cost: number };
  /** The LIVE bid prices: the prior during warm-up, the chosen duals after freeze. */
  active: { rate: number; cost: number };
  /** Count of policy-evaluated requests seen so far (the window progress). */
  seen: number;
  /** True once the window filled and the duals were chosen (frozen for life). */
  frozen: boolean;
  /** The buffered arrival stream (≤ window) — replayed verbatim by the on-sample self-test. */
  buf: Array<{ cost: number; value: number }>;
  /** Observed type counts keyed by `${cost}|${value}` (≤ {@link MAX_OBSERVED_TYPES}). */
  buckets: Map<string, { cost: number; value: number; count: number }>;
}

/**
 * Greedy revenue of a bid-price policy over a buffered sample under a fixed
 * `(rate, cost)` budget — the on-sample self-test that gates dual adoption
 * (D-JLP-8). Identical semantics to the live filter: a request is "admitted" iff
 * the rate slot and cost budget allow AND `value ≥ duals.rate + duals.cost·cost`,
 * consumed in arrival order. Pure; no side effects.
 */
function replaySampleRevenue(
  buf: ReadonlyArray<{ cost: number; value: number }>,
  duals: { rate: number; cost: number },
  rateBudget: number,
  costBudget: number,
): number {
  let rateRem = rateBudget;
  let costRem = costBudget;
  let rev = 0;
  for (const a of buf) {
    if (rateRem >= 1 && costRem >= a.cost && a.value >= duals.rate + duals.cost * a.cost) {
      rateRem -= 1;
      costRem -= a.cost;
      rev += a.value;
    }
  }
  return rev;
}

/**
 * Compose three orthogonal admission axes (rate / concurrency / cost) into one
 * {@link UnifiedAdmission} via the algebra in {@link combineDecisions}. See
 * `research/bigger-bets/unified/DESIGN.md` §4.2 for the locked API and §4.2.2
 * for the sequential evaluation order: **concurrency first** (in-process; cheapest
 * fail), then **rate**, then **cost**; first deny short-circuits and releases any
 * concurrency slot transiently acquired upstream of the binding axis.
 *
 * Commutativity of `combineDecisions` (TK-1002) guarantees this ordering doesn't
 * change the *result* — only the short-circuit cost. The result of every admit
 * call is the field-by-field MIN / MAX / AND of the per-axis decisions, so a
 * client sees the binding axis's `limit` / `remaining` and the dominant
 * `retryAfterMs` / `resetAt` regardless of which axis denied.
 *
 * **Lease lifecycle.** When the concurrency axis admits but a later axis denies,
 * the held slot is released immediately (with `dropped: false` — the deny is
 * upstream, not an overload signal). The caller's returned `release` is then a
 * no-op (the slot is already free). On a triple-success admit, `release` is wired
 * to the underlying lease's `release`; the caller MUST call it once when the
 * work finishes (or always-call from a `finally` block — release is idempotent).
 *
 * **`backend: "lua-fused"`** (TK-1005) collapses rate + cost into one Redis
 * EVALSHA via the {@link UnifiedAdmissionOptions.fused} option group; concurrency
 * stays in-process. Sequential is the universal default.
 */
export function unifiedAdmission(options: UnifiedAdmissionOptions): UnifiedAdmitter {
  const { rate, concurrency, cost, backend = "sequential", fused, clock = systemClock } = options;

  if (
    backend === "sequential" &&
    rate === undefined &&
    concurrency === undefined &&
    cost === undefined
  ) {
    throw new ThrottleKitError(
      "unifiedAdmission: at least one of `rate`, `concurrency`, or `cost` must be configured",
    );
  }
  if (backend !== "sequential" && backend !== "lua-fused") {
    throw new RangeError(
      `unifiedAdmission.backend: expected "sequential" | "lua-fused", got ${String(backend)}`,
    );
  }
  let fusedDispatcher: FusedDispatcher | undefined;
  if (backend === "lua-fused") {
    if (fused === undefined) {
      throw new ThrottleKitError(
        'unifiedAdmission: backend "lua-fused" requires the `fused` option group with { client, rate, cost }',
      );
    }
    // FusedDispatcher's constructor validates the strategy choices + numeric ranges.
    fusedDispatcher = new FusedDispatcher(fused);
  } else if (fused !== undefined) {
    // Caller passed `fused` without selecting the lua-fused backend — almost
    // certainly a config mistake (the dispatcher would never be used). Fail loud.
    throw new ThrottleKitError(
      'unifiedAdmission: `fused` option group requires backend: "lua-fused"',
    );
  }

  // Joint-LP policy wiring (D-JLP-3/11). Resolve the static bid prices ONCE, at
  // construction: either supplied directly (`duals`) or solved from a `workload`
  // model via the zero-dep fluid-LP solver. `duals === undefined` ⇒ the bid-price
  // gate is inert (the `"marginal"` default path is byte-for-byte unchanged).
  const policy = options.policy ?? "marginal";
  let duals: { rate: number; cost: number; conc?: number } | undefined;
  let adaptiveState: AdaptiveState | undefined;
  if (policy === "joint-lp") {
    // The bid-price test is over the cost budget (D-JLP-11). The cost axis is the
    // top-level `cost` Limiter (sequential) OR `fused.cost` (lua-fused) — joint-LP
    // composes over both backends (D-JLP-6).
    if (cost === undefined && fused?.cost === undefined) {
      throw new ThrottleKitError('unifiedAdmission: policy "joint-lp" requires a `cost` axis');
    }
    const jl = options.jointLp;
    const hasDuals = jl?.duals !== undefined;
    const hasWorkload = jl?.workload !== undefined;
    if (hasDuals === hasWorkload) {
      // both supplied, or neither
      throw new ThrottleKitError(
        'unifiedAdmission: policy "joint-lp" requires exactly one of `jointLp.duals` or `jointLp.workload`',
      );
    }
    duals = hasDuals ? jl!.duals! : solveFluidLp(jl!.workload!).duals;
    // Validate the bid prices. The `workload` path produces these from a validated
    // solve; the `duals` escape hatch is caller-supplied, so guard it here — a NaN
    // or negative shadow price would silently deny or admit everything.
    for (const [field, value] of [
      ["rate", duals.rate],
      ["cost", duals.cost],
    ] as const) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new ThrottleKitError(
          `unifiedAdmission: jointLp.duals.${field} must be a finite number ≥ 0 (got ${String(value)})`,
        );
      }
    }
    // 3-axis: validate the optional concurrency shadow price (TK-1405). Same finite-≥0 guard.
    if (
      duals.conc !== undefined &&
      (typeof duals.conc !== "number" || !Number.isFinite(duals.conc) || duals.conc < 0)
    ) {
      throw new ThrottleKitError(
        `unifiedAdmission: jointLp.duals.conc must be a finite number ≥ 0 (got ${String(duals.conc)})`,
      );
    }

    // Online dual refinement (D-JLP-8) — opt-in warm-up state. Requires the `workload`
    // form: it alone carries the per-arrival budgets the re-solve + on-sample self-test
    // need (you cannot recover them from bare `duals`). `duals` above is the PRIOR.
    const adaptiveOpt = jl?.adaptive;
    if (adaptiveOpt !== undefined) {
      if (!hasWorkload) {
        throw new ThrottleKitError(
          "unifiedAdmission: jointLp.adaptive requires the jointLp.workload form (the model supplies the prior AND the per-arrival budgets the online re-solve needs); it is not compatible with bare jointLp.duals",
        );
      }
      const window = adaptiveOpt.sampleWindow;
      if (!Number.isInteger(window) || window < 1) {
        throw new ThrottleKitError(
          `unifiedAdmission: jointLp.adaptive.sampleWindow must be a positive integer (got ${String(window)})`,
        );
      }
      // Per-arrival budget normalization. `solveFluidLp` treats `weight` as a per-type usage
      // scale (counts OR probabilities) and is scale-invariant for the duals, so the static
      // path accepts any normalization. The on-sample replay, however, scales the budget by the
      // number of buffered arrivals — so it needs the per-ARRIVAL budget = `budget ÷ Σ weight`.
      // Deriving it here makes `adaptive` accept the SAME `workload` shape as the static path
      // (counts+totals or probabilities+per-arrival both scale the replay correctly).
      const totalWeight = jl!.workload!.types.reduce((s, t) => s + t.weight, 0);
      const norm = (budget: number): number => (totalWeight > 0 ? budget / totalWeight : budget);
      adaptiveState = {
        window,
        perArrivalRate: norm(jl!.workload!.rateBudget),
        perArrivalCost: norm(jl!.workload!.costBudget),
        prior: duals,
        active: duals,
        seen: 0,
        frozen: false,
        buf: [],
        buckets: new Map(),
      };
    }

    // 3-axis × adaptive are not yet combinable: the warm-up's on-sample self-test models
    // rate+cost only (no occupancy), so it cannot validate a learned concurrency dual. Fail loud.
    if (adaptiveState !== undefined && duals.conc !== undefined) {
      throw new ThrottleKitError(
        "unifiedAdmission: jointLp.adaptive and the 3-axis concurrency budget cannot be combined yet (the online warm-up's self-test models rate+cost only). Use one or the other.",
      );
    }
  } else if (options.policy !== "marginal" && options.policy !== undefined) {
    throw new RangeError(
      `unifiedAdmission.policy: expected "marginal" | "joint-lp", got ${String(options.policy)}`,
    );
  } else if (options.jointLp !== undefined) {
    throw new ThrottleKitError('unifiedAdmission: `jointLp` requires policy: "joint-lp"');
  }

  // Pre-build the concurrency-axis shim once. cheaper than re-wrapping per admit.
  const concShim: LeaseAdmitter | undefined =
    concurrency !== undefined ? leaseAsAdmission(concurrency, { clock }) : undefined;

  /** Mutable state for {@link UnifiedAdmitter.lastDecisions}. Each admit overwrites it. */
  let lastRate: Decision | undefined;
  let lastConc: Decision | undefined;
  let lastCost: Decision | undefined;

  /**
   * Reset per-axis state at the start of each admit so a short-circuit denial
   * leaves the *downstream* axes' last decision as `undefined` (so the caller
   * can identify the binding axis from `lastDecisions()`).
   */
  function resetLast(): void {
    lastRate = undefined;
    lastConc = undefined;
    lastCost = undefined;
  }

  /**
   * The synchronous "step machine" shared between admit and admitSync. Returns
   * the partial state at each step so the caller can decide async vs sync.
   *
   * Step 1 (concurrency, in-process) — runs synchronously.
   */
  function startWithConcurrency(): {
    decision: Decision | undefined; // present iff concurrency was checked and denied
    leaseRelease: ((opts?: { dropped?: boolean }) => void) | undefined;
  } {
    if (concShim === undefined) {
      return { decision: undefined, leaseRelease: undefined };
    }
    const admission = concShim.acquire();
    lastConc = admission.decision;
    if (!admission.decision.allowed) {
      // Denied at concurrency — short-circuit; no slot held.
      return { decision: admission.decision, leaseRelease: undefined };
    }
    return { decision: undefined, leaseRelease: admission.release };
  }

  /**
   * Finalize a triple-success admit: the combined Decision plus the lease
   * release (or a no-op if concurrency wasn't configured / acquired).
   */
  function finalize(
    leaseRelease: ((opts?: { dropped?: boolean }) => void) | undefined,
  ): UnifiedAdmission {
    const combined = combineDecisions(
      combineDecisions(lastConc ?? ALLOW_FULL, lastRate ?? ALLOW_FULL),
      lastCost ?? ALLOW_FULL,
    );
    return { decision: combined, release: leaseRelease ?? NOOP_RELEASE };
  }

  /**
   * Combine the per-axis last-decisions snapshot into one Decision via the
   * algebra. Unconfigured / short-circuited axes contribute ALLOW_FULL
   * (identity), so the result equals the first denying axis's Decision plus
   * any earlier-allow Decision's `limit` / `remaining` clamps.
   */
  function combineSnapshot(): Decision {
    return combineDecisions(
      combineDecisions(lastConc ?? ALLOW_FULL, lastRate ?? ALLOW_FULL),
      lastCost ?? ALLOW_FULL,
    );
  }

  /**
   * The axis that bound the most recent admit — concurrency → rate → cost, first denial wins (the
   * evaluation order; mirrors `bindingAxisOf` in the OTel layer). `undefined` when admitted or when the
   * joint-LP policy filter bound (no axis denied). Read synchronously at each deny return so it agrees
   * with the `combineSnapshot()` decision built from the same per-axis state.
   */
  const deriveBindingAxis = (): UnifiedAxis | undefined =>
    lastConc?.allowed === false
      ? "concurrency"
      : lastRate?.allowed === false
        ? "rate"
        : lastCost?.allowed === false
          ? "cost"
          : undefined;

  /** Build a denied admission, attaching the binding axis (omitted when undefined — e.g. a policy deny). */
  const denyResult = (decision: Decision): UnifiedAdmission => {
    const axis = deriveBindingAxis();
    return axis === undefined
      ? { decision, release: NOOP_RELEASE }
      : { decision, release: NOOP_RELEASE, bindingAxis: axis };
  };

  /**
   * One online warm-up step (D-JLP-8). Tally an observed `(cost, value)` arrival
   * and, once the sample window fills, re-solve the fluid LP from observations and
   * adopt the learned duals into `st.active` iff they STRICTLY beat the prior on the
   * buffered sample (replayed under the window-scaled budget) — else keep the prior.
   * Mutates `st` only (never the outer `duals`); called only while `!st.frozen`.
   */
  function refineWarmup(st: AdaptiveState, value: number, requestCost: number): void {
    st.seen += 1;
    if (st.buf.length < st.window) st.buf.push({ cost: requestCost, value });
    const bucketKey = `${requestCost}|${value}`;
    const bucket = st.buckets.get(bucketKey);
    if (bucket !== undefined) bucket.count += 1;
    else if (st.buckets.size < MAX_OBSERVED_TYPES)
      st.buckets.set(bucketKey, { cost: requestCost, value, count: 1 });

    if (st.seen < st.window) return;

    // Window full — re-solve from the observed mixture and run the self-test gate.
    let chosen = st.prior;
    try {
      const types = [...st.buckets.values()].map((b) => ({
        cost: b.cost,
        value: b.value,
        weight: b.count / st.seen,
      }));
      const learned = solveFluidLp({
        types,
        rateBudget: st.perArrivalRate,
        costBudget: st.perArrivalCost,
      }).duals;
      const scaledR = st.perArrivalRate * st.buf.length;
      const scaledC = st.perArrivalCost * st.buf.length;
      // Adopt ONLY IF strictly better on the observed sample (a tie keeps the prior).
      if (
        replaySampleRevenue(st.buf, learned, scaledR, scaledC) >
        replaySampleRevenue(st.buf, st.prior, scaledR, scaledC)
      ) {
        chosen = learned;
      }
    } catch {
      // A degenerate observed sample (e.g. a non-finite / negative user-supplied cost
      // or value reaching the re-solve) could throw. Keep the validated prior — the
      // never-worse-than-static guarantee must hold for ANY input.
      chosen = st.prior;
    }
    st.active = chosen;
    st.frozen = true;
    st.buf = []; // free the sample buffer + type counts; no longer needed
    st.buckets.clear();
  }

  /**
   * The joint-LP bid-price filter (D-JLP-6). Inert unless `policy: "joint-lp"` is
   * configured (`duals` defined). Pure JS (only `value`, `requestCost`, and the
   * `duals`), so it is backend-agnostic AND must run **BEFORE the rate/cost
   * limiters debit** — the rate/cost `check()` consumes budget on success with no
   * rollback, so filtering *after* them would let a rejected low-value request
   * still drain the budget the policy exists to preserve. Returns a policy-denial
   * {@link UnifiedAdmission} (releasing any held concurrency slot — an
   * upstream-style deny, not an overload drop) when value doesn't clear
   * `p_R + p_C·cost`, or `undefined` to let the admit proceed to rate/cost.
   *
   * When online refinement (D-JLP-8) is enabled, this also drives the warm-up: each
   * call observes the arrival and, at the window boundary, may swap the live bid
   * prices from the prior to the learned duals — so the bid test below uses the
   * latest `active` prices (the W-th request itself is priced post-freeze).
   *
   * On a policy deny the per-axis decisions are left unset (the axes were never
   * consulted — that is exactly what preserves their budget); `policyDenied: true`
   * is the signal that the filter, not an axis, bound (D-JLP-4).
   */
  function applyPolicyGate(
    value: number,
    requestCost: number,
    hold: number,
    leaseRelease: ((opts?: { dropped?: boolean }) => void) | undefined,
  ): UnifiedAdmission | undefined {
    if (duals === undefined) return undefined;
    let active = duals;
    if (adaptiveState !== undefined) {
      if (!adaptiveState.frozen) refineWarmup(adaptiveState, value, requestCost);
      active = adaptiveState.active;
    }
    // 3-axis (TK-1405): the optional concurrency price adds `p_K·hold`. Applied ONLY when a conc
    // dual is configured AND the per-request `hold` is a positive finite number — so a 2-axis bid
    // is provably untouched (no `0 * NaN` poisoning) and a non-finite / negative `hold` is treated
    // as 0 (fail-open): a bad hold estimate never wrongly rejects, and a hog cannot dodge the price
    // by reporting a negative hold (which would otherwise *lower* the bid).
    let bid = active.rate + active.cost * requestCost;
    if (active.conc !== undefined && Number.isFinite(hold) && hold > 0) {
      bid += active.conc * hold;
    }
    if (value >= bid) return undefined;
    leaseRelease?.({ dropped: false });
    return { decision: denyByPolicy(combineSnapshot()), release: NOOP_RELEASE, policyDenied: true };
  }

  return {
    async admit(opts?: UnifiedAdmitOptions): Promise<UnifiedAdmission> {
      const { key = "", cost: requestCost = 1, value = 1, hold = 0 } = opts ?? {};
      resetLast();

      // Step 1 — concurrency (synchronous, both backends).
      const concStep = startWithConcurrency();
      if (concStep.decision !== undefined) {
        return denyResult(concStep.decision);
      }
      const leaseRelease = concStep.leaseRelease;

      // Step 2 — joint-LP bid-price filter, BEFORE any rate/cost debit (inert under
      // the default policy). A filtered request must not consume budget.
      const policyDeny = applyPolicyGate(value, requestCost, hold, leaseRelease);
      if (policyDeny !== undefined) return policyDeny;

      // Step 3 — rate + cost. The outer try/catch releases the held concurrency
      // slot if a limiter throws (e.g. a store outage), so the slot never leaks.
      try {
        if (fusedDispatcher !== undefined) {
          // Lua-fused path: one Redis EVALSHA covers both axes atomically.
          const result = await fusedDispatcher.dispatch(key, requestCost);
          lastRate = result.rate;
          lastCost = result.cost;
          if (!result.combined.allowed) {
            leaseRelease?.({ dropped: false });
            // Combined Decision still folds in concurrency (which allowed; ALLOW_FULL-ish).
            return denyResult(combineSnapshot());
          }
          return finalize(leaseRelease);
        }

        // Sequential path — rate (async).
        if (rate !== undefined) {
          const d = await rate.check(key, 1);
          lastRate = d;
          if (!d.allowed) {
            // Release the held concurrency slot (deny is upstream, not an overload).
            leaseRelease?.({ dropped: false });
            return denyResult(combineSnapshot());
          }
        }

        // Sequential path — cost (async).
        if (cost !== undefined) {
          const d = await cost.check(key, requestCost);
          lastCost = d;
          if (!d.allowed) {
            leaseRelease?.({ dropped: false });
            return denyResult(combineSnapshot());
          }
        }

        return finalize(leaseRelease);
      } catch (err) {
        // A rate/cost limiter threw (store outage, async-only store, …) after the
        // slot was acquired — release it before propagating (idempotent).
        leaseRelease?.({ dropped: false });
        throw err;
      }
    },

    admitSync(opts?: UnifiedAdmitOptions): UnifiedAdmission {
      const { key = "", cost: requestCost = 1, value = 1, hold = 0 } = opts ?? {};
      resetLast();

      // The lua-fused path is inherently async (Redis EVALSHA round-trip), so
      // admitSync isn't a valid mode there — fail loud rather than silently
      // dropping to a thenable. Callers needing sync must use sequential.
      if (fusedDispatcher !== undefined) {
        throw new ThrottleKitError(
          'unifiedAdmission.admitSync: not supported with backend "lua-fused" (Redis EVALSHA is async). Use admit() or switch to backend "sequential".',
        );
      }

      // Step 1 — concurrency.
      const concStep = startWithConcurrency();
      if (concStep.decision !== undefined) {
        return denyResult(concStep.decision);
      }
      const leaseRelease = concStep.leaseRelease;

      // Step 2 — joint-LP bid-price filter, BEFORE any rate/cost debit (inert under
      // the default policy). A filtered request must not consume budget.
      const policyDeny = applyPolicyGate(value, requestCost, hold, leaseRelease);
      if (policyDeny !== undefined) return policyDeny;

      // Step 3 — rate + cost. The try/catch releases the held slot if a limiter
      // throws (e.g. an async-only store under admitSync), so the slot never leaks.
      try {
        // Rate. Will throw if the underlying store is async-only.
        if (rate !== undefined) {
          const d = rate.checkSync(key, 1);
          lastRate = d;
          if (!d.allowed) {
            leaseRelease?.({ dropped: false });
            return denyResult(combineSnapshot());
          }
        }

        // Cost.
        if (cost !== undefined) {
          const d = cost.checkSync(key, requestCost);
          lastCost = d;
          if (!d.allowed) {
            leaseRelease?.({ dropped: false });
            return denyResult(combineSnapshot());
          }
        }

        return finalize(leaseRelease);
      } catch (err) {
        leaseRelease?.({ dropped: false });
        throw err;
      }
    },

    lastDecisions(): Readonly<Partial<Record<UnifiedAxis, Decision | undefined>>> {
      return Object.freeze({
        rate: lastRate,
        concurrency: lastConc,
        cost: lastCost,
      });
    },
  };
}
