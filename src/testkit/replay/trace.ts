import type { Decision } from "../../core/types";
import { ReplayRefusedError } from "./errors";
import type { ReplayFingerprint } from "./spec";

/**
 * Current on-disk trace format. A serialized trace from any other version is refused on parse
 * (fail-loud forward/backward compatibility): a stored trace must be re-recorded on a version bump
 * rather than silently mis-read.
 */
export const TRACE_FORMAT_VERSION = 1 as const;

/**
 * One recorded decision: the exact `(key, cost, instant)` inputs and the {@link Decision} the
 * limiter produced. `at` is the absolute epoch-ms the {@link ManualClock} read at the check; replay
 * `set()`s the clock to it (absolute, never an accumulated delta), so coincident instants and any
 * ordering reproduce faithfully.
 */
export interface ReplayStep {
  readonly key: string;
  readonly cost: number;
  readonly at: number;
  readonly decision: Decision;
}

/**
 * A self-contained, JSON-serializable decision trace: a {@link ReplayFingerprint} (everything needed
 * to rebuild the exact leaf limiter) plus the ordered decision {@link ReplayStep}s. Replay drives the
 * steps, in order, against a freshly-rebuilt **cold** limiter and checks the Decisions reproduce.
 */
export interface ReplayTrace {
  /** Format version — see {@link TRACE_FORMAT_VERSION}. */
  readonly version: typeof TRACE_FORMAT_VERSION;
  /** Rebuild + validation fingerprint. */
  readonly fingerprint: ReplayFingerprint;
  /** Whether any recorded `key` was passed through a redaction hook (honest disclosure on a stored trace). */
  readonly redacted: boolean;
  /**
   * True when recording stopped at its cap — the trace is a faithful **prefix**, not the whole run.
   * Replay refuses a truncated trace (a what-if over a prefix understates the effect).
   */
  readonly truncated: boolean;
  /** Steps dropped after the cap (`0` unless truncated). For honest reporting only. */
  readonly dropped: number;
  /** The ordered decision steps. */
  readonly steps: readonly ReplayStep[];
}

/** Serialize a trace to JSON (it is plain data — `Decision`s and a declarative spec). */
export function serializeTrace(trace: ReplayTrace): string {
  return JSON.stringify(trace);
}

/**
 * Parse a serialized trace, refusing any incompatible {@link TRACE_FORMAT_VERSION} (fail-loud). This
 * is a structural gate on the version envelope, not a deep schema validation: a trace produced by a
 * compatible version is trusted, an incompatible one is rejected with a clear instruction.
 */
export function parseTrace(text: string): ReplayTrace {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ReplayRefusedError(
      "trace-format-version",
      `replay: trace is not valid JSON: ${(e as Error).message}`,
    );
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReplayRefusedError("trace-format-version", "replay: trace is not an object");
  }
  const version = (raw as { version?: unknown }).version;
  if (version !== TRACE_FORMAT_VERSION) {
    throw new ReplayRefusedError(
      "trace-format-version",
      `replay: unsupported trace format version ${JSON.stringify(version)} ` +
        `(this build reads ${TRACE_FORMAT_VERSION}); re-record with the current version`,
    );
  }
  const trace = raw as ReplayTrace;
  assertWellFormedTrace(trace);
  return trace;
}

function malformed(detail: string): ReplayRefusedError {
  return new ReplayRefusedError("trace-malformed", `replay: malformed trace — ${detail}`);
}

/**
 * Structurally validate a (version-compatible) trace before any replay trusts it. A trace that was
 * serialized, transmitted, or hand-built is **untrusted input**: without this check a non-array
 * `steps` reads `steps.length === undefined`, slips past the empty/loop guards, and produces a
 * misleading "zero divergence" result instead of a refusal. This is the trust boundary — it refuses
 * (`trace-malformed`) anything the downstream guards and the engine's `drive`/`divergence` would
 * otherwise misread. A trace from {@link recordLimiter} is always well-formed, so the happy path is a
 * cheap pass.
 */
export function assertWellFormedTrace(trace: ReplayTrace): void {
  const t = trace as unknown as Record<string, unknown>;
  if (t === null || typeof t !== "object") throw malformed("not an object");

  const fp = t.fingerprint as Record<string, unknown> | undefined;
  if (fp === null || typeof fp !== "object")
    throw malformed("fingerprint is missing or not an object");
  if (fp.spec === null || typeof fp.spec !== "object")
    throw malformed("fingerprint.spec is missing or not an object");
  if (fp.strategy === null || typeof fp.strategy !== "object")
    throw malformed("fingerprint.strategy is missing or not an object");

  if (t.dropped !== undefined && typeof t.dropped !== "number")
    throw malformed("dropped is present but not a number");

  if (!Array.isArray(t.steps)) throw malformed("steps is missing or not an array");
  for (let i = 0; i < t.steps.length; i++) {
    const s = t.steps[i] as Record<string, unknown> | null;
    if (s === null || typeof s !== "object") throw malformed(`step ${i} is not an object`);
    if (typeof s.key !== "string") throw malformed(`step ${i}.key is not a string`);
    if (typeof s.cost !== "number" || !Number.isFinite(s.cost) || s.cost <= 0)
      throw malformed(`step ${i}.cost must be a positive finite number`);
    if (typeof s.at !== "number" || !Number.isFinite(s.at))
      throw malformed(`step ${i}.at must be a finite number`);
    const d = s.decision as Record<string, unknown> | null;
    if (d === null || typeof d !== "object") throw malformed(`step ${i}.decision is missing`);
    if (typeof d.allowed !== "boolean")
      throw malformed(`step ${i}.decision.allowed is not a boolean`);
    for (const field of ["limit", "remaining", "resetAt", "retryAfterMs"] as const) {
      if (typeof d[field] !== "number" || !Number.isFinite(d[field]))
        throw malformed(`step ${i}.decision.${field} is not a finite number`);
    }
  }
}
