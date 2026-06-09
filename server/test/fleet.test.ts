import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { ManualClock } from "throttlekit";
import { TestCoordinator } from "throttlekit/federation";
import { afterEach, describe, expect, it } from "vitest";
import { buildServiceConfig } from "../src/config.js";
import { authorizeFleet, fleetHandlers } from "../src/fleet/service.js";
import { makeFederatedFleetSource } from "../src/fleet/source.js";
import { type RunningServer, resolveProtoPath, serve } from "../src/grpc.js";
import { createRateLimiterServiceFromConfig } from "../src/service.js";

/**
 * The Tier-2 Fleet lease door (`throttlekit.v1.Fleet`): the lease source (a partial-grant draw from a
 * federated policy's coordinator), the auth gate (loopback-only or secret — handing out budget is a
 * poisoning vector), the Reserve handler, and the whole thing end-to-end over real gRPC. The server is the
 * one oracle for the grant SIZE; the client (a `LeaseSpender`) only spends what it's granted.
 */

// A federated fixedWindow(limit 5, 60s) policy → one global per-window budget of 5, leasable in chunks.
const FED = JSON.stringify({
  limiters: {
    api: {
      federated: { region: "us-east", batch: 1 },
      strategy: "fixedWindow",
      limit: 5,
      period: 60000,
    },
  },
});

function fakeCall(request: unknown, peer = "127.0.0.1:5000", md = new grpc.Metadata()): unknown {
  return { request, getPeer: () => peer, metadata: md };
}

/** Invoke a handler's `reserve` and resolve to its `(err, resp)` callback result. */
function callReserve(
  handlers: grpc.UntypedServiceImplementation,
  call: unknown,
): Promise<{ err: any; resp: any }> {
  return new Promise((resolve) => {
    (handlers.reserve as any)(call, (err: unknown, resp: unknown) => resolve({ err, resp }));
  });
}

describe("Fleet: authorizeFleet", () => {
  it("allows a loopback peer when no secret is configured", () => {
    expect(authorizeFleet("127.0.0.1:5000", new grpc.Metadata(), {})).toBeNull();
  });
  it("rejects a non-loopback peer when no secret is configured", () => {
    const r = authorizeFleet("10.0.0.4:5000", new grpc.Metadata(), {});
    expect(r?.code).toBe(grpc.status.UNAUTHENTICATED);
  });
  it("requires the secret from ANY peer once one is configured", () => {
    const auth = { secret: "s3cret" };
    expect(authorizeFleet("127.0.0.1:5000", new grpc.Metadata(), auth)?.code).toBe(
      grpc.status.UNAUTHENTICATED,
    ); // even loopback needs it
    const ok = new grpc.Metadata();
    ok.add("x-fleet-secret", "s3cret");
    expect(authorizeFleet("203.0.113.5:5000", ok, auth)).toBeNull();
    const bearer = new grpc.Metadata();
    bearer.add("authorization", "Bearer s3cret");
    expect(authorizeFleet("203.0.113.5:5000", bearer, auth)).toBeNull();
    const wrong = new grpc.Metadata();
    wrong.add("x-fleet-secret", "nope");
    expect(authorizeFleet("203.0.113.5:5000", wrong, auth)?.code).toBe(grpc.status.UNAUTHENTICATED);
  });
});

