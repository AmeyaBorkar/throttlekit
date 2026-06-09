import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { ManualClock } from "throttlekit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningServer, resolveProtoPath, serve } from "../src/grpc.js";
import type { LensHub } from "../src/monitor/hub.js";
import { authorizeMonitor, peerIsLoopback, snapshotToProto } from "../src/monitor/service.js";
import { wireMonitor } from "../src/monitor/wire.js";

/**
 * The read-only Monitor door (`throttlekit.v1.Monitor`): the auth gate (loopback-only, or secret-gated —
 * the snapshot carries traffic keys = PII), the snapshot→proto projection, and the whole thing end-to-end
 * over real gRPC (a live server + a Monitor client). Strictly read-only — it never affects a decision.
 */

/** A gcra(2/window) policy driven to 2 allows + 1 deny, tapped into a hub for the Monitor to project. */
async function populatedHub(
  nodeId: string,
): Promise<{ hub: LensHub; service: ReturnType<typeof wireMonitor>["service"] }> {
  const clock = new ManualClock(0);
  const config = JSON.stringify({
    limiters: { api: { strategy: "gcra", limit: 2, period: 60_000, burst: 2 } },
  });
  const { service, hub } = wireMonitor(config, { clock }, "open", "memory", nodeId);
  await service.check("api", "alice"); // allowed
  await service.check("api", "alice"); // allowed
  await service.check("api", "alice"); // denied (burst spent at the frozen clock)
  return { hub, service };
}

