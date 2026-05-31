/**
 * gRPC binding for the service door. Loads `throttlekit.proto` dynamically (no codegen) and maps the
 * `throttlekit.v1.RateLimiter` service onto the transport-agnostic {@link RateLimiterService}. Every
 * handler is a *pure translation* — proto request → core call → proto response; the only logic added
 * here is error → gRPC status mapping. Decisions are computed entirely by the core.
 *
 * A rate-limit denial is a normal `Decision` (a successful RPC with `allowed: false`), NOT an RPC error —
 * so a client always inspects the decision. RPC errors are reserved for *operational* failures: an
 * unknown policy (`NOT_FOUND`), an unsupported op (`UNIMPLEMENTED`), or an internal fault (`INTERNAL`).
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { Decision, Forecast } from "throttlekit";

import {
  type AdmitResult,
  OperationNotSupportedError,
  PolicyNotFoundError,
  type RateLimiterService,
} from "./service.js";

/** Resolve the committed `throttlekit.proto`: packaged next to the build, or the in-repo `wire/` copy. */
export function resolveProtoPath(explicit?: string): string {
  if (explicit !== undefined) return explicit;
  const candidates = [
    new URL("../throttlekit.proto", import.meta.url), // packaged (files: ["throttlekit.proto"])
    new URL("../../wire/throttlekit.proto", import.meta.url), // in-repo, from src/ or server/dist/
  ].map((u) => fileURLToPath(u));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`throttlekit.proto not found; looked in:\n  ${candidates.join("\n  ")}`);
}

/** Load the `throttlekit.v1.RateLimiter` service definition from the proto. */
function loadServiceDefinition(protoPath: string): grpc.ServiceDefinition {
  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: false, // camelCase accessors line up with the core Decision field names
    longs: Number, // epoch-ms / counts fit comfortably in a JS safe integer
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(packageDefinition) as any;
  const rateLimiter = loaded?.throttlekit?.v1?.RateLimiter;
  if (rateLimiter === undefined)
    throw new Error(`proto ${protoPath} does not define throttlekit.v1.RateLimiter`);
  return rateLimiter.service as grpc.ServiceDefinition;
}

function decisionMessage(d: Decision) {
  return {
    allowed: d.allowed,
    limit: d.limit,
    remaining: d.remaining,
    resetAt: d.resetAt,
    retryAfterMs: d.retryAfterMs,
  };
}

function forecastMessage(f: Forecast) {
  return { spendableNow: f.spendableNow, nextReplenishAt: f.nextReplenishAt, fullAt: f.fullAt };
}

function admitMessage(r: AdmitResult) {
  return {
    decision: decisionMessage(r.decision),
    leaseId: r.leaseId,
    leaseExpiresAt: r.leaseExpiresAt,
    bindingAxis: r.bindingAxis,
    policyDenied: r.policyDenied,
  };
}

/** Map a thrown error to a gRPC status. Operational faults only — a denial is never an error. */
function toStatus(err: unknown): grpc.ServerErrorResponse {
  if (err instanceof PolicyNotFoundError)
    return { name: "PolicyNotFound", message: err.message, code: grpc.status.NOT_FOUND };
  if (err instanceof OperationNotSupportedError)
    return { name: "Unimplemented", message: err.message, code: grpc.status.UNIMPLEMENTED };
  const message = err instanceof Error ? err.message : String(err);
  return { name: "Internal", message, code: grpc.status.INTERNAL };
}

