/**
 * ThrottleKit — pluggable, framework-agnostic rate limiting for Node and the web.
 *
 * Three cleanly separated concerns: algorithms (pure functions of time), storage
 * (one atomic primitive), and adapters (thin glue to your framework).
 *
 * @packageDocumentation
 */

/** The current package version. Kept in sync with package.json. */
export const version = "0.11.1";

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
export {
  NotImplementedError,
  RateLimitExceededError,
  StoreUnavailableError,
  ThrottleKitError,
} from "./core/errors";
export { ALLOW_FULL, combineDecisions } from "./core/combine";
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
export { distributedAdaptiveConcurrency } from "./concurrency/distributed";
export type {
  DistributedAdaptiveConcurrencyOptions,
  DistributedConcurrencyGuard,
  HeartbeatScheduler,
} from "./concurrency/distributed";
export type {
  ConcurrencyCoordinator,
  ConcurrencyGrant,
  ConcurrencyReport,
} from "./concurrency/coordinator";
export { TestConcurrencyCoordinator } from "./concurrency/test-concurrency-coordinator";
export { RedisConcurrencyCoordinator } from "./concurrency/redis-concurrency-coordinator";
export type { RedisConcurrencyCoordinatorOptions } from "./concurrency/redis-concurrency-coordinator";
export {
  eoqOptimum,
  leaseSizer,
  predictiveLeaseSizer,
  twoTier,
  weightedFairEscrow,
} from "./twotier";
export type {
  L1Options,
  LeaseOptions,
  LeaseSizer,
  LeaseSizerOptions,
  PredictiveLeaseSizer,
  PredictiveLeaseSizerOptions,
  TwoTierMode,
  TwoTierOptions,
  WeightedFairEscrowLimiter,
  WeightedFairEscrowOptions,
  WeightedFairEscrowStats,
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
  FUSED_GCRA_TOKEN_BUCKET_LUA,
  FusedDispatcher,
  guaranteedShare,
  leaseAsAdmission,
  learnedReservation,
  predictiveReservation,
  solveFluidLp,
  tokenBudget,
  unifiedAdmission,
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
  FluidLpInput,
  FluidLpSolution,
  FusedAdmissionOptions,
  FusedAdmissionResult,
  FusedCostConfig,
  FusedRateConfig,
  LeaseAdmission,
  LeaseAdmitter,
  LeaseAsAdmissionOptions,
  LearnedReservation,
  LearnedReservationOptions,
  PredictiveReservation,
  PredictiveReservationOptions,
  TokenBudgetMeter,
  TokenBudgetOptions,
  UnifiedAdmission,
  UnifiedAdmissionOptions,
  UnifiedAdmitOptions,
  UnifiedAdmitter,
  UnifiedAxis,
  WeightedFairShareLimiter,
  WeightedFairShareOptions,
  WorkloadType,
} from "./admission";
