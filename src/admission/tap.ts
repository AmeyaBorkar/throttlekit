/**
 * The admission **tap** — the multi-axis sibling of {@link tapDecisions}. Fires once per completed
 * unified admission with the combined decision, the binding axis, and the per-axis snapshot, so a
 * dashboard (the ThrottleKit Lens) can attribute every denial to the exact axis — or the joint-LP
 * `"policy"` lane — that bound it.
 *
 * Dependency-free. Like {@link tapDecisions}, the observer **must not throw** (exceptions are swallowed)
 * and runs **synchronously** right after the admit resolves, in O(1), so it can never perturb the
 * admission-control path. Where `tapDecisions` taps a {@link Limiter}, this taps a {@link UnifiedAdmitter};
 * pair them so the universal board (any limiter) gains the binding-axis lane for unified-admission users.
 *
 * @experimental Excluded from the 1.x SemVer guarantee (may change in a minor). See STABILITY.md.
 */

import type { Decision } from "../core/types";
import type {
  UnifiedAdmission,
  UnifiedAdmitOptions,
  UnifiedAdmitter,
  UnifiedAxis,
} from "./unified";

/** A denial lane in the admission Sankey: a binding axis, or the joint-LP bid-price `"policy"` filter. */
export type AdmissionLane = UnifiedAxis | "policy";

/** Which admitter method produced an event (so a tap can distinguish the async/sync paths). */
export type AdmissionKind = "admit" | "admitSync";

/** One observed unified admission handed to an {@link AdmissionTap}. */
export interface AdmissionEvent {
  /** The admit key (the rate/cost bucket); `""` is the global bucket. */
  key: string;
  /** The cost-axis weight of the admit (default 1). */
  cost: number;
  /** The joint-LP bid value of the admit (default 1; only meaningful under `policy: "joint-lp"`). */
  value: number;
  /** The combined decision returned to the caller. */
  decision: Decision;
  /** The axis that bound a denial (`undefined` on an allow, or on a joint-LP `policy` denial). */
  bindingAxis?: UnifiedAxis;
  /** True iff a joint-LP bid-price filter denied while every per-axis budget had slack. */
  policyDenied: boolean;
  /**
   * The single lane this event is attributed to in the Sankey: the binding axis, or `"policy"` for a
   * joint-LP denial. `undefined` when the admission was allowed. **Exactly one lane per denial.**
   */
  lane?: AdmissionLane;
  /**
   * The per-axis decision snapshot at emit time (`= admitter.lastDecisions()`). Exact for `admitSync`
   * and for non-concurrent `admit`; under multiple `admit()`s racing on the *same* admitter it is
   * best-effort (the admitter overwrites `lastDecisions()` each admit) — the `decision`/`bindingAxis`/
   * `lane` above are always exact (captured from this admit's own result), so lane attribution is exact.
   */
  perAxis: Readonly<Partial<Record<UnifiedAxis, Decision | undefined>>>;
  /** Wall time spent inside the inner admit, in fractional ms. */
  durationMs: number;
  /** Which admitter method produced this event. */
  kind: AdmissionKind;
}

/** A side-effecting observer of admissions. It must not throw — exceptions are swallowed. */
export type AdmissionTap = (event: AdmissionEvent) => void;

/** High-resolution monotonic clock (fractional ms), falling back to `Date.now` off the main path. */
const monoNowMs: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? (): number => performance.now()
    : (): number => Date.now();

/**
 * The single lane a result is attributed to: `undefined` on an allow, the binding axis on an
 * axis-bound deny, else `"policy"`. A denied admission with no binding axis is, by the
 * `unifiedAdmission` contract, a joint-LP bid-price (`policyDenied`) denial.
 */
function laneOf(admission: UnifiedAdmission): AdmissionLane | undefined {
  if (admission.decision.allowed) return undefined;
  return admission.bindingAxis ?? "policy";
}

/**
 * Wrap `admitter` so `onAdmission` fires once per completed `admit`/`admitSync` (after the admission
 * resolves), then return the admission unchanged. A throwing tap can never break admission — its
 * exceptions are caught and dropped. `lastDecisions()` is forwarded.
 *
 * @example
 * ```ts
 * const admit = admissionTap(unifiedAdmission({ rate, concurrency, cost }), (e) => {
 *   if (e.lane) denyCounter.add(1, { lane: e.lane }); // attribute the deny to its one binding lane
 * });
 * ```
 *
 * @experimental Excluded from the 1.x SemVer guarantee (may change in a minor). See STABILITY.md.
 */
export function admissionTap(
  admitter: UnifiedAdmitter,
  onAdmission: AdmissionTap,
): UnifiedAdmitter {
  const emit = (
    opts: UnifiedAdmitOptions | undefined,
    admission: UnifiedAdmission,
    durationMs: number,
    kind: AdmissionKind,
  ): void => {
    try {
      // Build with bindingAxis/lane OMITTED when undefined — the core's convention under
      // exactOptionalPropertyTypes (an absent optional field, not an explicit `undefined`).
      const event: AdmissionEvent = {
        key: opts?.key ?? "",
        cost: opts?.cost ?? 1,
        value: opts?.value ?? 1,
        decision: admission.decision,
        policyDenied: admission.policyDenied ?? false,
        perAxis: admitter.lastDecisions(),
        durationMs,
        kind,
      };
      if (admission.bindingAxis !== undefined) event.bindingAxis = admission.bindingAxis;
      const lane = laneOf(admission);
      if (lane !== undefined) event.lane = lane;
      onAdmission(event);
    } catch {
      // A tap is an observer; its failure must never propagate into the admission path.
    }
  };

  return {
    async admit(opts?: UnifiedAdmitOptions): Promise<UnifiedAdmission> {
      const t0 = monoNowMs();
      const admission = await admitter.admit(opts);
      emit(opts, admission, monoNowMs() - t0, "admit");
      return admission;
    },

    admitSync(opts?: UnifiedAdmitOptions): UnifiedAdmission {
      const t0 = monoNowMs();
      const admission = admitter.admitSync(opts);
      emit(opts, admission, monoNowMs() - t0, "admitSync");
      return admission;
    },

    lastDecisions(): Readonly<Partial<Record<UnifiedAxis, Decision | undefined>>> {
      return admitter.lastDecisions();
    },
  };
}
