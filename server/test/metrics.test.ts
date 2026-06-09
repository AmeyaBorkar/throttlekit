import { ManualClock } from "throttlekit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LensHub } from "../src/monitor/hub.js";
import {
  type RunningMetricsServer,
  renderPrometheus,
  startMetricsServer,
} from "../src/monitor/metrics.js";
import { wireMonitor } from "../src/monitor/wire.js";

/**
 * The `/metrics` (Prometheus) + `/healthz` HTTP door: the aggregate, PII-free exposition of the hub, and
 * the HTTP server that serves it. Read-only — it never affects a decision.
 */

/** A gcra(2/window) policy driven to 2 allows + 1 deny, returned as a hub for the metrics renderer. */
async function populatedHub(): Promise<LensHub> {
  const clock = new ManualClock(0);
  const config = JSON.stringify({
    limiters: { api: { strategy: "gcra", limit: 2, period: 60_000, burst: 2 } },
  });
  const { service, hub } = wireMonitor(config, { clock }, "open", "memory", "metrics-node");
  await service.check("api", "alice");
  await service.check("api", "alice");
  await service.check("api", "alice"); // denied
  return hub;
}

describe("renderPrometheus", () => {
  it("renders aggregate per-policy series with HELP/TYPE and a trailing newline", async () => {
    const text = renderPrometheus((await populatedHub()).snapshot());
    expect(text).toContain("# TYPE throttlekit_allowed_total counter");
    expect(text).toContain("# TYPE throttlekit_denied_total counter");
    expect(text).toMatch(/throttlekit_allowed_total\{policy="api"\} 2/);
    expect(text).toMatch(/throttlekit_denied_total\{policy="api"\} 1/);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("is PII-free: no per-key series (only policy / guard / axis labels)", async () => {
    const text = renderPrometheus((await populatedHub()).snapshot());
    expect(text).not.toMatch(/\bkey="/); // top-keys + the denial feed live only on the authed gRPC door
  });

  it("escapes label values", () => {
    // A synthetic snapshot with a nasty policy name exercises the label escaper.
    const snap = {
      meta: { generatedAt: 0, windowMs: 60_000, mode: "process" as const, lensVersion: "x" },
      policies: [
        {
          name: 'we"ird\\',
          kind: "limiter" as const,
          analytics: { allowed: 1, denied: 0, topRequested: [], topDenied: [] },
        },
      ],
      guards: [],
      stats: [],
      recentDenials: [],
      recentFences: [],
    };
    const text = renderPrometheus(snap as unknown as Parameters<typeof renderPrometheus>[0]);
    expect(text).toContain('throttlekit_allowed_total{policy="we\\"ird\\\\"} 1');
  });
});

describe("metrics HTTP server", () => {
  let srv: RunningMetricsServer;

  beforeAll(async () => {
    srv = await startMetricsServer({ hub: await populatedHub(), port: 0 });
  });
  afterAll(async () => {
    await srv.close();
  });

  it("GET /metrics returns Prometheus text", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("throttlekit_denied_total");
  });

  it("GET /healthz is a 200 liveness probe", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe("ok");
  });

  it("an unknown path is 404", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/nope`);
    expect(res.status).toBe(404);
  });

  it("a non-GET method is 405", async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/metrics`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});
