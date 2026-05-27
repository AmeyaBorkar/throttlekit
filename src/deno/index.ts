/**
 * Deno KV backend for ThrottleKit — an exact, lock-free store built on Deno KV's native atomic
 * transactions (versionstamp compare-and-set) and native TTL. See {@link DenoKvStore}.
 */
export { DenoKvStore } from "./store";
export type {
  AtomicOperationLike,
  DenoKvLike,
  DenoKvStoreOptions,
  KvCheckLike,
  KvCommitResultLike,
  KvEntryLike,
  KvKeyLike,
} from "./store";
