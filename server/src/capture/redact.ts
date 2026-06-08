/**
 * Redaction at capture — a raw key (PII) is hashed **before** it ever enters a ring or segment, reusing
 * the shipped `hashKey` (HMAC-SHA-256) so there is no parallel crypto. The full digest is used, never a
 * truncated handle: a truncated keyRef raises collision probability, and a collision merges two keys'
 * decision streams into one — a *wrong* forensic record, not merely a lossy one.
 */

import { randomBytes } from "node:crypto";
import { ThrottleKitError, hashKey } from "throttlekit";
import type { LimiterSpec } from "throttlekit/config";
import type { RedactionConfig, RedactionMode } from "./types.js";

/** The constant a `"drop"` redactor maps every key to — per-key identity is erased by design. */
export const DROP_PLACEHOLDER = "__redacted__";

/** A bound redactor: one mode + (for `per-trace-salt`) one captured salt. */
export interface Redactor {
  readonly mode: RedactionMode;
  /** Redact a raw key. Throws `keyref-collision` if two distinct keys map to one ref (except `drop`). */
  redact(raw: string): string;
  /** Redact the PII-bearing fields of a spec (the `prefix`, often a tenant id). */
  redactSpec(spec: LimiterSpec): LimiterSpec;
}

/**
 * Build a redactor for one segment.
 *
 * - `hmac` — `hashKey(raw, secret)`: stable across segments (cross-incident grouping).
 * - `per-trace-salt` — `hashKey(raw, salt)` with a fresh 16-byte random salt held for this redactor's
 *   lifetime: consistent within the segment, uncorrelatable across segments.
 * - `drop` — every key becomes {@link DROP_PLACEHOLDER}.
 *
 * The collision guard (active for `hmac`/`per-trace-salt`, off for `drop` where merging is intended)
 * refuses a redaction that maps two distinct raw keys to one ref — a silent state-merge hazard.
 */
export function createRedactor(config: RedactionConfig): Redactor {
  let derive: (raw: string) => string;
  if (config.mode === "hmac") {
    const secret = config.secret;
    if (secret === undefined || secret === "")
      throw new ThrottleKitError("capture.redaction: hmac mode requires a non-empty secret");
    derive = (raw) => hashKey(raw, secret);
  } else if (config.mode === "per-trace-salt") {
    const salt = randomBytes(16).toString("hex");
    derive = (raw) => hashKey(raw, salt);
  } else {
    derive = () => DROP_PLACEHOLDER;
  }

  // Two distinct raw keys → one keyRef would merge their decision streams. Refuse it loudly — except in
  // `drop` mode, where collapsing every key to one placeholder is the intended (identity-erasing) behavior.
  const originalOf = config.mode === "drop" ? undefined : new Map<string, string>();
  const redact = (raw: string): string => {
    const ref = derive(raw);
    if (originalOf !== undefined) {
      const prev = originalOf.get(ref);
      if (prev !== undefined && prev !== raw)
        throw new ThrottleKitError(
          `capture.redaction: keyref collision — ${JSON.stringify(prev)} and ${JSON.stringify(raw)} map to one ref`,
        );
      if (prev === undefined) originalOf.set(ref, raw);
    }
    return ref;
  };

  const redactSpec = (spec: LimiterSpec): LimiterSpec => {
    // Whole-segment whitelist: `prefix` is the one free-text, often-tenant-identifying spec field; every
    // other field is a strategy enum or a number, not PII. Redact the prefix with the same redactor.
    if (spec.prefix === undefined) return spec;
    return { ...spec, prefix: redact(spec.prefix) };
  };

  return { mode: config.mode, redact, redactSpec };
}