function makeMonitorClient(port: number): {
  client: any;
  call: (method: string, req: unknown, md?: grpc.Metadata) => Promise<any>;
  close: () => void;
} {
  const def = protoLoader.loadSync(resolveProtoPath(), {
    keepCase: false,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(def) as any;
  const client = new proto.throttlekit.v1.Monitor(
    `127.0.0.1:${port}`,
    grpc.credentials.createInsecure(),
  );
  const call = (method: string, req: unknown, md?: grpc.Metadata): Promise<any> =>
    new Promise((resolve, reject) => {
      const cb = (err: unknown, resp: unknown) => (err ? reject(err) : resolve(resp));
      if (md !== undefined) client[method](req, md, cb);
      else client[method](req, cb);
    });
  return { client, call, close: () => client.close() };
}

describe("Monitor: peerIsLoopback", () => {
  it("accepts loopback / local-socket peers (bare and scheme-prefixed forms)", () => {
    expect(peerIsLoopback("127.0.0.1:52340")).toBe(true); // grpc-js emits this bare form
    expect(peerIsLoopback("[::1]:52340")).toBe(true);
    expect(peerIsLoopback("ipv4:127.0.0.1:54321")).toBe(true);
    expect(peerIsLoopback("ipv6:[::1]:54321")).toBe(true);
    expect(peerIsLoopback("ipv6:[::ffff:127.0.0.1]:54321")).toBe(true);
    expect(peerIsLoopback("127.5.5.5:9")).toBe(true); // 127.0.0.0/8
    expect(peerIsLoopback("unix:/tmp/tk.sock")).toBe(true);
  });
  it("rejects remote peers", () => {
    expect(peerIsLoopback("10.0.0.4:54321")).toBe(false);
    expect(peerIsLoopback("ipv4:192.168.1.20:80")).toBe(false);
    expect(peerIsLoopback("[2001:db8::1]:443")).toBe(false);
    expect(peerIsLoopback("ipv6:[2001:db8::1]:443")).toBe(false);
  });
});

describe("Monitor: authorizeMonitor", () => {
  const md = (entries: Record<string, string> = {}): grpc.Metadata => {
    const m = new grpc.Metadata();
    for (const [k, v] of Object.entries(entries)) m.set(k, v);
    return m;
  };

  it("no secret configured: loopback allowed, remote rejected", () => {
    expect(authorizeMonitor("ipv4:127.0.0.1:9", md(), {})).toBeNull();
    const denied = authorizeMonitor("ipv4:10.0.0.1:9", md(), {});
    expect(denied?.code).toBe(grpc.status.UNAUTHENTICATED);
  });

  it("secret configured: required from EVERY peer (even loopback)", () => {
    const auth = { secret: "s3cr3t" };
    // Correct secret via either header form → allowed, regardless of peer.
    expect(
      authorizeMonitor("ipv4:10.0.0.1:9", md({ "x-monitor-secret": "s3cr3t" }), auth),
    ).toBeNull();
    expect(
      authorizeMonitor("ipv4:10.0.0.1:9", md({ authorization: "Bearer s3cr3t" }), auth),
    ).toBeNull();
    // Missing / wrong secret → rejected even from loopback (the secret is mandatory once set).
    expect(authorizeMonitor("ipv4:127.0.0.1:9", md(), auth)?.code).toBe(
      grpc.status.UNAUTHENTICATED,
    );
    expect(
      authorizeMonitor("ipv4:127.0.0.1:9", md({ "x-monitor-secret": "nope" }), auth)?.code,
    ).toBe(grpc.status.UNAUTHENTICATED);
  });
});

describe("Monitor: snapshotToProto projection", () => {
  it("projects the typed summary + a parseable raw_json", async () => {
    const { hub } = await populatedHub("node-7");
    const snap = snapshotToProto(hub.snapshot()) as any;
    expect(snap.meta.nodeId).toBe("node-7");
    expect(snap.meta.mode).toBe("process");
    const api = snap.policies.find((p: any) => p.name === "api");
    expect(api).toBeDefined();
    expect(api.allowed).toBe(2);
    expect(api.denied).toBe(1);
    expect(snap.recentDenials.length).toBe(1);
    expect(snap.recentDenials[0].policy).toBe("api");
    // raw_json carries the FULL snapshot (forward-compat / depth).
    const raw = JSON.parse(snap.rawJson);
    expect(raw.policies.length).toBe(1);
    expect(raw.meta.lensVersion).toBe(snap.meta.lensVersion);
  });
});

describe("Monitor door over gRPC (loopback, no secret)", () => {
  let running: RunningServer;
  let h: ReturnType<typeof makeMonitorClient>;

  beforeAll(async () => {
    const { hub, service } = await populatedHub("live-node");
    running = await serve({ service, host: "127.0.0.1", port: 0, monitor: { hub } });
    h = makeMonitorClient(running.port);
    await new Promise<void>((resolve, reject) => {
      h.client.waitForReady(Date.now() + 5000, (err: unknown) => (err ? reject(err) : resolve()));
    });
  });
  afterAll(async () => {
    h?.close();
    await running?.close();
  });

  it("GetSnapshot returns the projected operational snapshot from a loopback caller", async () => {
    const resp = await h.call("getSnapshot", {});
    expect(resp.snapshot.meta.nodeId).toBe("live-node");
    const api = resp.snapshot.policies.find((p: any) => p.name === "api");
    expect(api.allowed).toBe(2);
    expect(api.denied).toBe(1);
    expect(resp.snapshot.recentDenials.length).toBe(1);
    expect(JSON.parse(resp.snapshot.rawJson).policies.length).toBe(1);
  });
});

describe("Monitor door over gRPC (secret-gated)", () => {
  let running: RunningServer;
  let h: ReturnType<typeof makeMonitorClient>;

  beforeAll(async () => {
    const { hub, service } = await populatedHub("secure-node");
    running = await serve({
      service,
      host: "127.0.0.1",
      port: 0,
      monitor: { hub, secret: "s3cr3t" },
    });
    h = makeMonitorClient(running.port);
    await new Promise<void>((resolve, reject) => {
      h.client.waitForReady(Date.now() + 5000, (err: unknown) => (err ? reject(err) : resolve()));
    });
  });
  afterAll(async () => {
    h?.close();
    await running?.close();
  });

  it("rejects a loopback call with no secret (the secret is mandatory once set)", async () => {
    await expect(h.call("getSnapshot", {})).rejects.toMatchObject({
      code: grpc.status.UNAUTHENTICATED,
    });
  });

  it("rejects a wrong secret", async () => {
    const md = new grpc.Metadata();
    md.set("x-monitor-secret", "wrong");
    await expect(h.call("getSnapshot", {}, md)).rejects.toMatchObject({
      code: grpc.status.UNAUTHENTICATED,
    });
  });

  it("accepts the correct secret", async () => {
    const md = new grpc.Metadata();
    md.set("x-monitor-secret", "s3cr3t");
    const resp = await h.call("getSnapshot", {}, md);
    expect(resp.snapshot.meta.nodeId).toBe("secure-node");
  });
});
