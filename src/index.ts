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
export { slidingWindow } from "./algorithms/sliding-window";
export type { SlidingWindowOptions } from "./algorithms/sliding-window";
export { slidingWindowLog } from "./algorithms/sliding-window-log";
export type { SlidingWindowLogOptions } from "./algorithms/sliding-window-log";
export { leakyBucket, QueueFullError } from "./algorithms/leaky-bucket";
export type { LeakyBucketOptions, Reservation, Shaper } from "./algorithms/leaky-bucket";
export { adaptiveConcurrency } from "./concurrency/adaptive";
export type {
  AdaptiveConcurrencyOptions,
  ConcurrencyGuard,
  Lease,
} from "./concurrency/adaptive";
