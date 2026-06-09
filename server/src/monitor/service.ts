/**
 * The **Monitor** gRPC service — the programmable, read-only observability door (`throttlekit.v1.Monitor`,
 * additive to the wire). It projects the in-process {@link LensHub} snapshot — the same operational state
 * the `--tui` dashboard renders — onto the proto, so any language can read it remotely. Strictly
 * non-mutating: it never computes, returns, or affects a rate-limit decision.
 *
 * AUTH (SC-15): the snapshot carries traffic keys (the limited identities = PII). So the door is
 * **loopback-only** unless a **monitor secret** is configured; with a secret set, every call (from any
 * peer) must present it in metadata (`x-monitor-secret`, or `authorization: Bearer <secret>`). Pair the
 * secret with TLS for confidentiality on an exposed port. The decision RPCs are unaffected.
 */

import { timingSafeEqual } from "node:crypto";

import * as grpc from "@grpc/grpc-js";

import type { LensHub } from "./hub.js";
import type {
  LensDenialRow,
  LensGuardSnapshot,
  LensPolicySnapshot,
  LensSnapshot,
} from "./types.js";

/** Auth configuration for the Monitor door. */
export interface MonitorAuth {
  /**
   * Shared secret required to use the Monitor from a **non-loopback** peer. When set, every call must
   * present it (`x-monitor-secret` metadata, or `authorization: Bearer <secret>`). When unset, the door is
   * loopback-only (a non-loopback call is rejected `UNAUTHENTICATED`).
   */
  secret?: string;
}

/** Read the monitor secret from call metadata: the `x-monitor-secret` header or an `authorization: Bearer`. */
function readSecret(md: grpc.Metadata): string | undefined {
  const direct = md.get("x-monitor-secret")[0];
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
 * Whether a grpc-js peer string is a loopback / local-socket address (the no-secret access boundary).
 * grpc-js reports the peer in several shapes across versions/transports: a bare `"127.0.0.1:PORT"`, a
 * scheme-prefixed `"ipv4:127.0.0.1:PORT"` / `"ipv6:[::1]:PORT"`, a bare bracketed `"[::1]:PORT"`, or a
 * `"unix:/path"` local socket — so the host is extracted defensively before the loopback test.
 */
export function peerIsLoopback(peer: string): boolean {
  if (peer.startsWith("unix:")) return true; // a local domain socket is local by definition
  let s = peer.replace(/^ipv[46]:/, ""); // strip an optional scheme prefix
  const bracket = /^\[([^\]]+)\]:\d+$/.exec(s); // "[::1]:PORT" → "::1"
  if (bracket?.[1] !== undefined) s = bracket[1];
  else {
    const hostPort = /^([^:]+):\d+$/.exec(s); // "127.0.0.1:PORT" / "host:PORT" → host (no inner colon)
    if (hostPort?.[1] !== undefined) s = hostPort[1];
    // else: a bare IPv6 with no port (e.g. "::1") — leave as-is.
  }
  return (
    s === "127.0.0.1" ||
    s === "::1" ||
    s === "::ffff:127.0.0.1" ||
    s === "localhost" ||
    s.startsWith("127.") // 127.0.0.0/8 is all loopback
  );
}

/**
 * Decide whether a Monitor call is authorized. Returns `null` to allow, or a gRPC error to reject. With a
 * secret configured, the secret is required (from any peer); without one, only loopback peers are allowed.
 */
export function authorizeMonitor(
  peer: string,
  md: grpc.Metadata,
  auth: MonitorAuth,
): grpc.ServerErrorResponse | null {
  if (auth.secret !== undefined) {
    const provided = readSecret(md);
    if (provided === undefined || !secretMatches(provided, auth.secret)) {
      return {
        name: "Unauthenticated",
        code: grpc.status.UNAUTHENTICATED,
        message:
          "monitor: missing or invalid secret (provide `x-monitor-secret` metadata or `authorization: Bearer <secret>`)",
      };
    }
    return null;
  }
  if (!peerIsLoopback(peer)) {
    return {
      name: "Unauthenticated",
      code: grpc.status.UNAUTHENTICATED,
      message:
        "monitor: loopback-only by default — set a monitor secret (--monitor-secret) to expose it beyond loopback",
    };
  }
  return null;
}

const ZERO_LATENCY = { avgMs: 0, p50Ms: 0, p99Ms: 0, maxMs: 0, n: 0 };

