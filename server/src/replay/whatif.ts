/**
 * On-demand **what-if** (#299↔#290 bridge): replay a policy's shadow trace against an operator-configured
 * candidate and reduce it to a render-ready {@link ReplayDivergenceSnapshot}. The headline is the
 * directional admit/deny flip count ("how many requests would change, and which way").
 *
 * It **never throws to the UI**: every refusal the testkit can raise (empty / truncated / candidate-invalid /
 * identity-divergence / unrebuildable …) maps to a typed, honest `state`, so a TUI keybind can call this in a
 * tight loop and only ever get a snapshot back. `replay()` runs the identity self-check first, so an "ok"
 * snapshot's flips are provably attributable to the candidate, not a broken substrate.
 */

import {
  type Candidate,
  type ReplayRefusal,
  ReplayRefusedError,
  replay,
  resolveCandidate,
} from "throttlekit/testkit";
import type { Shadow } from "./shadow.js";

/** Outcome class of a what-if — exactly one is true, and the renderer echoes it verbatim. */
export type WhatIfState =
  /** Replayed cleanly; `flipped*` carry the headline. */
  | "ok"
  /** The shadow has no recorded decisions yet (drive some traffic). */
  | "empty"
  /** The shadow hit its cap; a what-if over the prefix would understate — refused. */
  | "truncated"
  /** A redaction collision poisoned the shadow (negligible with full HMAC). */
  | "poisoned"
  /** Any other replay refusal (candidate-invalid / identity-divergence / unrebuildable / …). */
  | "refused";

/** A render-ready divergence result for one policy's configured what-if. */
export interface ReplayDivergenceSnapshot {
  readonly policy: string;
  readonly candidateName: string;
  readonly state: WhatIfState;
  /** Decisions recorded in the shadow (context, even when refused/empty). */
  readonly steps: number;
  /** Requests the recording admitted that the candidate denies (a tightening). 0 unless `ok`. */
  readonly flippedAllowToDeny: number;
  /** Requests the recording denied that the candidate admits (a loosening). 0 unless `ok`. */
  readonly flippedDenyToAllow: number;
  /** `flippedAllowToDeny + flippedDenyToAllow` — the headline. */
  readonly flippedTotal: number;
  /** Steps differing on any Decision field (broader than flips — context, not the headline). */
  readonly divergent: number;
  /** Steps compared. */
  readonly total: number;
  /** Present when not `ok` — the machine-readable reason + message. */
  readonly refusal?: { readonly reason: ReplayRefusal | "poisoned"; readonly message: string };
}

/** Count `allowed` flips by direction over the divergent steps. */
function directional(steps: ReturnType<typeof replay>["divergence"]["steps"]): {
  a2d: number;
  d2a: number;
} {
  let a2d = 0;
  let d2a = 0;
  for (const step of steps) {
    const f = step.diffs.find((d) => d.field === "allowed");
    if (f === undefined) continue;
    if (f.recorded === true && f.replayed === false) a2d++;
    else if (f.recorded === false && f.replayed === true) d2a++;
  }
  return { a2d, d2a };
}

/**
 * Run `cand` against `shadow`'s recorded trace. Pure (no I/O); synchronous; bounded by the trace length;
 * never throws. Suitable to call straight off a TUI keybind — it runs off the gRPC decision path and over
 * the shadow's isolated store, so it cannot perturb production.
 */
export function runWhatIf(
  policy: string,
  shadow: Shadow,
  cand: Candidate,
): ReplayDivergenceSnapshot {
  const base = {
    policy,
    candidateName: cand.name,
    steps: shadow.steps,
    flippedAllowToDeny: 0,
    flippedDenyToAllow: 0,
    flippedTotal: 0,
    divergent: 0,
    total: 0,
  } as const;

  if (shadow.poisoned) {
    return {
      ...base,
      state: "poisoned",
      refusal: { reason: "poisoned", message: "shadow poisoned by a redaction collision" },
    };
  }

  const trace = shadow.trace();
  try {
    const resolved = resolveCandidate(trace, cand); // throws candidate-invalid on an ill-formed delta
    const result = replay(trace, { candidate: resolved.spec }); // identity self-check + candidate replay
    const { a2d, d2a } = directional(result.divergence.steps);
    return {
      ...base,
      state: "ok",
      flippedAllowToDeny: a2d,
      flippedDenyToAllow: d2a,
      flippedTotal: a2d + d2a,
      divergent: result.divergence.divergent,
      total: result.divergence.total,
    };
  } catch (e) {
    if (e instanceof ReplayRefusedError) {
      const state: WhatIfState =
        e.reason === "trace-empty"
          ? "empty"
          : e.reason === "trace-truncated"
            ? "truncated"
            : "refused";
      return { ...base, state, refusal: { reason: e.reason, message: e.message } };
    }
    // A rebuild error (e.g. a swap missing a required field) is still an invalid candidate, surfaced loudly.
    return {
      ...base,
      state: "refused",
      refusal: {
        reason: "candidate-invalid",
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }
}
