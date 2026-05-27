/**
 * Cloudflare backends for ThrottleKit. Two exact stores, matched to the two atomic primitives
 * Cloudflare actually offers:
 *
 *  - {@link DurableObjectStore} — a single-threaded actor with transactional storage. The atomic
 *    read-modify-write needs no retry loop; ideal when you already run a Durable Object, or want one
 *    serialization point per identity.
 *  - {@link D1Store} — edge SQLite. No per-key lock, so it uses optimistic concurrency (a version
 *    compare-and-set); ideal for a plain Worker that has a D1 binding and no Durable Object.
 *
 * Workers KV is intentionally *not* offered as an exact store: it is eventually consistent with no
 * atomic compare-and-set, so it cannot honor the atomic {@link Store} contract and would silently
 * over-admit. KV suits only approximate/best-effort scenarios, which ThrottleKit does not present as
 * a `Store`.
 */
export { DurableObjectStore } from "./durable-object";
export type {
  DurableObjectStateLike,
  DurableObjectStorageLike,
  DurableObjectStoreOptions,
} from "./durable-object";
export { D1Store } from "./d1";
export type { D1Like, D1PreparedStatementLike, D1ResultLike, D1StoreOptions } from "./d1";