/** Project one tracked policy onto the stable typed summary (full per-axis analytics ride in `raw_json`). */
function policySummary(p: LensPolicySnapshot): Record<string, unknown> {
  // Both AnalyticsSnapshot (limiter) and AdmissionAnalyticsSnapshot (admitter) share these counters.
  const a = p.analytics;
  return {
    name: p.name,
    kind: p.kind,
    strategy: p.strategy ?? "",
    allowed: a.allowed,
    denied: a.denied,
    limit: p.limit ?? 0,
    latency: p.latency ?? ZERO_LATENCY, // n=0 ⇒ "no data yet" on the wire (proto3 default)
    topDenied: a.topDenied.map((h) => ({ key: h.key, count: h.count })),
    topRequested: a.topRequested.map((h) => ({ key: h.key, count: h.count })),
  };
}

/** Project one concurrency guard's health (distributed extras default to 0/false when absent). */
function guardSummary(g: LensGuardSnapshot): Record<string, unknown> {
  return {
    name: g.name,
    limit: g.limit,
    inflight: g.inflight,
    share: g.share ?? 0,
    lGlobal: g.lGlobal ?? 0,
    nodes: g.nodes ?? 0,
    fenced: g.fenced ?? false,
  };
}

/** Project one denial-feed row onto a `DenialEvent` (the "why, with numbers"). */
export function denialEvent(r: LensDenialRow): Record<string, unknown> {
  return {
    at: r.at,
    policy: r.policy,
    key: r.key,
    axis: r.lane ?? "", // the binding lane for an admitter denial; "" for a plain-limiter denial
    limit: r.decision.limit,
    remaining: r.decision.remaining,
    retryAfterMs: r.decision.retryAfterMs,
  };
}

/**
 * Project a {@link LensSnapshot} onto the proto `Snapshot`: typed envelope + per-policy / guard / denial
 * summaries (the stable contract), plus `raw_json` carrying the FULL snapshot (cost rooms, per-axis
 * analytics, replay, custom stats, fences) for depth + forward-compatibility.
 */
export function snapshotToProto(snap: LensSnapshot): Record<string, unknown> {
  return {
    meta: {
      generatedAt: snap.meta.generatedAt,
      windowMs: snap.meta.windowMs,
      mode: snap.meta.mode,
      lensVersion: snap.meta.lensVersion,
      nodeId: snap.meta.nodeId ?? "",
    },
    policies: snap.policies.map(policySummary),
    guards: snap.guards.map(guardSummary),
    recentDenials: snap.recentDenials.map(denialEvent),
    rawJson: JSON.stringify(snap),
  };
}

/**
 * Per-stream cap on `Watch` events per second. A denial storm beyond this is dropped (counted, not
 * buffered) — the feed is best-effort observability, never a backlog that grows server memory.
 */
const WATCH_RATE_CAP = 500;

/**
 * Build the `throttlekit.v1.Monitor` handler map over a live {@link LensHub}. `GetSnapshot` returns a
 * point-in-time projection; `Watch` streams a live denial feed. Every call is authorized first
 * (loopback-only, or secret-gated — see {@link authorizeMonitor}).
 */
export function monitorHandlers(
  hub: LensHub,
  auth: MonitorAuth = {},
): grpc.UntypedServiceImplementation {
  return {
    getSnapshot(call: any, callback: grpc.sendUnaryData<any>): void {
      const denied = authorizeMonitor(call.getPeer(), call.metadata, auth);
      if (denied !== null) {
        callback(denied);
        return;
      }
      // snapshot() is cheap + never throws (the hub isolates source throws); a fresh detached object.
      callback(null, { snapshot: snapshotToProto(hub.snapshot()) });
    },

    watch(call: any): void {
      const denied = authorizeMonitor(call.getPeer(), call.metadata, auth);
      if (denied !== null) {
        // A server-stream has no callback; end it with the gRPC error status.
        call.emit("error", {
          code: denied.code,
          details: denied.message,
          metadata: new grpc.Metadata(),
        });
        return;
      }
      const policyFilter: string =
        typeof call.request?.policy === "string" ? call.request.policy : "";
      let writable = true; // false once the send buffer fills, until 'drain'
      let windowStart = Date.now();
      let inWindow = 0;
      // The subscriber runs on the CONTROL PATH (inside the hub's tap), so it must be non-blocking and
      // never throw. call.write() buffers (non-blocking); a slow consumer just drops (backpressure + cap).
      const unsubscribe = hub.subscribe({
        onDenial: (row) => {
          if (policyFilter !== "" && row.policy !== policyFilter) return;
          const t = Date.now();
          if (t - windowStart >= 1000) {
            windowStart = t;
            inWindow = 0;
          }
          if (inWindow >= WATCH_RATE_CAP || !writable) return; // drop (rate cap or backpressure)
          inWindow++;
          writable = call.write({ denial: denialEvent(row) });
        },
      });
      call.on("drain", () => {
        writable = true;
      });
      const cleanup = (): void => unsubscribe();
      call.on("cancelled", cleanup);
      call.on("close", cleanup);
      call.on("error", cleanup);
    },
  };
}
