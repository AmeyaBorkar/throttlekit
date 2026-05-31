import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { ManualClock, rateLimit, tokenBudget } from "throttlekit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningServer, resolveProtoPath, serve } from "../src/grpc.js";
import { createRateLimiterService } from "../src/service.js";
import { buildStrategy, rateLimitSuites } from "./_vectors.js";

/**
 * End-to-end conformance over real gRPC. A live in-process server (its limiters sharing a ManualClock we
 * control) plus a real client replay every golden-vector suite *over the wire*; the decoded response
 * must equal the oracle field-for-field. Because the binding is a pure mapping over the service core,
 * this proves the whole door — serialization, dispatch, and decode — reproduces an embedded library.
 */

function makeClient(port: number): {
  client: any;
  call: (m: string, req: unknown) => Promise<any>;
} {
  const def = protoLoader.loadSync(resolveProtoPath(), {
    keepCase: false,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(def) as any;
  const client = new proto.throttlekit.v1.RateLimiter(
    `127.0.0.1:${port}`,
    grpc.credentials.createInsecure(),
  );
  const call = (method: string, req: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      client[method](req, (err: unknown, resp: unknown) => (err ? reject(err) : resolve(resp)));
    });
  return { client, call };
}

describe("gRPC service door ≡ golden vectors (over the wire)", () => {
  const clock = new ManualClock(0);
  let running: RunningServer;
  let h: { client: any; call: (m: string, req: unknown) => Promise<any> };

  beforeAll(async () => {
    const limiters = Object.fromEntries(
      rateLimitSuites.map((s) => [
        s.name,
        rateLimit({ strategy: buildStrategy(s.strategy), clock }),
      ]),
    );
    const meters = {
      budget: {
        create: () => tokenBudget({ budget: 5, windowMs: 3_600_000, clock }),
        maxKeys: 1000,
      },
    };
    const service = createRateLimiterService({ limiters, meters });
    running = await serve({ service, host: "127.0.0.1", port: 0 });
    h = makeClient(running.port);
    await new Promise<void>((resolve, reject) => {
      h.client.waitForReady(Date.now() + 5000, (err: unknown) => (err ? reject(err) : resolve()));
    });
  });

  afterAll(async () => {
    h?.client.close();
    await running?.close();
  });

  it("replays every suite over gRPC identically to the oracle", async () => {
    for (const suite of rateLimitSuites) {
      for (const op of suite.ops) {
        clock.set(op.now);
        const resp = await h.call("check", { policy: suite.name, key: suite.key, cost: op.cost });
        expect(resp.decision, `${suite.name} @ now=${op.now} cost=${op.cost}`).toEqual(op.expect);
      }
    }
  });

  it("maps an unknown policy to NOT_FOUND", async () => {
    await expect(
      h.call("check", { policy: "no-such-policy", key: "k", cost: 1 }),
    ).rejects.toMatchObject({ code: grpc.status.NOT_FOUND });
  });

  it("checkMany returns one decision per key, in order", async () => {
    clock.set(0);
    const policy = rateLimitSuites[0]?.name;
    const resp = await h.call("checkMany", { policy, keys: ["wireA", "wireB", "wireC"], cost: 1 });
    expect(resp.decisions).toHaveLength(3);
    expect(resp.decisions.every((d: { allowed: boolean }) => d.allowed)).toBe(true);
  });

  it("peek over the wire is non-consuming", async () => {
    clock.set(0);
    const policy = rateLimitSuites[0]?.name;
    const a = await h.call("peek", { policy, key: "wirePeek" });
    const b = await h.call("peek", { policy, key: "wirePeek" });
    expect(a.decision.remaining).toBe(b.decision.remaining);
  });

  it("debit over the wire spends a token budget then refuses", async () => {
    clock.set(0);
    const allowed: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      const resp = await h.call("debit", { policy: "budget", key: "wireBudget", tokens: 1 });
      allowed.push(resp.decision.allowed);
    }
    expect(allowed).toEqual([true, true, true, true, true, false]); // budget of 5, then denied
  });
});
