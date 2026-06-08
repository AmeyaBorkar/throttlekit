/**
 * Resolve + validate the top-level `replay:` config block into a {@link ReplayConfig}.
 *
 * Deterministic capture is **opt-in, default-OFF** — like `capture:` (#289) it records (redacted) keys, so
 * anything but an explicit `enabled: true` resolves to disabled. It is a **distinct** block from `capture:`
 * (its own bound `maxSteps`, and it produces in-memory replayable traces, not durable forensic segments).
 *
 * Redaction defaults to the privacy-maximal `per-trace-salt` (the shadow always redacts; traces are never
 * written to disk, so a mode need not be named). A `candidate:` block names the operator's what-if — a
 * leaf-rate `policy` plus `set` / `scale` / `swap` deltas, parsed into the testkit candidate DSL.
 */

import { ThrottleKitError } from "throttlekit";
import type { ConfigStrategy, LimiterSpec } from "throttlekit/config";
import type { Candidate, CandidateOp } from "throttlekit/testkit";
import type { RedactionConfig, RedactionMode } from "../capture/types.js";

const REDACTION_MODES: readonly RedactionMode[] = ["hmac", "per-trace-salt", "drop"];
/** Default per-policy shadow cap = the OOM bound (#299). */
export const DEFAULT_MAX_STEPS = 50_000;

/** The operator's configured what-if: which leaf-rate policy, and the candidate delta to compare. */
export interface ConfiguredCandidate {
  readonly policy: string;
  readonly candidate: Candidate;
}

/** Resolved, validated `replay:` config. `enabled:false` ⇒ no deterministic capture (the default). */
export interface ReplayConfig {
  readonly enabled: boolean;
  /** Leaf-rate policies to shadow; absent ⇒ every leaf-rate policy. */
  readonly policies?: readonly string[];
  /** Per-policy shadow step cap (the OOM bound). */
  readonly maxSteps: number;
  /** Redaction applied to every key before it enters a shadow (default `per-trace-salt`). */
  readonly redaction: RedactionConfig;
  /** The operator's configured what-if (run by the TUI trigger), if any. */
  readonly candidate?: ConfiguredCandidate;
}

const DISABLED: ReplayConfig = {
  enabled: false,
  maxSteps: DEFAULT_MAX_STEPS,
  redaction: { mode: "per-trace-salt" },
};

/** Options for {@link resolveReplayConfig}. */
export interface ResolveReplayOptions {
  /** Env source for the hmac secret (default `process.env`). */
  env?: Record<string, string | undefined>;
}

function positiveInt(where: string, v: unknown, dflt: number): number {
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
    throw new ThrottleKitError(`${where}: must be a positive integer`);
  return v;
}

function asObject(where: string, v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new ThrottleKitError(`${where}: expected an object`);
  return v as Record<string, unknown>;
}

/** Resolve the redaction block (default `per-trace-salt`; `hmac` needs a secret or `secretEnv`). */
function resolveRedaction(raw: unknown, env: Record<string, string | undefined>): RedactionConfig {
  if (raw === undefined) return { mode: "per-trace-salt" };
  const r = asObject("config.replay.redaction", raw);
  const mode = r.mode as RedactionMode;
  if (!REDACTION_MODES.includes(mode))
    throw new ThrottleKitError(
      `config.replay.redaction.mode: must be one of ${REDACTION_MODES.join(", ")}`,
    );
  if (mode !== "hmac") return { mode };
  let secret: string | undefined;
  if (r.secretEnv !== undefined) {
    if (typeof r.secretEnv !== "string" || r.secretEnv === "")
      throw new ThrottleKitError(
        "config.replay.redaction.secretEnv: must be a non-empty env var name",
      );
    secret = env[r.secretEnv];
    if (secret === undefined || secret === "")
      throw new ThrottleKitError(
        `config.replay.redaction: env var ${JSON.stringify(r.secretEnv)} is not set`,
      );
  } else if (typeof r.secret === "string" && r.secret !== "") {
    secret = r.secret;
  }
  if (secret === undefined)
    throw new ThrottleKitError(
      "config.replay.redaction: hmac mode requires `secret` or `secretEnv`",
    );
  return { mode: "hmac", secret };
}

