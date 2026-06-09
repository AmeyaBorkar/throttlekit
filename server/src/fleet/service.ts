/**
 * The **Fleet** gRPC service — the Tier-2 client-held lease door (`throttlekit.v1.Fleet`, additive to the
 * wire). `Reserve` hands a high-throughput client a chunk of a policy's global per-window budget to spend
 * locally (the `LeaseSpender` contract), so it round-trips only to refresh instead of once per request. The
 * server computes the grant SIZE via the policy's coordinator (the one oracle); the client only spends it.
 *
 * AUTH (SC-15): handing out budget is a poisoning vector, so the door mirrors the Monitor posture — it is
 * **loopback-only** unless a **fleet secret** is configured; with a secret set, every call (from any peer)
 * must present it (`x-fleet-secret` metadata, or `authorization: Bearer <secret>`). Pair the secret with TLS
 * on an exposed port. The decision RPCs are unaffected.
 */

import { timingSafeEqual } from "node:crypto";

import * as grpc from "@grpc/grpc-js";

import { peerIsLoopback } from "../monitor/service.js";
import type { FleetLeaseSource } from "./source.js";

/** Auth configuration for the Fleet door (same shape + semantics as the Monitor door's). */
export interface FleetAuth {
  /**
   * Shared secret required to use the Fleet door from a **non-loopback** peer. When set, every call must
   * present it (`x-fleet-secret` metadata, or `authorization: Bearer <secret>`). When unset, the door is
   * loopback-only (a non-loopback call is rejected `UNAUTHENTICATED`).
   */
  secret?: string;
}

/** Read the fleet secret from call metadata: the `x-fleet-secret` header or an `authorization: Bearer`. */
function readSecret(md: grpc.Metadata): string | undefined {
  const direct = md.get("x-fleet-secret")[0];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const authz = md.get("authorization")[0];
  if (typeof authz === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(authz);
    if (m?.[1] !== undefined && m[1].length > 0) return m[1];
  }
  return undefined;
}

/** Constant-time string compare (avoids leaking the secret via response timing). Length mismatch ⇒ false. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Decide whether a Fleet call is authorized. Returns `null` to allow, or a gRPC error to reject. With a
 * secret configured, the secret is required (from any peer); without one, only loopback peers are allowed.
 */
export function authorizeFleet(
  peer: string,
  md: grpc.Metadata,
  auth: FleetAuth,
): grpc.ServerErrorResponse | null {
  if (auth.secret !== undefined) {
    const provided = readSecret(md);
    if (provided === undefined || !secretMatches(provided, auth.secret)) {
      return {
        name: "Unauthenticated",
        code: grpc.status.UNAUTHENTICATED,
        message:
          "fleet: missing or invalid secret (provide `x-fleet-secret` metadata or `authorization: Bearer <secret>`)",
      };
    }
    return null;
  }
  if (!peerIsLoopback(peer)) {
    return {
      name: "Unauthenticated",
      code: grpc.status.UNAUTHENTICATED,
      message:
        "fleet: loopback-only by default — set a fleet secret (--fleet-secret) to expose it beyond loopback",
    };
  }
  return null;
}

/** A requested lease size; 0 (proto3 default for an unset int) means 1, like the decision RPCs' `cost`. */
function wantsOf(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

/**
 * Build the `throttlekit.v1.Fleet` handler map over the per-policy lease {@link FleetLeaseSource}s. `Reserve`
 * is authorized first (loopback-only, or secret-gated — see {@link authorizeFleet}), then resolves the named
 * policy and leases. An unknown policy is `NOT_FOUND`; an unsupported axis is `UNIMPLEMENTED`; a 0-capacity
 * grant is a normal response the client reads as a denial (never an RPC error).
 */
export function fleetHandlers(
  sources: Record<string, FleetLeaseSource>,
  auth: FleetAuth = {},
): grpc.UntypedServiceImplementation {
  return {
    reserve(call: any, callback: grpc.sendUnaryData<any>): void {
      const denied = authorizeFleet(call.getPeer(), call.metadata, auth);
      if (denied !== null) {
        callback(denied);
        return;
      }
      const req = call.request ?? {};
      const policy = typeof req.policy === "string" ? req.policy : "";
      const source = sources[policy];
      if (source === undefined) {
        callback({
          name: "PolicyNotFound",
          code: grpc.status.NOT_FOUND,
          message: `fleet: no leasable policy ${JSON.stringify(policy)} (Reserve serves federated: policies)`,
        });
        return;
      }
      // The axis enum arrives as its name (proto-loader `enums: String`); unset ⇒ "AXIS_UNSPECIFIED" ⇒ rate.
      const axis = typeof req.axis === "string" ? req.axis : "AXIS_UNSPECIFIED";
      if (axis === "AXIS_CONCURRENCY") {
        callback({
          name: "Unimplemented",
          code: grpc.status.UNIMPLEMENTED,
          message:
            "fleet: the concurrency axis is not leasable in v1 (lease a windowed rate / token budget instead)",
        });
        return;
      }
      // `caller.domain` selects WHICH budget within the policy to lease; empty ⇒ the policy's whole budget.
      const domain = req.caller?.domain;
      const key = typeof domain === "string" && domain.length > 0 ? domain : policy;
      source
        .lease(key, wantsOf(req.wants))
        .then((o) =>
          callback(null, {
            lease: {
              capacity: o.capacity,
              expiryMs: o.expiresAt,
              refreshIntervalMs: o.refreshIntervalMs,
              safeCapacity: o.capacity, // v1: the full grant is safe to spend (the client discards at expiry)
              retryAfterMs: o.retryAfterMs,
              limit: o.limit,
            },
          }),
        )
        .catch((err) =>
          callback({
            name: "Internal",
            code: grpc.status.INTERNAL,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
    },
  };
}
