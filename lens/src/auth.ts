/** Constant-time bearer-token check — no early-out timing side channel when the Lens is exposed. */

import { timingSafeEqual } from "node:crypto";

/**
 * True iff `header` is exactly `Bearer <token>`, compared in **constant time**. Lengths are checked first
 * (a length mismatch is not secret), then {@link timingSafeEqual} compares the equal-length bytes so the
 * time taken never depends on how many leading characters matched. Used by every Lens / aggregator request
 * gate, since `--lens-token` is the credential when the dashboard is exposed beyond loopback.
 */
export function bearerEqual(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const got = Buffer.from(header);
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}
