/**
 * The capture **admin** surface — a fail-closed, audited tool to `list` / `export` / `sweep` durable
 * segments. It is **not** reachable over the (default-insecure) gRPC port; it is an out-of-band local
 * tool the server has to *build* its auth for, because no server auth exists to inherit.
 *
 * **Fail-closed:** every action requires an operator credential that matches the configured one (compared
 * in constant time). If no credential is configured the admin surface is disabled entirely. An
 * unauthorized attempt performs no action and writes no audit record; every **authorized** action appends
 * one. `export` decrypts a segment and, for a leaf-rate one, projects it to the downstream-replayable
 * `ReplayTrace` JSON — replay itself runs downstream, never here.
 *
 * `runCaptureCli` is a pure function over injected deps (store / audit / config) so it is unit-testable;
 * the `argv`→`stdout` wiring lives in the server bin (P3.5).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { AuditLog } from "./audit.js";
import { projectToReplayTrace } from "./projection.js";
import type { SegmentStore } from "./store.js";
import type { CaptureConfig, CaptureSegment, ReplayTraceJSON } from "./types.js";

/** The admin actions. (`replay` is intentionally absent — it runs downstream on an exported trace.) */
export type CaptureCliAction = "list" | "export" | "sweep";

/** A request to the admin CLI. */
export interface CaptureCliRequest {
  readonly action: CaptureCliAction;
  /** Segment id, for `export`. */
  readonly id?: string;
  /** Operator credential (from an env var or arg) — required, fail-closed. */
  readonly credential?: string;
  /** Who is acting, for the audit trail (default `"operator"`). */
  readonly principal?: string;
}

/** One row of `list` output — the ref plus decrypted metadata (the operator is authorized). */
export interface CaptureListRow {
  readonly id: string;
  readonly createdAt: number;
  readonly policy?: string;
  readonly scope?: string;
  readonly policyKind?: string;
  readonly count?: number;
  /** Whether `export` would yield a replayable trace (leaf-rate) vs a forensic-only segment. */
  readonly replayable?: boolean;
}

/** `export` output — a downstream-replayable trace (leaf-rate) or the forensic segment (everything else). */
export type CaptureExport =
  | { readonly kind: "replay-trace"; readonly trace: ReplayTraceJSON }
  | { readonly kind: "forensic"; readonly segment: CaptureSegment };

/** The CLI result. `ok:false` carries a fail-closed/error reason and performs no state change. */
export interface CaptureCliResult {
  readonly ok: boolean;
  readonly output?: CaptureListRow[] | CaptureExport | { readonly purged: number };
  readonly error?: string;
}

/** Injected dependencies for {@link runCaptureCli}. */
export interface CaptureCliDeps {
  readonly config: CaptureConfig;
  readonly store: SegmentStore;
  readonly audit: AuditLog;
  readonly clock?: { now(): number };
}

/** Constant-time credential check (sha256 both sides ⇒ fixed length, no length leak, no early-out). */
function authorize(
  config: CaptureConfig,
  credential: string | undefined,
): { ok: true } | { ok: false; error: string } {
  if (config.auth === undefined)
    return {
      ok: false,
      error: "capture admin is disabled: no operator credential is configured (fail-closed)",
    };
  if (credential === undefined || credential === "")
    return { ok: false, error: "unauthorized: an operator credential is required" };
  const provided = createHash("sha256").update(credential).digest();
  const expected = createHash("sha256").update(config.auth.operatorSecret).digest();
  if (!timingSafeEqual(provided, expected))
    return { ok: false, error: "unauthorized: invalid operator credential" };
  return { ok: true };
}

/** Run one admin action, fail-closed and audited. Pure over its deps (no process/argv/stdout). */
export async function runCaptureCli(
  req: CaptureCliRequest,
  deps: CaptureCliDeps,
): Promise<CaptureCliResult> {
  const auth = authorize(deps.config, req.credential);
  if (!auth.ok) return { ok: false, error: auth.error }; // fail-closed: no action, no audit

  const now = (deps.clock ?? { now: () => Date.now() }).now();
  const principal =
    req.principal !== undefined && req.principal !== "" ? req.principal : "operator";

  try {
    if (req.action === "sweep") {
      const purged = await deps.store.sweep();
      await deps.audit.append({ ts: now, principal, action: "sweep" });
      return { ok: true, output: { purged } };
    }

    if (req.action === "list") {
      const rows: CaptureListRow[] = [];
      for (const ref of await deps.store.list()) {
        try {
          const seg = await deps.store.read(ref.id);
          rows.push({
            id: ref.id,
            createdAt: ref.createdAt,
            policy: seg.policy,
            scope: seg.scope,
            policyKind: seg.policyKind,
            count: seg.count,
            replayable: projectToReplayTrace(seg) !== null,
          });
        } catch {
          // expired/tampered ⇒ list the ref alone, never crash the listing
          rows.push({ id: ref.id, createdAt: ref.createdAt });
        }
      }
      await deps.audit.append({ ts: now, principal, action: "list" });
      return { ok: true, output: rows };
    }

    // export
    if (req.id === undefined || req.id === "")
      return { ok: false, error: "export requires a segment id" };
    const seg = await deps.store.read(req.id);
    await deps.audit.append({
      ts: now,
      principal,
      action: "export",
      policy: seg.policy,
      tenant: seg.scope,
      redactionMode: seg.redactionMode,
    });
    const trace = projectToReplayTrace(seg);
    return {
      ok: true,
      output: trace !== null ? { kind: "replay-trace", trace } : { kind: "forensic", segment: seg },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
