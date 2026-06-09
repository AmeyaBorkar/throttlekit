/**
 * The **`/metrics`** door — a Prometheus text-exposition view of the in-process {@link LensHub}, plus a
 * lightweight **`/healthz`** liveness probe, over a small HTTP server separate from the gRPC port.
 *
 * It exposes only **aggregate, PII-free** series — per-policy allow/deny counters, per-axis denials, the
 * observed ceiling, admit-path latency, and concurrency-guard health. It deliberately carries **no per-key
 * series** (unlike the gRPC Monitor snapshot, which has top-keys + the denial feed), so it needs no auth and
 * defaults to loopback (a host flag exposes it, with a warning). Strictly read-only.
 */

import { type Server, createServer } from "node:http";

import type { LensHub } from "./hub.js";
import type { LensSnapshot } from "./types.js";

/** Escape a Prometheus label value (backslash, double-quote, newline) per the exposition format. */
function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Render the hub snapshot as Prometheus text exposition (v0.0.4). Aggregate-only: per-policy allow/deny,
 * per-axis denials (admitters), observed ceiling, p50/p99 admit latency, and concurrency-guard health.
 */
export function renderPrometheus(snap: LensSnapshot): string {
  const out: string[] = [];
  const metric = (name: string, type: "counter" | "gauge", help: string): void => {
    out.push(`# HELP ${name} ${help}`);
    out.push(`# TYPE ${name} ${type}`);
  };
  const pl = (name: string, labels: Record<string, string>, value: number): void => {
    const inner = Object.entries(labels)
      .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
      .join(",");
    out.push(`${name}{${inner}} ${value}`);
  };

  metric(
    "throttlekit_allowed_total",
    "counter",
    "Requests admitted in the current window, per policy.",
  );
  for (const p of snap.policies)
    pl("throttlekit_allowed_total", { policy: p.name }, p.analytics.allowed);

  metric(
    "throttlekit_denied_total",
    "counter",
    "Requests denied in the current window, per policy.",
  );
  for (const p of snap.policies)
    pl("throttlekit_denied_total", { policy: p.name }, p.analytics.denied);

  metric(
    "throttlekit_denied_by_axis_total",
    "counter",
    "Denials partitioned by binding axis (admitters; Sigma === denied), per policy.",
  );
  for (const p of snap.policies) {
    const lane = (p.analytics as { deniedByLane?: Record<string, number> }).deniedByLane;
    if (lane !== undefined) {
      for (const [axis, count] of Object.entries(lane)) {
        pl("throttlekit_denied_by_axis_total", { policy: p.name, axis }, count);
      }
    }
  }

  metric("throttlekit_limit", "gauge", "Most-recent observed effective ceiling, per policy.");
  for (const p of snap.policies)
    if (p.limit !== undefined) pl("throttlekit_limit", { policy: p.name }, p.limit);

  metric("throttlekit_latency_p50_ms", "gauge", "Recent admit-path p50 latency (ms), per policy.");
  for (const p of snap.policies)
    if (p.latency) pl("throttlekit_latency_p50_ms", { policy: p.name }, p.latency.p50Ms);
  metric("throttlekit_latency_p99_ms", "gauge", "Recent admit-path p99 latency (ms), per policy.");
  for (const p of snap.policies)
    if (p.latency) pl("throttlekit_latency_p99_ms", { policy: p.name }, p.latency.p99Ms);

  metric("throttlekit_guard_inflight", "gauge", "In-flight concurrency permits, per guard.");
  for (const g of snap.guards) pl("throttlekit_guard_inflight", { guard: g.name }, g.inflight);
  metric("throttlekit_guard_limit", "gauge", "Concurrency ceiling, per guard.");
  for (const g of snap.guards) pl("throttlekit_guard_limit", { guard: g.name }, g.limit);
  metric(
    "throttlekit_guard_fenced",
    "gauge",
    "1 if the guard is self-fenced (partitioned), else 0.",
  );
  for (const g of snap.guards)
    pl("throttlekit_guard_fenced", { guard: g.name }, g.fenced === true ? 1 : 0);

  return `${out.join("\n")}\n`;
}

/** Options for {@link startMetricsServer}. */
export interface MetricsServerOptions {
  /** The hub to render. */
  hub: LensHub;
  /** Bind host. Default `127.0.0.1` (loopback — the metrics are aggregate but a host change exposes them). */
  host?: string;
  /** Bind port. Pass `0` for an OS-assigned ephemeral port (tests read it back). */
  port: number;
}

/** A bound metrics HTTP server. */
export interface RunningMetricsServer {
  /** The actual bound port (meaningful when `port: 0` was requested). */
  readonly port: number;
  /** Stop the HTTP server. */
  close(): Promise<void>;
}

/**
 * Start the `/metrics` + `/healthz` HTTP server. `GET /metrics` renders the live snapshot as Prometheus
 * text; `GET /healthz` (alias `/health`) is a 200 liveness probe; anything else is 404. Read-only.
 */
export async function startMetricsServer(
  opts: MetricsServerOptions,
): Promise<RunningMetricsServer> {
  const host = opts.host ?? "127.0.0.1";
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      res.end("method not allowed\n");
      return;
    }
    if (path === "/metrics") {
      // snapshot() is cheap + never throws (the hub isolates source throws).
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(renderPrometheus(opts.hub.snapshot()));
      return;
    }
    if (path === "/healthz" || path === "/health") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok\n");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found (try /metrics or /healthz)\n");
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.port, host, () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : opts.port);
    });
  });
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
