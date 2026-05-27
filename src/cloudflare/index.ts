/**
 * Cloudflare backends for ThrottleKit.
 *
 * Currently the **Durable Objects** store — the correct atomic primitive for rate limiting on
 * Cloudflare. Workers KV is intentionally *not* offered as an exact store: it is eventually
 * consistent with no atomic compare-and-set, so it cannot honor the atomic {@link Store} contract and
 * would silently over-admit. Use a Durable Object (exact) for limiting; KV is suitable only for
 * approximate/best-effort scenarios, which ThrottleKit does not present as a `Store`.
 */
export { DurableObjectStore } from "./durable-object";
export type {
  DurableObjectStateLike,
  DurableObjectStorageLike,
  DurableObjectStoreOptions,
} from "./durable-object";