/** Cost of 0 (proto3 default for an unset int) means "1". Also used for the joint-LP `value` (0 ⇒ 1). */
function costOf(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** A non-negative count; 0 (proto3 default) stays 0 — used for the joint-LP `hold` term (0 = no hold). */
function nonNegOf(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Build the unary handler map binding the proto RPCs onto the service core. */
export function rateLimiterHandlers(
  service: RateLimiterService,
): grpc.UntypedServiceImplementation {
  return {
    check(call: any, callback: grpc.sendUnaryData<any>): void {
      const { policy, key, cost } = call.request;
      service
        .check(policy, key, costOf(cost))
        .then((d) => callback(null, { decision: decisionMessage(d) }))
        .catch((err) => callback(toStatus(err)));
    },
    checkMany(call: any, callback: grpc.sendUnaryData<any>): void {
      const { policy, keys, cost } = call.request;
      service
        .checkMany(policy, keys ?? [], costOf(cost))
        .then((ds) => callback(null, { decisions: ds.map(decisionMessage) }))
        .catch((err) => callback(toStatus(err)));
    },
    peek(call: any, callback: grpc.sendUnaryData<any>): void {
      const { policy, key } = call.request;
      service
        .peek(policy, key)
        .then((d) => callback(null, { decision: decisionMessage(d) }))
        .catch((err) => callback(toStatus(err)));
    },
    forecast(call: any, callback: grpc.sendUnaryData<any>): void {
      const { policy, key, cost } = call.request;
      service
        .forecast(policy, key, costOf(cost))
        .then((f) => callback(null, { forecast: forecastMessage(f) }))
        .catch((err) => callback(toStatus(err)));
    },
    debit(call: any, callback: grpc.sendUnaryData<any>): void {
      const { policy, key, tokens } = call.request;
      service
        .debit(policy, key, costOf(tokens)) // 0 ⇒ 1, same proto3-default convention as `cost`
        .then((d) => callback(null, { decision: decisionMessage(d) }))
        .catch((err) => callback(toStatus(err)));
    },
    admit(call: any, callback: grpc.sendUnaryData<any>): void {
      const { policy, key, cost, hold, value } = call.request;
      service
        .admit(policy, key, { cost: costOf(cost), hold: nonNegOf(hold), value: costOf(value) })
        .then((r) => callback(null, admitMessage(r)))
        .catch((err) => callback(toStatus(err)));
    },
    release(call: any, callback: grpc.sendUnaryData<any>): void {
      const { leaseId, dropped } = call.request;
      try {
        service.release(leaseId, Boolean(dropped)); // synchronous + idempotent
        callback(null, {});
      } catch (err) {
        callback(toStatus(err));
      }
    },
    heartbeat(call: any, callback: grpc.sendUnaryData<any>): void {
      const leaseIds: string[] = call.request.leaseIds ?? [];
      try {
        const r = service.heartbeat(leaseIds);
        callback(null, {
          liveIds: r.liveIds,
          reclaimedIds: r.reclaimedIds,
          nextDeadline: r.nextDeadline,
        });
      } catch (err) {
        callback(toStatus(err));
      }
    },
  };
}

/** Options for {@link serve}. */
export interface ServeOptions {
  /** The service core to expose. */
  service: RateLimiterService;
  /** Bind host. Default `"0.0.0.0"`. */
  host?: string;
  /** Bind port. Default `50051`. Pass `0` for an OS-assigned ephemeral port (tests read it back). */
  port?: number;
  /** Override the proto location (defaults to the packaged/in-repo `throttlekit.proto`). */
  protoPath?: string;
  /** Server credentials. Default **insecure** — set mTLS/TLS creds for anything exposed. */
  credentials?: grpc.ServerCredentials;
  /**
   * How often to run the admission-lease reclaim sweep (ms). Default 1000 (the core heartbeat cadence);
   * the interval is `unref`'d so it never keeps the process alive, and is cleared on {@link RunningServer.close}.
   */
  sweepIntervalMs?: number;
}

/** A bound, serving gRPC server. */
export interface RunningServer {
  /** The actual bound port (meaningful when `port: 0` was requested). */
  readonly port: number;
  /** The underlying grpc-js server, for advanced use. */
  readonly server: grpc.Server;
  /** Gracefully drain in-flight calls and stop. */
  close(): Promise<void>;
}

/**
 * Start a gRPC server exposing `service` over `throttlekit.proto`. Resolves once bound.
 *
 * @example
 * ```ts
 * const svc = createRateLimiterServiceFromConfig(readFileSync(".throttlekit.yaml", "utf8"));
 * const running = await serve({ service: svc, port: 50051 });
 * // … later
 * await running.close();
 * ```
 */
export async function serve(options: ServeOptions): Promise<RunningServer> {
  const host = options.host ?? "0.0.0.0";
  const requestedPort = options.port ?? 50051;
  const protoPath = resolveProtoPath(options.protoPath);
  const serviceDef = loadServiceDefinition(protoPath);

  const server = new grpc.Server();
  server.addService(serviceDef, rateLimiterHandlers(options.service));

  const credentials = options.credentials ?? grpc.ServerCredentials.createInsecure();
  const boundPort = await new Promise<number>((resolvePort, reject) => {
    server.bindAsync(`${host}:${requestedPort}`, credentials, (err, port) => {
      if (err) reject(err);
      else resolvePort(port);
    });
  });
  // grpc-js >= 1.10 begins serving on a successful bindAsync; the old explicit start() is a no-op.

  // Reclaim admission leases whose client stopped heart-beating (a no-op when no admitters/leases). The
  // interval is unref'd so it never holds the event loop open on its own; it's cleared on close.
  const sweeper = setInterval(() => options.service.sweep(), options.sweepIntervalMs ?? 1000);
  sweeper.unref();

  return {
    port: boundPort,
    server,
    close: () =>
      new Promise<void>((resolveClose) => {
        clearInterval(sweeper);
        server.tryShutdown(() => resolveClose());
      }),
  };
}
