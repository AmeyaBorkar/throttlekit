/**
 * Resolve + validate the top-level `capture:` config block into a {@link CaptureConfig}.
 *
 * Capture is **opt-in, default-OFF** — the documented exception to the available-by-default posture,
 * because it records PII. Anything but an explicit `enabled: true` resolves to disabled. When enabled,
 * a redaction mode is **mandatory** (no capture without a redaction choice), and a durable store makes
 * AES-256-GCM encryption **mandatory** (no plaintext-on-disk). A bad config fails fast with a clear
 * message rather than silently capturing raw keys.
 */

import { ThrottleKitError } from "throttlekit";
import type {
  CaptureConfig,
  DurableConfig,
  RedactionConfig,
  RedactionMode,
  RetentionConfig,
  TenantRule,
} from "./types.js";

const REDACTION_MODES: readonly RedactionMode[] = ["hmac", "per-trace-salt", "drop"];

/** The disabled config — what an absent or `enabled:false` block resolves to (no capture happens). */
const DISABLED: CaptureConfig = {
  enabled: false,
  redaction: { mode: "drop" },
  retention: { ttlMs: 86_400_000, maxScopes: 1000, ringSize: 10_000 },
};

/** Options for {@link resolveCaptureConfig}. */
export interface ResolveCaptureOptions {
  /** Env source for secret/key resolution (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** Programmatic tenant rule; overrides the declarative `tenant:` block when supplied. */
  tenantOf?: TenantRule;
}

function positiveInt(where: string, v: unknown, dflt: number): number {
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
    throw new ThrottleKitError(`${where}: must be a positive integer`);
  return v;
}

/** Read a secret from `env[<x>Env]` (preferred — no plaintext in config) or a direct string field. */
function readSecret(
  where: string,
  direct: unknown,
  envName: unknown,
  env: Record<string, string | undefined>,
): string | undefined {
  if (envName !== undefined) {
    if (typeof envName !== "string" || envName === "")
      throw new ThrottleKitError(`${where}Env: must be a non-empty env var name`);
    const v = env[envName];
    if (v === undefined || v === "")
      throw new ThrottleKitError(`${where}: env var ${JSON.stringify(envName)} is not set`);
    return v;
  }
  if (direct === undefined) return undefined;
  if (typeof direct !== "string" || direct === "")
    throw new ThrottleKitError(`${where}: must be a non-empty string`);
  return direct;
}

/** Parse the declarative `tenant:` block into a {@link TenantRule}, or `undefined` (counts-only). */
function resolveTenantRule(raw: unknown): TenantRule | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ThrottleKitError("config.capture.tenant: expected an object");
  const t = raw as Record<string, unknown>;
  const from = t.from;
  if (from === "key") return (_policy, key) => key;
  if (from === "key-prefix") {
    const delimiter = t.delimiter ?? ":";
    if (typeof delimiter !== "string" || delimiter === "")
      throw new ThrottleKitError("config.capture.tenant.delimiter: must be a non-empty string");
    return (_policy, key) => {
      const i = key.indexOf(delimiter);
      return i === -1 ? key : key.slice(0, i);
    };
  }
  throw new ThrottleKitError('config.capture.tenant.from: must be "key" or "key-prefix"');
}

/**
 * Resolve the `capture:` block (raw, from YAML/JSON or a programmatic object) into a validated
 * {@link CaptureConfig}. Returns the disabled config for an absent block or `enabled !== true`.
 */
