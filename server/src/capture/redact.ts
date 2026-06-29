/**
 * Redaction at capture — a raw key (PII) is hashed **before** it ever enters a ring or segment, reusing
 * the shipped `hashKey` (HMAC-SHA-256) so there is no parallel crypto. The full digest is used, never a
 * truncated handle: a truncated keyRef raises collision probability, and a collision merges two keys'
 * decision streams into one — a *wrong* forensic record, not merely a lossy one.
 */

import { createHash, randomBytes } from "node:crypto";
import { ThrottleKitError, hashKey } from "throttlekit";
import type { LimiterSpec } from "throttlekit/config";
import type { RedactionConfig, RedactionMode } from "./types.js";

/** The constant a `"drop"` redactor maps every key to — per-key identity is erased by design. */
export const DROP_PLACEHOLDER = "__redacted__";

/**
 * Cap on the collision-guard's memory. The guard is **bounded** so a distinct-key flood (e.g. per-IP
 * keys) can never grow it without limit, and it stores a PII-free **witness** digest, never the raw key,
 * so no raw key is ever retained in heap. Because the ref is a full HMAC-SHA-256 digest, a real collision
 * is astronomically unlikely, so beyond this cap the guard is best-effort (it stops tracking new refs).
 */
const COLLISION_GUARD_MAX = 50_000;

/** A bound redactor: one mode + (for `per-trace-salt`) one captured salt. */
export interface Redactor {
  readonly mode: RedactionMode;
  /** Redact a raw key. Throws `keyref-collision` if two distinct keys map to one ref (except `drop`). */
  redact(raw: string): string;
  /** Redact the PII-bearing fields of a spec (the `prefix`, often a tenant id). */
  redactSpec(spec: LimiterSpec): LimiterSpec;
}

/**
 * Build a redactor (one per recorder = one per server run).
 *
 * - `hmac` — `hashKey(raw, secret)`: stable across runs (cross-incident grouping; an operator can locate a
 *   tenant by hashing its id with the configured secret).
 * - `per-trace-salt` — `hashKey(raw, salt)` with a fresh 16-byte random salt held for the redactor's
 *   lifetime (**one server run**): consistent for the life of the process, uncorrelatable across server
 *   *runs* (a restart re-salts). It is **not** per-segment — one recorder emits many segments under one
 *   salt — so do not rely on cross-segment unlinkability within a single run.
 * - `drop` — every key becomes {@link DROP_PLACEHOLDER} (identity erased).
 *
 * The collision guard (active for `hmac`/`per-trace-salt`, off for `drop` where merging is intended)
 * refuses a redaction that maps two distinct keys to one ref. It is **bounded** and stores a PII-free
 * witness, never the raw key (see {@link COLLISION_GUARD_MAX}).
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

  // Two distinct keys → one ref would merge their decision streams. Refuse it loudly — except in `drop`
  // mode (merging is intended). BOUNDED + PII-free: store a witness digest (never the raw key) and cap the
  // map, so a distinct-key flood can neither grow it without limit nor retain raw PII in heap.
  const seen = config.mode === "drop" ? undefined : new Map<string, string>();
  const redact = (raw: string): string => {
    const ref = derive(raw);
    if (seen !== undefined) {
      const prev = seen.get(ref);
      if (prev !== undefined || seen.size < COLLISION_GUARD_MAX) {
        // A PII-free second digest, never the raw key. It is a plain (unkeyed) SHA-256: the witness is
        // only ever compared against another witness computed the same way, it never persists and never
        // leaves this in-process `seen` Map, so it needs no keyed-hash secrecy — and an unkeyed digest is
        // ~half the work of the HMAC-SHA-256 the redaction REF uses. (The REF — `derive(raw)` — that
        // reaches disk is unchanged; only this internal collision witness changed.)
        const witness = createHash("sha256").update(raw).digest("hex");
        if (prev !== undefined) {
          if (prev !== witness)
            throw new ThrottleKitError(
              "capture.redaction: keyref collision — two distinct keys mapped to one redaction ref",
            );
        } else {
          seen.set(ref, witness);
        }
      }
      // Past the cap with an unseen ref: best-effort skip (a full HMAC-SHA-256 collision is negligible).
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
