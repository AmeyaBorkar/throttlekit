/**
 * The standard **`grpc.health.v1.Health`** service, served on the same gRPC port as the decision RPCs so
 * orchestrators can probe liveness/readiness with off-the-shelf tooling (`grpc_health_probe`, Kubernetes
 * gRPC probes, service meshes) — no ThrottleKit-specific client needed.
 *
 * It is **available by default and universal**: the health surface reports only `SERVING` / `NOT_SERVING`
 * (never traffic data), so — unlike the Monitor door — it needs no auth and rides every serve path. The
 * proto is vendored under `server/proto/health.proto` (a third-party standard, kept OUTSIDE the buf-gated
 * `wire/`), and loaded in its own proto-loader pass; ThrottleKit adds nothing to the contract.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

/** Resolve the vendored `health.proto`: packaged under `proto/` (files: ["proto"]) or the in-repo copy. */
export function resolveHealthProtoPath(explicit?: string): string {
  if (explicit !== undefined) return explicit;
  // `server/proto/health.proto` is one level under the package root, so the same relative path resolves
  // from both `server/src/` (tests) and `server/dist/` (the build / the packaged tarball).
  const candidate = fileURLToPath(new URL("../proto/health.proto", import.meta.url));
  if (existsSync(candidate)) return candidate;
  throw new Error(`health.proto not found; looked in:\n  ${candidate}`);
}

/** Load the `grpc.health.v1.Health` service definition for {@link grpc.Server.addService}. */
export function loadHealthDefinition(protoPath?: string): grpc.ServiceDefinition {
  const packageDefinition = protoLoader.loadSync(resolveHealthProtoPath(protoPath), {
    keepCase: false,
    longs: Number,
    enums: String, // the serving status rides as its name ("SERVING"), matching the rest of the binding
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(packageDefinition) as any;
  const health = loaded?.grpc?.health?.v1?.Health;
  if (health === undefined)
    throw new Error(`proto ${protoPath ?? "(vendored)"} does not define grpc.health.v1.Health`);
  return health.service as grpc.ServiceDefinition;
}

/**
 * The `Health` handlers over a fixed set of served service full-names (e.g. `"throttlekit.v1.RateLimiter"`).
 * The server is healthy for its whole lifetime — it stops serving by shutting the port, not by reporting
 * `NOT_SERVING` — so every known service (and the empty-string "overall" probe) reports `SERVING`.
 *
 * - **Check**: `SERVING` for the overall server (`""`) or a known service; gRPC `NOT_FOUND` for an unknown
 *   one (per the health spec).
 * - **Watch**: emits the current status once (`SERVING`, or `SERVICE_UNKNOWN` for an unknown service) and
 *   holds the stream open. Status never changes while we serve, so there is no second message; the stream
 *   ends when the client cancels or the server shuts down.
 */
export function healthHandlers(
  serviceNames: ReadonlySet<string>,
): grpc.UntypedServiceImplementation {
  const isServing = (service: string): boolean => service === "" || serviceNames.has(service);
  return {
    check(call: any, callback: grpc.sendUnaryData<any>): void {
      const service: string = call.request?.service ?? "";
      if (isServing(service)) {
        callback(null, { status: "SERVING" });
      } else {
        callback({
          code: grpc.status.NOT_FOUND,
          details: `unknown service ${JSON.stringify(service)}`,
        });
      }
    },
    watch(call: any): void {
      const service: string = call.request?.service ?? "";
      call.write({ status: isServing(service) ? "SERVING" : "SERVICE_UNKNOWN" });
      // Status is stable for the server's lifetime, so we send nothing further and keep the stream open
      // (the health-watch contract). Swallow the post-cancel error grpc-js emits when the client hangs up.
      call.on("error", () => {});
      call.on("cancelled", () => {});
    },
  };
}