/**
 * Resolve the optional `policies:` whitelist. Accepts an **array** of names (JSON / programmatic) OR a
 * **comma/space-separated string** (`"api, search"`) — the latter because the core's minimal YAML parser
 * supports no sequences, so a YAML config can't express a list any other way. An empty result ⇒ undefined
 * (shadow every leaf-rate policy), so `policies: ""` is not a footgun that silently shadows nothing.
 */
function resolvePolicies(raw: unknown): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "string") {
    const list = raw.split(/[,\s]+/).filter(Boolean);
    return list.length > 0 ? list : undefined;
  }
  if (Array.isArray(raw) && raw.every((p) => typeof p === "string")) return raw as string[];
  throw new ThrottleKitError(
    "config.replay.policies: an array of policy names (JSON) or a comma-separated string (YAML)",
  );
}

/**
 * Parse the `candidate:` block into a {@link ConfiguredCandidate}. `policy` is required; the deltas are the
 * union of `set` / `scale` / `swap` maps. The ops are validated structurally here (the spec-path / one-op-
 * per-field rules are enforced by the testkit `resolveCandidate` when the what-if runs — surfaced honestly
 * as a `refused` snapshot, never a silent no-op).
 */
function resolveConfiguredCandidate(raw: unknown): ConfiguredCandidate | undefined {
  if (raw === undefined) return undefined;
  const c = asObject("config.replay.candidate", raw);
  if (typeof c.policy !== "string" || c.policy === "")
    throw new ThrottleKitError(
      "config.replay.candidate.policy: required (the leaf-rate policy to compare)",
    );

  const ops: CandidateOp[] = [];
  if (c.set !== undefined) {
    const s = asObject("config.replay.candidate.set", c.set);
    for (const [path, value] of Object.entries(s))
      ops.push({ kind: "set", path: path as never, value });
  }
  if (c.scale !== undefined) {
    const s = asObject("config.replay.candidate.scale", c.scale);
    for (const [path, factor] of Object.entries(s)) {
      if (typeof factor !== "number" || !Number.isFinite(factor))
        throw new ThrottleKitError(
          `config.replay.candidate.scale.${path}: must be a finite number`,
        );
      ops.push({ kind: "scale", path: path as never, factor });
    }
  }
  if (c.swap !== undefined) {
    const s = asObject("config.replay.candidate.swap", c.swap);
    const { strategy, ...fields } = s;
    if (typeof strategy !== "string")
      throw new ThrottleKitError(
        "config.replay.candidate.swap.strategy: required (the new strategy)",
      );
    ops.push({
      kind: "swap",
      strategy: strategy as ConfigStrategy,
      fields: fields as Partial<LimiterSpec>,
    });
  }
  if (ops.length === 0)
    throw new ThrottleKitError(
      "config.replay.candidate: name at least one delta — `set`, `scale`, or `swap`",
    );

  return { policy: c.policy, candidate: { name: "configured", ops } };
}

/**
 * Resolve the `replay:` block (raw, from YAML/JSON or a programmatic object) into a validated
 * {@link ReplayConfig}. Returns the disabled config for an absent block or `enabled !== true`.
 */
export function resolveReplayConfig(
  raw: unknown,
  options: ResolveReplayOptions = {},
): ReplayConfig {
  if (raw === undefined || raw === null) return DISABLED;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new ThrottleKitError("config.replay: expected an object");
  const c = raw as Record<string, unknown>;
  // Opt-in: anything but an explicit `true` is OFF (a typo'd flag must never silently enable PII capture).
  if (c.enabled !== true) return DISABLED;

  const env = options.env ?? process.env;
  const resolved: {
    enabled: true;
    maxSteps: number;
    redaction: RedactionConfig;
    policies?: readonly string[];
    candidate?: ConfiguredCandidate;
  } = {
    enabled: true,
    maxSteps: positiveInt("config.replay.maxSteps", c.maxSteps, DEFAULT_MAX_STEPS),
    redaction: resolveRedaction(c.redaction, env),
  };
  const policies = resolvePolicies(c.policies);
  if (policies !== undefined) resolved.policies = policies;
  const candidate = resolveConfiguredCandidate(c.candidate);
  if (candidate !== undefined) resolved.candidate = candidate;
  return resolved;
}