describe("FleetLeaseSource — partial, window-coupled draw from the coordinator", () => {
  it("grants in full, then partially, then refuses as the global budget drains within a window", async () => {
    const clock = new ManualClock(0);
    const coord = new TestCoordinator({ budgetPerWindow: 5 });
    const src = makeFederatedFleetSource(coord, { windowMs: 60_000, limit: 5, clock });

    const a = await src.lease("api", 3);
    expect(a).toEqual({
      capacity: 3,
      expiresAt: 60_000,
      refreshIntervalMs: 60_000,
      retryAfterMs: 0,
      limit: 5,
    });
    const b = await src.lease("api", 3); // only 2 left → a partial grant
    expect(b.capacity).toBe(2);
    const c = await src.lease("api", 1); // exhausted → refusal, retry at the window reset
    expect(c.capacity).toBe(0);
    expect(c.retryAfterMs).toBe(60_000);
  });

  it("refills at the next window boundary (the grant is window-coupled)", async () => {
    const clock = new ManualClock(0);
    const coord = new TestCoordinator({ budgetPerWindow: 5 });
    const src = makeFederatedFleetSource(coord, { windowMs: 60_000, limit: 5, clock });
    expect((await src.lease("api", 5)).capacity).toBe(5); // drains window [0, 60000)
    expect((await src.lease("api", 1)).capacity).toBe(0);
    clock.set(60_000); // next window
    const g = await src.lease("api", 5);
    expect(g.capacity).toBe(5);
    expect(g.expiresAt).toBe(120_000);
  });

  it("treats wants <= 0 as 1 (via the handler) and floors fractional wants", async () => {
    const coord = new TestCoordinator({ budgetPerWindow: 5 });
    const src = makeFederatedFleetSource(coord, {
      windowMs: 60_000,
      limit: 5,
      clock: new ManualClock(0),
    });
    expect((await src.lease("api", 2.9)).capacity).toBe(2); // floor(2.9) = 2
  });
});

describe("Fleet config wiring — buildServiceConfig exposes one source per federated policy", () => {
  it("builds a fleet source for a federated policy", () => {
    const cfg = buildServiceConfig(FED, {
      makeCoordinator: () => new TestCoordinator({ budgetPerWindow: 5 }),
      clock: new ManualClock(0),
    });
    expect(Object.keys(cfg.fleetSources)).toEqual(["api"]);
    expect(cfg.fleetSources.api?.axis).toBe("rate");
  });
  it("exposes no fleet source for a plain rate-limit policy", () => {
    const cfg = buildServiceConfig(
      JSON.stringify({ limiters: { p: { strategy: "gcra", limit: 5, period: 1000, burst: 5 } } }),
      {},
    );
    expect(cfg.fleetSources).toEqual({});
  });
});

describe("fleetHandlers — the Reserve handler", () => {
  const clock = new ManualClock(0);
  const coord = new TestCoordinator({ budgetPerWindow: 5 });
  coord.setBudget("acme", 2); // a distinct per-key budget to prove domain → lease-key routing
  const handlers = fleetHandlers(
    { api: makeFederatedFleetSource(coord, { windowMs: 60_000, limit: 5, clock }) },
    {},
  );

  it("projects a grant onto the Lease (capacity / expiry / safe / limit), domain selecting the key", async () => {
    const { err, resp } = await callReserve(
      handlers,
      fakeCall({ policy: "api", caller: { domain: "acme" }, wants: 5 }),
    );
    expect(err).toBeNull();
    expect(resp.lease).toEqual({
      capacity: 2, // acme's per-key budget, NOT the policy default of 5 → domain routed the lease key
      expiryMs: 60_000,
      refreshIntervalMs: 60_000,
      safeCapacity: 2,
      retryAfterMs: 0,
      limit: 5,
    });
  });

  it("treats an unset wants as 1", async () => {
    const { resp } = await callReserve(
      handlers,
      fakeCall({ policy: "api", caller: { domain: "d1" } }),
    );
    expect(resp.lease.capacity).toBe(1);
  });

  it("returns NOT_FOUND for an unknown policy", async () => {
    const { err } = await callReserve(handlers, fakeCall({ policy: "nope", wants: 1 }));
    expect(err?.code).toBe(grpc.status.NOT_FOUND);
  });

  it("returns UNIMPLEMENTED for the concurrency axis (not leasable in v1)", async () => {
    const { err } = await callReserve(
      handlers,
      fakeCall({ policy: "api", axis: "AXIS_CONCURRENCY", wants: 1 }),
    );
    expect(err?.code).toBe(grpc.status.UNIMPLEMENTED);
  });

  it("rejects a non-loopback peer without a secret (UNAUTHENTICATED)", async () => {
    const { err } = await callReserve(
      handlers,
      fakeCall({ policy: "api", wants: 1 }, "10.0.0.4:5000"),
    );
    expect(err?.code).toBe(grpc.status.UNAUTHENTICATED);
  });
});

