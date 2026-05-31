/**
 * `throttlekit-server` — the gRPC service door for ThrottleKit.
 *
 * Run the rate-limiting core as a network service so polyglot clients (Python, Go, …) make decisions
 * identical to an embedded Node library, without re-implementing any algorithm or touching the raw Lua
 * wire. Build a {@link RateLimiterService} from `.throttlekit.yaml` (or named limiters) and {@link serve}
 * it over `throttlekit.proto`.
 */

export {
  OperationNotSupportedError,
  PolicyNotFoundError,
  createRateLimiterService,
  createRateLimiterServiceFromConfig,
} from "./service.js";
export type {
  RateLimiterService,
  RateLimiterServiceConfigOptions,
  RateLimiterServiceOptions,
} from "./service.js";
export { buildLimitersFromConfig, buildServiceConfig } from "./config.js";
export type {
  MeterPolicy,
  ServerLimiterSpec,
  ServerLoadOptions,
  ServiceConfig,
  TokenBudgetConfig,
  TwoTierConfig,
} from "./config.js";
export { rateLimiterHandlers, resolveProtoPath, serve } from "./grpc.js";
export type { RunningServer, ServeOptions } from "./grpc.js";
export { createServerCredentials, createStore, isSecure } from "./runtime.js";
export type { ResolvedStore, StoreSpec, TlsSpec } from "./runtime.js";
