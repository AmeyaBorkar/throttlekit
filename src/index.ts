/**
 * ThrottleKit — pluggable, framework-agnostic rate limiting for Node and the web.
 *
 * Three cleanly separated concerns: algorithms (pure functions of time), storage
 * (one atomic primitive), and adapters (thin glue to your framework).
 *
 * @packageDocumentation
 */

/** The current package version. Kept in sync with package.json. */
export const version = "0.8.0";

export type {
  Clock,
  Decision,
  Forecast,
  Strategy,
  StrategyOutcome,
  Store,
  ApplyOutcome,
  Transform,
  LuaProgram,
  LuaInvocation,
  ReadState,
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
export { quota } from "./algorithms/quota";
export type { QuotaCadence, QuotaOptions } from "./algorithms/quota";
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
export { eoqOptimum, leaseSizer, predictiveLeaseSizer, twoTier } from "./twotier";
export type {
  L1Options,
  LeaseOptions,
  LeaseSizer,
  LeaseSizerOptions,
  PredictiveLeaseSizer,
  PredictiveLeaseSizerOptions,
  TwoTierMode,
  TwoTierOptions,
} from "./twotier";
export { buildRateLimitHeaders } from "./http/headers";
export type { HeaderEmit, BuildRateLimitHeadersOptions } from "./http/headers";
export { createEnforcer } from "./adapters/enforce";
export type { Enforcer, EnforceOptions, EnforceOutcome, EnforceResult } from "./adapters/enforce";
export { clientIp } from "./security/ip";
export type { TrustProxyConfig, ClientIpInput } from "./security/ip";
export { hashKey, hmacKeyer } from "./security/keys";
export { all, any, multiRateLimit } from "./multi";
export type {
  Dimension,
  Dimensions,
  MultiStrategy,
  MultiLimiter,
  MultiRateLimitOptions,
} from "./multi";
export { sketchRateLimit, mergeableSketch, sketchSnapshotFromBytes } from "./sketch";
export type {
  SketchRateLimitOptions,
  SketchRateLimiter,
  MergeableSketch,
  MergeableSketchOptions,
  SketchSnapshot,
} from "./sketch";
export { withAnalytics } from "./analytics";
export type {
  AnalyticsOptions,
  AnalyticsLimiter,
  AnalyticsSnapshot,
  HeavyHitter,
} from "./analytics";
export { tapDecisions } from "./observability/tap";
export type { DecisionEvent, DecisionKind, DecisionTap } from "./observability/tap";
export {
  adaptiveThrottle,
  criticalFractile,
  distributedTokenBudget,
  fairShare,
  guaranteedShare,
  learnedReservation,
  predictiveReservation,
  tokenBudget,
  weightedFairShare,
  weightedMaxMin,
} from "./admission";
export type {
  AdaptiveThrottle,
  AdaptiveThrottleOptions,
  DistributedTokenBudgetMeter,
  DistributedTokenBudgetOptions,
  FairShareLimiter,
  FairShareOptions,
  LearnedReservation,
  LearnedReservationOptions,
  PredictiveReservation,
  PredictiveReservationOptions,
  TokenBudgetMeter,
  TokenBudgetOptions,
  WeightedFairShareLimiter,
  WeightedFairShareOptions,
} from "./admission";
