/**
 * Project a leaf-rate {@link CaptureSegment} to the documented P1 `ReplayTrace` JSON format, for
 * **downstream** replay (the server has no testkit to replay in-process). A non-leaf segment
 * (admitter/meter/fair-escrow) or a segment missing its `spec`/`strategy` projects to `null` — it is
 * **forensic-only**, never falsely presented as replayable.
 *
 * A live capture stamps `clock:"system"`, so the projected trace is **replay-refused** (`non-manual-clock`)
 * by the P1 guards until the deterministic-capture mode (a follow-on) supplies `"manual"`-equivalent timing.
 * The forensic identity the server registers is intentionally **lossy** (a minimal `{strategy, limit}` spec;
 * no `windowMs`/`period`/`ttl`), which is fine while every capture is `clock:"system"` (refused first); the
 * deterministic-capture follow-on must enrich the registered spec/strategy before a projected trace could
 * actually rebuild and replay.
 */

import type { CaptureSegment, ReplayTraceJSON } from "./types.js";

/**
 * Project a segment to a {@link ReplayTraceJSON}, or `null` when it is not a replayable leaf-rate segment.
 * `truncated` is derived from `dropped > 0` (a dropped tail makes a what-if understate the effect — the P1
 * guards refuse a truncated trace), mirroring the recorder's honest bound.
 */
export function projectToReplayTrace(segment: CaptureSegment): ReplayTraceJSON | null {
  if (segment.policyKind !== "rate") return null;
  if (segment.spec === undefined || segment.strategy === undefined) return null;

  const trace: ReplayTraceJSON = {
    version: 1,
    fingerprint: {
      spec: segment.spec,
      strategy: segment.strategy,
      clock: segment.clock,
      axis: "rate",
      policy: null,
      luaSha1: segment.luaSha1 ?? null,
      ...(segment.spec.prefix !== undefined ? { prefix: segment.spec.prefix } : {}),
    },
    redacted: segment.redactionMode !== undefined,
    truncated: segment.dropped > 0,
    dropped: segment.dropped,
    steps: segment.events.map((e) => ({
      key: e.keyRef,
      cost: e.cost,
      at: e.at,
      decision: e.decision,
    })),
  };
  return trace;
}
