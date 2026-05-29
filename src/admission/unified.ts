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
    duals?: { rate: number; cost: number };
    workload?: FluidLpInput;
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
   * True iff this admission was denied specifically by the joint-LP bid-price
   * filter (every per-axis budget had slack, but `value < p_R + p_C·cost`).
   * Absent/falsy under `policy: "marginal"` or any axis-bound denial. Lets the
   * TK-1008 OTel `tk.binding_axis` attribute report `"policy"`.
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
 * TK-1008's `tk.binding_axis` OTel attribute).
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
  lastDecisions(): Readonly<Record<UnifiedAxis, Decision | undefined>>;
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
  let duals: { rate: number; cost: number } | undefined;
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
   * The joint-LP bid-price filter (D-JLP-6). Inert unless `policy: "joint-lp"` is
   * configured (`duals` defined). Pure JS (only `value`, `requestCost`, and the
   * static `duals`), so it is backend-agnostic AND must run **BEFORE the rate/cost
   * limiters debit** — the rate/cost `check()` consumes budget on success with no
   * rollback, so filtering *after* them would let a rejected low-value request
   * still drain the budget the policy exists to preserve. Returns a policy-denial
   * {@link UnifiedAdmission} (releasing any held concurrency slot — an
   * upstream-style deny, not an overload drop) when value doesn't clear
   * `p_R + p_C·cost`, or `undefined` to let the admit proceed to rate/cost.
   *
   * On a policy deny the per-axis decisions are left unset (the axes were never
   * consulted — that is exactly what preserves their budget); `policyDenied: true`
   * is the signal that the filter, not an axis, bound (D-JLP-4).
   */
  function applyPolicyGate(
    value: number,
    requestCost: number,
    leaseRelease: ((opts?: { dropped?: boolean }) => void) | undefined,
  ): UnifiedAdmission | undefined {
    if (duals === undefined) return undefined;
    const bid = duals.rate + duals.cost * requestCost;
    if (value >= bid) return undefined;
    leaseRelease?.({ dropped: false });
    return { decision: denyByPolicy(combineSnapshot()), release: NOOP_RELEASE, policyDenied: true };
  }

  return {
    async admit(opts?: UnifiedAdmitOptions): Promise<UnifiedAdmission> {
      const { key = "", cost: requestCost = 1, value = 1 } = opts ?? {};
      resetLast();

      // Step 1 — concurrency (synchronous, both backends).
      const concStep = startWithConcurrency();
      if (concStep.decision !== undefined) {
        return { decision: concStep.decision, release: NOOP_RELEASE };
      }
      const leaseRelease = concStep.leaseRelease;

      // Step 2 — joint-LP bid-price filter, BEFORE any rate/cost debit (inert under
      // the default policy). A filtered request must not consume budget.
      const policyDeny = applyPolicyGate(value, requestCost, leaseRelease);
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
            return { decision: combineSnapshot(), release: NOOP_RELEASE };
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
            return { decision: combineSnapshot(), release: NOOP_RELEASE };
          }
        }

        // Sequential path — cost (async).
        if (cost !== undefined) {
          const d = await cost.check(key, requestCost);
          lastCost = d;
          if (!d.allowed) {
            leaseRelease?.({ dropped: false });
            return { decision: combineSnapshot(), release: NOOP_RELEASE };
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
      const { key = "", cost: requestCost = 1, value = 1 } = opts ?? {};
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
        return { decision: concStep.decision, release: NOOP_RELEASE };
      }
      const leaseRelease = concStep.leaseRelease;

      // Step 2 — joint-LP bid-price filter, BEFORE any rate/cost debit (inert under
      // the default policy). A filtered request must not consume budget.
      const policyDeny = applyPolicyGate(value, requestCost, leaseRelease);
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
            return { decision: combineSnapshot(), release: NOOP_RELEASE };
          }
        }

        // Cost.
        if (cost !== undefined) {
          const d = cost.checkSync(key, requestCost);
          lastCost = d;
          if (!d.allowed) {
            leaseRelease?.({ dropped: false });
            return { decision: combineSnapshot(), release: NOOP_RELEASE };
          }
        }

        return finalize(leaseRelease);
      } catch (err) {
        leaseRelease?.({ dropped: false });
        throw err;
      }
    },

    lastDecisions(): Readonly<Record<UnifiedAxis, Decision | undefined>> {
      return Object.freeze({
        rate: lastRate,
        concurrency: lastConc,
        cost: lastCost,
      });
    },
  };
}
