/**
 * Fleet-global aggregation — the honest fleet view an in-process tap alone cannot deliver.
 *
 * Each node {@link pushSnapshots} its {@link LensSnapshot} to a {@link serveLensAggregator} on a timer; the
 * aggregator merges them: **additive** counters (allow/deny, per-lane denials) summed across nodes, top-K
 * heavy hitters merged by summing per-key counts and re-topping (an approximate merge of approximate
 * top-Ks — never drops a true fleet heavy hitter), per-node guards listed node-qualified, and the recent
 * feeds interleaved by time. The merged snapshot has the SAME shape as a per-process one (`mode: "fleet"` +
 * `fleetNodes`), so the existing UI renders it unchanged.
 *
 * Best-effort + eventually-consistent: it reflects the last snapshot each live node pushed (stale nodes
 * past `staleMs` are dropped). The aggregator is read-only except the authed `POST /api/ingest` that nodes
 * push to — it never mutates any throttle state.
 */

import { readFileSync } from "node:fs";
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer as createHttpServer,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type {
  AdmissionAnalyticsSnapshot,
  AdmissionLane,
  AnalyticsSnapshot,
  Clock,
} from "throttlekit";
import { systemClock } from "throttlekit";
import { bearerEqual } from "./auth.js";
import { LENS_VERSION, type LensHub } from "./hub.js";
import { hostForUrl, listenServer } from "./net.js";
import type { LensTlsOptions, RunningLens } from "./serve.js";
import { writeSseEvent, writeSseHeaders, writeSsePing } from "./sse.js";
import type {
  LensGuardSnapshot,
  LensPolicySnapshot,
  LensSnapshot,
  LensStatsSnapshot,
} from "./types.js";
import { renderLensHtml } from "./ui.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const LANES: readonly AdmissionLane[] = ["rate", "concurrency", "cost", "policy"];
const MAX_INGEST_BYTES = 8 * 1024 * 1024;

type Hit = { key: string; count: number };

