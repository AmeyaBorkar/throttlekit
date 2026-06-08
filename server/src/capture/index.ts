/**
 * Server opt-in capture (#289 / Replay P3 — the design's Phase B): a durable, **redacted**, encrypted
 * **forensic** record of the server's live decision stream. Opt-in default-OFF (it records PII); captures
 * are stamped `clock:"system"` so the P1 replay guards refuse them except the leaf-rate deterministic
 * subset. See `research/dashboard/designs/289-server-capture.md`.
 *
 * @experimental Excluded from any SemVer guarantee; shapes may change.
 */

export type {
  AuditRecord,
  CaptureClock,
  CaptureConfig,
  CaptureCounts,
  CaptureEvent,
  CapturePolicyMeta,
  CaptureSegment,
  DurableConfig,
  PolicyKind,
  RedactionConfig,
  RedactionMode,
  ReplayStrategyIdentity,
  ReplayTraceJSON,
  RetentionConfig,
  TenantRule,
} from "./types.js";
export { type ResolveCaptureOptions, resolveCaptureConfig } from "./config.js";
export { DROP_PLACEHOLDER, type Redactor, createRedactor } from "./redact.js";
export {
  type CaptureRecorder,
  type CaptureRecorderOptions,
  type RecordInput,
  createCaptureRecorder,
} from "./recorder.js";
export { projectToReplayTrace } from "./projection.js";
