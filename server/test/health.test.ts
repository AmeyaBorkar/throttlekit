import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningServer, serve } from "../src/grpc.js";
import { healthHandlers, resolveHealthProtoPath } from "../src/health.js";
import { createRateLimiterService } from "../src/service.js";

/**
 * The standard `grpc.health.v1.Health` service: it rides every serve path on the same port with no auth
 * (it reports only SERVING / NOT_SERVING, never traffic data), so off-the-shelf probes work out of the box.
 * We cover the handlers in isolation, then end-to-end over a real server with a standard Health client.
 */

function makeHealthClient(port: number): any {
  const def = protoLoader.loadSync(resolveHealthProtoPath(), {
    keepCase: false,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(def) as any;
  return new proto.grpc.health.v1.Health(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
}

describe("Health: handlers", () => {
  const handlers = healthHandlers(new Set(["throttlekit.v1.RateLimiter"]));
  const check = handlers.check as (call: any, cb: grpc.sendUnaryData<any>) => void;
  const watch = handlers.watch as (call: any) => void;

  it("Check returns SERVING for the overall server ('') and a known service", () => {
    const got: Array<[unknown, unknown]> = [];
    check({ request: { service: "" } }, (e, r) => got.push([e, r]));
    check({ request: { service: "throttlekit.v1.RateLimiter" } }, (e, r) => got.push([e, r]));
    expect(got[0]).toEqual([null, { status: "SERVING" }]);
    expect(got[1]).toEqual([null, { status: "SERVING" }]);
  });

  it("Check returns NOT_FOUND for an unknown service (per the health spec)", () => {
    let err: any;
    check({ request: { service: "nope.Svc" } }, (e) => {
      err = e;
    });
    expect(err?.code).toBe(grpc.status.NOT_FOUND);
  });

  it("Watch emits the current status once — SERVING for known, SERVICE_UNKNOWN for unknown", () => {
    const writes: unknown[] = [];
    const fakeCall = (service: string) => ({
      request: { service },
      write: (m: unknown) => writes.push(m),
      on: () => {},
    });
    watch(fakeCall("throttlekit.v1.RateLimiter"));
    watch(fakeCall("nope.Svc"));
    expect(writes).toEqual([{ status: "SERVING" }, { status: "SERVICE_UNKNOWN" }]);
  });
});

describe("Health over gRPC (the wire path)", () => {
  let running: RunningServer;
  let client: any;

  beforeAll(async () => {
    // A bare server (no Monitor door) — so RateLimiter is SERVING but Monitor is unknown.
    running = await serve({
      service: createRateLimiterService({ limiters: {} }),
      host: "127.0.0.1",
      port: 0,
    });
    client = makeHealthClient(running.port);
    await new Promise<void>((resolve, reject) => {
      client.waitForReady(Date.now() + 5000, (err: unknown) => (err ? reject(err) : resolve()));
    });
  });
  afterAll(async () => {
    client?.close();
    await running?.close();
  });

  const callCheck = (service: string): Promise<any> =>
    new Promise((resolve, reject) =>
      client.check({ service }, (err: unknown, resp: unknown) =>
        err ? reject(err) : resolve(resp),
      ),
    );

  it("Check reports SERVING for the overall server and the served RateLimiter", async () => {
    expect((await callCheck("")).status).toBe("SERVING");
    expect((await callCheck("throttlekit.v1.RateLimiter")).status).toBe("SERVING");
  });

  it("Check returns NOT_FOUND for a service this server does not expose (Monitor door off)", async () => {
    await expect(callCheck("throttlekit.v1.Monitor")).rejects.toMatchObject({
      code: grpc.status.NOT_FOUND,
    });
  });

  it("Watch streams the current SERVING status", async () => {
    const stream = client.watch({ service: "throttlekit.v1.RateLimiter" });
    const first = await new Promise<any>((resolve, reject) => {
      stream.on("data", resolve);
      stream.on("error", reject);
    });
    stream.cancel();
    expect(first.status).toBe("SERVING");
  });
});