/** Merge two top-K hitter lists by summing per-key counts, then re-top-K (defensive, over-estimating). */
function mergeHits(a: Hit[] = [], b: Hit[] = [], k = 10): Hit[] {
  const m = new Map<string, number>();
  for (const h of a) m.set(h.key, (m.get(h.key) ?? 0) + h.count);
  for (const h of b) m.set(h.key, (m.get(h.key) ?? 0) + h.count);
  return [...m.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((x, y) => (y.count !== x.count ? y.count - x.count : x.key < y.key ? -1 : 1))
    .slice(0, k);
}

function isAdmission(
  a: AnalyticsSnapshot | AdmissionAnalyticsSnapshot,
): a is AdmissionAnalyticsSnapshot {
  return "deniedByLane" in a;
}

/** Merge two analytics snapshots of the same policy (both limiter, or both admitter). */
function mergeAnalytics(
  a: AnalyticsSnapshot | AdmissionAnalyticsSnapshot,
  b: AnalyticsSnapshot | AdmissionAnalyticsSnapshot,
  k: number,
): AnalyticsSnapshot | AdmissionAnalyticsSnapshot {
  const allowed = a.allowed + b.allowed;
  const denied = a.denied + b.denied;
  const total = allowed + denied;
  const base: AnalyticsSnapshot = {
    windowStartedAt: Math.min(a.windowStartedAt, b.windowStartedAt),
    windowMs: a.windowMs,
    allowed,
    denied,
    total,
    denyRate: total === 0 ? 0 : denied / total,
    topRequested: mergeHits(a.topRequested, b.topRequested, k),
    topDenied: mergeHits(a.topDenied, b.topDenied, k),
  };
  if (isAdmission(a) && isAdmission(b)) {
    const deniedByLane = {} as Record<AdmissionLane, number>;
    const topDeniedByLane = {} as Record<AdmissionLane, Hit[]>;
    for (const lane of LANES) {
      deniedByLane[lane] = (a.deniedByLane[lane] ?? 0) + (b.deniedByLane[lane] ?? 0);
      topDeniedByLane[lane] = mergeHits(a.topDeniedByLane?.[lane], b.topDeniedByLane?.[lane], k);
    }
    return { ...base, deniedByLane, topDeniedByLane };
  }
  return base;
}

/** n-weighted average latency + max across two policy latency summaries. */
function mergeLatency(
  a: LensPolicySnapshot["latency"],
  b: LensPolicySnapshot["latency"],
): LensPolicySnapshot["latency"] {
  const an = a?.n ?? 0;
  const bn = b?.n ?? 0;
  const n = an + bn;
  if (n === 0) return undefined;
  return {
    avgMs: ((a?.avgMs ?? 0) * an + (b?.avgMs ?? 0) * bn) / n,
    maxMs: Math.max(a?.maxMs ?? 0, b?.maxMs ?? 0),
    n,
  };
}

function mergePolicy(a: LensPolicySnapshot, b: LensPolicySnapshot, k: number): LensPolicySnapshot {
  const out: LensPolicySnapshot = {
    name: a.name,
    kind: a.kind,
    analytics: mergeAnalytics(a.analytics, b.analytics, k),
  };
  if (a.strategy !== undefined) out.strategy = a.strategy;
  if (a.axes !== undefined) out.axes = a.axes;
  const limit = Math.max(a.limit ?? 0, b.limit ?? 0);
  if (limit > 0) out.limit = limit;
  const latency = mergeLatency(a.latency, b.latency);
  if (latency !== undefined) out.latency = latency;
  return out;
}

/** Merge many per-node snapshots into one `mode: "fleet"` snapshot. Pure. */
export function mergeSnapshots(
  snaps: readonly LensSnapshot[],
  opts: { now: number; topK?: number; recentLimit?: number },
): LensSnapshot {
  const k = opts.topK ?? 10;
  const recentLimit = opts.recentLimit ?? 200;
  const byName = new Map<string, LensPolicySnapshot>();
  for (const s of snaps) {
    for (const p of s.policies) {
      const cur = byName.get(p.name);
      byName.set(p.name, cur !== undefined ? mergePolicy(cur, p, k) : { ...p });
    }
  }
  const guards: LensGuardSnapshot[] = [];
  const stats: LensStatsSnapshot[] = [];
  for (const s of snaps) {
    const nid = s.meta.nodeId;
    const q = (n: string): string => (nid !== undefined ? `${nid}/${n}` : n);
    for (const g of s.guards) guards.push({ ...g, name: q(g.name) });
    for (const st of s.stats) stats.push({ ...st, name: q(st.name) });
  }
  const recentDenials = snaps
    .flatMap((s) => s.recentDenials)
    .sort((x, y) => x.at - y.at)
    .slice(-recentLimit);
  const recentFences = snaps
    .flatMap((s) => s.recentFences)
    .sort((x, y) => x.at - y.at)
    .slice(-recentLimit);
  return {
    meta: {
      generatedAt: opts.now,
      windowMs: snaps[0]?.meta.windowMs ?? 60_000,
      mode: "fleet",
      lensVersion: LENS_VERSION,
      fleetNodes: snaps.length,
    },
    policies: [...byName.values()],
    guards,
    stats,
    recentDenials,
    recentFences,
  };
}

/** Options for {@link createLensAggregator}. */
export interface LensAggregatorOptions {
  /** Drop a node whose last push is older than this (ms). Default 30_000. */
  staleMs?: number;
  /** Heavy-hitter top-K depth in the merged snapshot. Default 10. */
  topK?: number;
  /** Max recent denial / fence rows in the merged snapshot. Default 200. */
  recentLimit?: number;
  /** Injected clock (deterministic tests). Default the system clock. */
  clock?: Clock;
}

/** The fleet aggregator: ingest per-node snapshots, read the merged fleet snapshot. */
export interface LensAggregator {
  /** Record a node's latest snapshot (keyed by `meta.nodeId`, else `fallbackId`, else a counter). */
  ingest(snap: LensSnapshot, fallbackId?: string): void;
  /** The merged fleet snapshot over the currently-live nodes (stale ones evicted). */
  snapshot(): LensSnapshot;
  /** The ids of the currently-tracked nodes. */
  nodes(): string[];
}

/** Create an in-memory fleet aggregator. */
export function createLensAggregator(options: LensAggregatorOptions = {}): LensAggregator {
  const staleMs = options.staleMs ?? 30_000;
  const topK = options.topK ?? 10;
  const recentLimit = options.recentLimit ?? 200;
  const clock = options.clock ?? systemClock;
  const seen = new Map<string, { snap: LensSnapshot; at: number }>();
  let counter = 0;

  return {
    ingest(snap, fallbackId) {
      const nid = snap.meta.nodeId ?? fallbackId ?? `node-${++counter}`;
      seen.set(nid, { snap, at: clock.now() });
    },
    snapshot() {
      const now = clock.now();
      const live: LensSnapshot[] = [];
      for (const [id, v] of seen) {
        if (now - v.at > staleMs) seen.delete(id);
        else live.push(v.snap);
      }
      return mergeSnapshots(live, { now, topK, recentLimit });
    },
    nodes() {
      return [...seen.keys()];
    },
  };
}

/** Options for {@link serveLensAggregator}. */
export interface ServeAggregatorOptions {
  /** Port to bind. Default 9091. Use 0 for an ephemeral port. */
  port?: number;
  /** Host to bind. Default `127.0.0.1` (loopback). */
  host?: string;
  /** Serve over HTTPS (and mTLS when `caPath` is set). */
  tls?: LensTlsOptions;
  /** Require `Authorization: Bearer <token>` on every request (ingest AND reads). */
  token?: string;
  /** Merged-snapshot SSE push interval (ms). Default 2000. */
  intervalMs?: number;
  /** SSE keep-alive ping interval (ms). Default 15000. */
  pingMs?: number;
}

/** Read a request body up to a byte cap, rejecting oversize. */
function readBody(req: IncomingMessage, cap: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** Build the aggregator's request handler (read-only GETs + the authed ingest POST). */
function aggregatorHandler(aggregator: LensAggregator, options: ServeAggregatorOptions) {
  const token = options.token;
  const intervalMs = options.intervalMs ?? 2000;
  const pingMs = options.pingMs ?? 15000;
  const html = renderLensHtml("");
  const authed = (req: IncomingMessage): boolean =>
    token === undefined || bearerEqual(req.headers.authorization, token);

  return (req: IncomingMessage, res: ServerResponse): void => {
    if (!authed(req)) {
      res.writeHead(401, { "Content-Type": "text/plain" }).end("Unauthorized");
      return;
    }
    const path = (req.url ?? "/").split("?", 1)[0] ?? "/";

    if (req.method === "POST" && path === "/api/ingest") {
      readBody(req, MAX_INGEST_BYTES)
        .then((body) => {
          aggregator.ingest(
            JSON.parse(body) as LensSnapshot,
            req.socket.remoteAddress ?? undefined,
          );
          res.writeHead(204).end();
        })
        .catch(() => {
          res.writeHead(400, { "Content-Type": "text/plain" }).end("Bad ingest payload");
        });
      return;
    }

    if (req.method !== "GET") {
      res
        .writeHead(405, { Allow: "GET, POST", "Content-Type": "text/plain" })
        .end("Method Not Allowed");
      return;
    }

    if (path === "/api/snapshot") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(aggregator.snapshot()));
      return;
    }
    if (path === "/api/stream") {
      writeSseHeaders(res);
      let closed = false;
      const timers: ReturnType<typeof setInterval>[] = [];
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        for (const t of timers) clearInterval(t);
      };
      req.on("close", cleanup);
      res.on("close", cleanup);
      const pushSnapshot = (): void => {
        if (closed) return;
        let snap: unknown;
        try {
          snap = aggregator.snapshot();
        } catch {
          cleanup();
          return;
        }
        if (!writeSseEvent(res, "snapshot", snap)) cleanup();
      };
      pushSnapshot();
      if (closed) return;
      timers.push(setInterval(pushSnapshot, intervalMs));
      timers.push(
        setInterval(() => {
          if (!writeSsePing(res)) cleanup();
        }, pingMs),
      );
      return;
    }
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not Found");
  };
}