describe("Fleet — end-to-end over real gRPC", () => {
  let running: RunningServer | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  function makeFleetClient(port: number, secret?: string) {
    const def = protoLoader.loadSync(resolveProtoPath(), {
      keepCase: false,
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(def) as any;
    const client = new proto.throttlekit.v1.Fleet(
      `127.0.0.1:${port}`,
      grpc.credentials.createInsecure(),
    );
    const reserve = (req: unknown): Promise<any> =>
      new Promise((resolve, reject) => {
        const cb = (err: unknown, resp: unknown) => (err ? reject(err) : resolve(resp));
        if (secret !== undefined) {
          const md = new grpc.Metadata();
          md.add("x-fleet-secret", secret);
          client.reserve(req, md, cb);
        } else {
          client.reserve(req, cb);
        }
      });
    return { reserve, close: () => client.close() };
  }

  async function serveFleet(secret?: string): Promise<{ port: number; coord: TestCoordinator }> {
    const clock = new ManualClock(0);
    const coord = new TestCoordinator({ budgetPerWindow: 5 });
    const service = createRateLimiterServiceFromConfig(FED, {
      makeCoordinator: () => coord,
      clock,
    });
    const sources = { api: makeFederatedFleetSource(coord, { windowMs: 60_000, limit: 5, clock }) };
    running = await serve({
      service,
      port: 0,
      ...(secret !== undefined ? { fleet: { sources, secret } } : { fleet: { sources } }),
    });
    return { port: running.port, coord };
  }

  it("leases a chunk of the global budget, then refuses once it is spent", async () => {
    const { port } = await serveFleet();
    const c = makeFleetClient(port);
    try {
      const r1 = await c.reserve({ policy: "api", caller: { domain: "api" }, wants: 3 });
      expect(r1.lease.capacity).toBe(3);
      expect(r1.lease.limit).toBe(5);
      expect(r1.lease.expiryMs).toBe(60_000);
      expect(r1.lease.safeCapacity).toBe(3);
      expect(r1.lease.retryAfterMs).toBe(0);
      const r2 = await c.reserve({ policy: "api", caller: { domain: "api" }, wants: 5 });
      expect(r2.lease.capacity).toBe(2); // only 2 left — a partial grant
      const r3 = await c.reserve({ policy: "api", caller: { domain: "api" }, wants: 1 });
      expect(r3.lease.capacity).toBe(0); // spent
      expect(r3.lease.retryAfterMs).toBe(60_000);
    } finally {
      c.close();
    }
  });

  it("returns NOT_FOUND for an unknown policy and UNIMPLEMENTED for the concurrency axis", async () => {
    const { port } = await serveFleet();
    const c = makeFleetClient(port);
    try {
      await expect(c.reserve({ policy: "ghost", wants: 1 })).rejects.toMatchObject({
        code: grpc.status.NOT_FOUND,
      });
      await expect(
        c.reserve({ policy: "api", axis: "AXIS_CONCURRENCY", wants: 1 }),
      ).rejects.toMatchObject({ code: grpc.status.UNIMPLEMENTED });
    } finally {
      c.close();
    }
  });

  it("enforces the fleet secret end-to-end (rejects without it, accepts with it)", async () => {
    const { port } = await serveFleet("s3cret");
    const noSecret = makeFleetClient(port);
    const withSecret = makeFleetClient(port, "s3cret");
    try {
      await expect(noSecret.reserve({ policy: "api", wants: 1 })).rejects.toMatchObject({
        code: grpc.status.UNAUTHENTICATED,
      });
      const ok = await withSecret.reserve({ policy: "api", caller: { domain: "api" }, wants: 1 });
      expect(ok.lease.capacity).toBe(1);
    } finally {
      noSecret.close();
      withSecret.close();
    }
  });
});
