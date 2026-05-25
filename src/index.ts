/**
 * ThrottleKit — pluggable, framework-agnostic rate limiting for Node and the web.
 *
 * Three cleanly separated concerns: algorithms (pure functions of time), storage
 * (one atomic primitive), and adapters (thin glue to your framework).
 *
 * @packageDocumentation
 */

/** The current package version. Kept in sync with package.json. */
export const version = "0.1.0";

export type {
  Clock,
  Decision,
  Strategy,
  StrategyOutcome,
  Store,
  ApplyOutcome,
  Transform,
  LuaProgram,
  LuaInvocation,
  FailMode,
  Limiter,
} from "./core/types";
export { systemClock, ManualClock } from "./core/clock";
export { ThrottleKitError, StoreUnavailableError, RateLimitExceededError } from "./core/errors";
export { rateLimit } from "./core/limiter";
export type { RateLimitOptions } from "./core/limiter";
export { MemoryStore } from "./stores/memory";
export type { MemoryStoreOptions } from "./stores/memory";
export { gcra } from "./algorithms/gcra";
export type { GcraOptions } from "./algorithms/gcra";
export { tokenBucket } from "./algorithms/token-bucket";
export type { TokenBucketOptions } from "./algorithms/token-bucket";
export { fixedWindow } from "./algorithms/fixed-window";
export type { FixedWindowOptions } from "./algorithms/fixed-window";
