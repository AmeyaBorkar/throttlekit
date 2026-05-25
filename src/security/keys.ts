/**
 * PII-safe key hashing. Rate-limit keys are often raw identifiers (IPs, user ids, API keys);
 * hashing them with a server secret before they reach the store means the backing store (a shared
 * Redis, say) never holds the raw value — useful for GDPR posture and multi-tenant deployments.
 * See THROTTLEKIT.md §14.
 *
 * HMAC (keyed hash) rather than a bare digest so the mapping isn't a public rainbow-table lookup:
 * without the secret an attacker can't precompute `hash(ip)` for every IP.
 */

import { createHmac } from "node:crypto";

/**
 * Hash `raw` with `secret` using HMAC-SHA-256, returned as a 64-character lowercase hex string.
 * Deterministic: the same `(raw, secret)` always yields the same digest.
 */
export function hashKey(raw: string, secret: string): string {
  return createHmac("sha256", secret).update(raw).digest("hex");
}

/**
 * Build a keyer bound to one `secret`. Handy as a `key`-deriving step: `hmacKeyer(secret)(ip)`.
 * The secret is captured once so the hot path is a single `createHmac` call.
 */
export function hmacKeyer(secret: string): (raw: string) => string {
  return (raw: string): string => hashKey(raw, secret);
}