/** Start a standalone fleet-aggregator server. Nodes push to `POST /api/ingest`; reads are the merged view. */
export async function serveLensAggregator(
  aggregator: LensAggregator,
  options: ServeAggregatorOptions = {},
): Promise<RunningLens> {
  const port = options.port ?? 9091;
  const host = options.host ?? "127.0.0.1";
  const tls = options.tls;
  const secure = tls !== undefined;
  const handler = aggregatorHandler(aggregator, options);

  if (!secure && options.token === undefined && !LOOPBACK.has(host)) {
    console.warn(
      `warning: ThrottleKit Lens aggregator is serving on a NON-loopback host (${host}) with neither TLS nor a token. It accepts snapshot pushes and exposes keys/tenants. Bind to loopback, or pass { tls } and/or { token }.`,
    );
  }

  const server: Server =
    tls !== undefined
      ? createHttpsServer(
          {
            cert: readFileSync(tls.certPath),
            key: readFileSync(tls.keyPath),
            ...(tls.caPath !== undefined
              ? { ca: readFileSync(tls.caPath), requestCert: true, rejectUnauthorized: true }
              : {}),
          },
          handler,
        )
      : createHttpServer(handler);

  const boundPort = await listenServer(server, port, host);
  const scheme = secure ? "https" : "http";

  return {
    port: boundPort,
    host,
    url: `${scheme}://${hostForUrl(host)}:${boundPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err === undefined || err === null ? resolve() : reject(err)));
      }),
  };
}

/** Options for {@link pushSnapshots}. */
export interface PushSnapshotsOptions {
  /** The aggregator base URL, e.g. `http://aggregator:9091`. */
  url: string;
  /** Push interval (ms). Default 2000. */
  intervalMs?: number;
  /** Bearer token, if the aggregator requires one. */
  token?: string;
}

/** Periodically POST a hub's snapshot to a fleet aggregator. Returns a stop function. */
export function pushSnapshots(hub: LensHub, options: PushSnapshotsOptions): () => void {
  const intervalMs = options.intervalMs ?? 2000;
  const target = `${options.url.replace(/\/$/, "")}/api/ingest`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
  const send = (): void => {
    void fetch(target, {
      method: "POST",
      headers,
      body: JSON.stringify(hub.snapshot()),
      // Bound each push so a black-holed aggregator can't pile up overlapping in-flight requests.
      signal: AbortSignal.timeout(Math.max(1000, intervalMs)),
    }).catch(() => {});
  };
  send();
  const timer = setInterval(send, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
