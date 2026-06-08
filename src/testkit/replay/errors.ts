import { ThrottleKitError } from "../../core/errors";

/**
 * Why a replay was refused. Replay never silently returns a misleading result — when a precondition
 * is violated it throws a {@link ReplayRefusedError} carrying one of these. Each value is a distinct,
 * fail-loud hazard (design §4.5 / §9):
 *
 * - `trace-format-version` — a serialized trace from an incompatible {@link TRACE_FORMAT_VERSION}.
 * - `trace-malformed`      — a version-compatible trace whose structure is invalid (e.g. `steps` is
 *                            not an array, a step is missing fields, or a Decision field is non-finite).
 *                            A parsed/transmitted trace is untrusted input; replay refuses it rather
 *                            than failing open to a misleading "zero divergence".
 * - `trace-empty`          — the trace has no steps to replay.
 * - `trace-truncated`      — recording hit its cap and dropped steps; a what-if over a prefix would
 *                            understate the effect, so the partial trace is refused (re-record larger).
 * - `unrebuildable-strategy` — the spec's strategy is not constructible by `buildStrategy`
 *                            (e.g. `leakyBucket`, or a composite/unknown strategy).
 * - `non-manual-clock`     — the recording ran over the system clock or a Redis server clock, so its
 *                            instants are not deterministically reproducible.
 * - `lua-sha1-mismatch`    — the rebuilt strategy's Lua differs from what was recorded (build drift):
 *                            the rebuild is not the strategy that produced the trace.
 * - `strategy-mismatch`    — the rebuilt strategy's identity (name/limit/window) ≠ the recorded
 *                            fingerprint (a tampered or mislabelled trace).
 * - `unreplayable-axis`    — a non-rate admission axis (concurrency: releases are not decisions, so a
 *                            decision trace cannot reproduce them).
 * - `unreplayable-policy`  — a joint-LP admission policy (a bid-price filter, not a leaf decision).
 * - `keyref-collision`     — a redaction hook mapped two distinct keys to one value, which would merge
 *                            their state and corrupt the replay.
 * - `identity-divergence`  — the identity self-check failed: replaying the recorded spec did not
 *                            reproduce the recording bit-for-bit, so the determinism substrate is broken.
 * - `candidate-invalid`    — a P2 candidate delta is ill-formed (unknown field, more than one op on a
 *                            field, a non-numeric `scale` base) or produced a spec `buildStrategy` cannot
 *                            construct (e.g. a `swap` missing the new strategy's required fields). The
 *                            scorecard surfaces this as a loud per-candidate `refused` row, never a
 *                            silent zero-change result.
 */
export type ReplayRefusal =
  | "trace-format-version"
  | "trace-malformed"
  | "trace-empty"
  | "trace-truncated"
  | "unrebuildable-strategy"
  | "non-manual-clock"
  | "lua-sha1-mismatch"
  | "strategy-mismatch"
  | "unreplayable-axis"
  | "unreplayable-policy"
  | "keyref-collision"
  | "identity-divergence"
  | "candidate-invalid";

/**
 * A replay precondition was violated. Carries a machine-readable {@link ReplayRefusal} `reason` —
 * prefer it over message matching. The base `code` is `"config_invalid"`: a refusal is, at root, a
 * statement that the trace/spec is not a valid replay input.
 *
 * @experimental Part of the opt-in replay testkit (see STABILITY.md).
 */
export class ReplayRefusedError extends ThrottleKitError {
  /** The specific precondition that was violated. */
  readonly reason: ReplayRefusal;

  constructor(reason: ReplayRefusal, message: string) {
    super(message, { code: "config_invalid" });
    this.name = "ReplayRefusedError";
    this.reason = reason;
  }
}
