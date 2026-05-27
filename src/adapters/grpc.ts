/**
 * gRPC server adapter (grpc-js). Wraps a unary method handler with a rate-limit gate built on the
 * transport-agnostic {@link createEnforcer}: on allow it forwards to the handler; on deny it fails
 * the RPC with gRPC status `RESOURCE_EXHAUSTED` (8) and a `retry after` detail; a fail-closed store
 * outage fails with `UNAVAILABLE` (14). The call/callback shapes are modeled structurally, so a real
 * `@grpc/grpc-js` `ServerUnaryCall`/`sendUnaryData` satisfies them with no dependency on grpc-js.
 */

import { type EnforceOptions, createEnforcer } from "./enforce";

/** gRPC status code for a throttled call (maps to HTTP 429 at a gateway). */
export const GRPC_RESOURCE_EXHAUSTED = 8;
/** gRPC status code used when the limiter store is unreachable under a fail-closed policy. */
export const GRPC_UNAVAILABLE = 14;

/** The slice of a grpc-js `ServerUnaryCall` the adapter reads: the peer and (optionally) metadata. */
export interface GrpcServerCallLike {
  /** The peer address string, e.g. `"ipv4:203.0.113.7:54321"`. The default limit key. */
  getPeer(): string;
}

/** A grpc-js error completion: a status `code` and human-readable `details`. */
export interface GrpcServiceError {
  code: number;
  details: string;
}

/** grpc-js `sendUnaryData<Res>`: complete the call with an error, or with a value. */
export type GrpcSendUnaryData<Res> = (error: GrpcServiceError | null, value?: Res | null) => void;

/** A grpc-js unary handler `(call, callback) => void`. */
export type GrpcUnaryHandler<Call, Res> = (call: Call, callback: GrpcSendUnaryData<Res>) => void;

/** Options for {@link grpcRateLimit}. */
export type GrpcRateLimitOptions<Call extends GrpcServerCallLike = GrpcServerCallLike> =
  EnforceOptions & {
    /** Cost of a call in limiter units. A function computes it per call. Default 1. */
    cost?: number | ((call: Call) => number);
    /** Derive the limit key from a call. Default: the peer address (`call.getPeer()`). */
    key?: (call: Call) => string;
  };

/** A gRPC rate-limit gate: wrap method handlers with {@link GrpcRateLimiter.unary}. */
export interface GrpcRateLimiter<Call extends GrpcServerCallLike> {
  /** Wrap a unary handler so it is only invoked when the call is under the limit. */
  unary<Res>(handler: GrpcUnaryHandler<Call, Res>): GrpcUnaryHandler<Call, Res>;
}

/**
 * Build a gRPC rate-limit gate. Wrap each unary method handler with `.unary(...)`; the wrapper keys
 * the limit on the peer (override with `key`, e.g. read an API token from `call.metadata`), enforces
 * it, and either forwards to the handler or completes the call with `RESOURCE_EXHAUSTED`.
 *
 * @example
 * ```ts
 * import { grpcRateLimit } from "throttlekit/grpc";
 * import { gcra } from "throttlekit";
 *
 * const gate = grpcRateLimit({ strategy: gcra({ limit: 100, periodMs: 60_000 }) });
 * server.addService(GreeterService, { sayHello: gate.unary(sayHelloImpl) });
 * ```
 */
export function grpcRateLimit<Call extends GrpcServerCallLike = GrpcServerCallLike>(
  options: GrpcRateLimitOptions<Call>,
): GrpcRateLimiter<Call> {
  const enforcer = createEnforcer(options);
  const keyFn = options.key ?? ((call: Call) => call.getPeer());
  const costOpt = options.cost ?? 1;

  return {
    unary<Res>(handler: GrpcUnaryHandler<Call, Res>): GrpcUnaryHandler<Call, Res> {
      return (call: Call, callback: GrpcSendUnaryData<Res>): void => {
        const key = keyFn(call);
        const cost = typeof costOpt === "function" ? costOpt(call) : costOpt;
        void (async (): Promise<void> => {
          const r = await enforcer.enforce(key, cost);
          if (r.allowed) {
            handler(call, callback);
            return;
          }
          if (r.outcome === "limited") {
            callback({
              code: GRPC_RESOURCE_EXHAUSTED,
              details: `rate limit exceeded; retry after ${r.retryAfterMs}ms`,
            });
            return;
          }
          // outcome === "error" under a fail-closed policy (fail-open would have admitted).
          callback({ code: GRPC_UNAVAILABLE, details: "rate limiter unavailable" });
        })();
      };
    },
  };
}