export function resolveCaptureConfig(
  raw: unknown,
  options: ResolveCaptureOptions = {},
): CaptureConfig {
  if (raw === undefined || raw === null) return DISABLED;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new ThrottleKitError("config.capture: expected an object");
  const c = raw as Record<string, unknown>;
  // Opt-in: anything but an explicit `true` is OFF (a typo'd flag must never silently enable PII capture).
  if (c.enabled !== true) return DISABLED;

  const env = options.env ?? process.env;

  // Redaction — mandatory when enabled.
  const r = c.redaction;
  if (r === undefined || typeof r !== "object" || Array.isArray(r))
    throw new ThrottleKitError(
      "config.capture.redaction: required when capture is enabled (name a mode)",
    );
  const rr = r as Record<string, unknown>;
  const mode = rr.mode as RedactionMode;
  if (!REDACTION_MODES.includes(mode))
    throw new ThrottleKitError(
      `config.capture.redaction.mode: must be one of ${REDACTION_MODES.join(", ")}`,
    );
  const redaction: RedactionConfig =
    mode === "hmac"
      ? {
          mode,
          secret:
            readSecret("config.capture.redaction.secret", rr.secret, rr.secretEnv, env) ??
            raise("config.capture.redaction: hmac mode requires `secret` or `secretEnv`"),
        }
      : { mode };

  // Retention bounds.
  const ret = (c.retention as Record<string, unknown> | undefined) ?? {};
  const retention: RetentionConfig = {
    ttlMs: positiveInt("config.capture.retention.ttlMs", ret.ttlMs, 86_400_000),
    maxScopes: positiveInt("config.capture.retention.maxScopes", ret.maxScopes, 1000),
    ringSize: positiveInt("config.capture.retention.ringSize", ret.ringSize, 10_000),
  };

  const resolved: {
    enabled: true;
    redaction: RedactionConfig;
    retention: RetentionConfig;
    durable?: DurableConfig;
    tenantOf?: TenantRule;
    auth?: { operatorSecret: string };
  } = { enabled: true, redaction, retention };

  // Durable store — encryption mandatory when present.
  const d = c.durable;
  if (d !== undefined) {
    if (typeof d !== "object" || d === null || Array.isArray(d))
      throw new ThrottleKitError("config.capture.durable: expected an object");
    const dd = d as Record<string, unknown>;
    if (typeof dd.dir !== "string" || dd.dir === "")
      throw new ThrottleKitError("config.capture.durable.dir: required (segment directory)");
    const keyHex = readSecret(
      "config.capture.durable.encryptionKeyHex",
      dd.encryptionKeyHex,
      dd.encryptionKeyHexEnv,
      env,
    );
    if (keyHex === undefined)
      throw new ThrottleKitError(
        "config.capture.durable: encryption is mandatory — set `encryptionKeyHex` or `encryptionKeyHexEnv` (a 32-byte/64-hex AES-256 key)",
      );
    if (!/^[0-9a-fA-F]{64}$/.test(keyHex))
      throw new ThrottleKitError(
        "config.capture.durable.encryptionKeyHex: must be 64 hex characters (a 32-byte AES-256 key)",
      );
    resolved.durable = {
      dir: dd.dir,
      encryptionKeyHex: keyHex.toLowerCase(),
      segmentMaxEvents: positiveInt(
        "config.capture.durable.segmentMaxEvents",
        dd.segmentMaxEvents,
        10_000,
      ),
    };
  }

  // Tenant rule — programmatic override wins; else the declarative block; else counts-only.
  const tenantOf = options.tenantOf ?? resolveTenantRule(c.tenant);
  if (tenantOf !== undefined) resolved.tenantOf = tenantOf;

  // CLI operator auth (the CLI fails closed when absent — resolving config never requires it).
  const a = c.auth;
  if (a !== undefined) {
    if (typeof a !== "object" || a === null || Array.isArray(a))
      throw new ThrottleKitError("config.capture.auth: expected an object");
    const aa = a as Record<string, unknown>;
    const operatorSecret = readSecret(
      "config.capture.auth.operatorSecret",
      aa.operatorSecret,
      aa.operatorSecretEnv,
      env,
    );
    if (operatorSecret !== undefined) resolved.auth = { operatorSecret };
  }

  return resolved;
}

/** Throw with `message` (a helper so a `??` fallback can fail fast inline). */
function raise(message: string): never {
  throw new ThrottleKitError(message);
}
