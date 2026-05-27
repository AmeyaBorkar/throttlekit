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
 * Workers KV ({@link KVStore}) is offered **only as an explicitly best-effort, approximate store**:
 * it is eventually consistent with no atomic compare-and-set, so it cannot honor the exact `Store`
 * contract and can over-admit under load. Use it for coarse edge protection where that's acceptable;
 * prefer {@link DurableObjectStore} or {@link D1Store} for correctness. See its doc comment.
 */
export { DurableObjectStore } from "./durable-object";
export type {
  DurableObjectStateLike,
  DurableObjectStorageLike,
  DurableObjectStoreOptions,
} from "./durable-object";
export { D1Store } from "./d1";
export type { D1Like, D1PreparedStatementLike, D1ResultLike, D1StoreOptions } from "./d1";
export { KVStore } from "./kv";
export type { KVNamespaceLike, KVStoreOptions } from "./kv";
