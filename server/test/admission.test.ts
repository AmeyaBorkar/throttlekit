import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { ManualClock, adaptiveConcurrency, unifiedAdmission } from "throttlekit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, resolveProtoPath, serve } from "../src/grpc.js";
import {
  OperationNotSupportedError,
  PolicyNotFoundError,
  type RateLimiterService,
  createRateLimiterService,
  createRateLimiterServiceFromConfig,
} from "../src/service.js";

/**
 * Door C — the stateful admission lifecycle (Admit/Release/Heartbeat). We pin the adaptive ceiling
 * (`minLimit === maxLimit`) so the concurrency decision is deterministic, and drive a ManualClock so the
 * lease TTL + reclaim sweep are deterministic too. The decision itself is the core's
 * `unifiedAdmission`/`adaptiveConcurrency` — the service only mints/holds/reclaims the lease.
 */

/** A unified admitter whose concurrency ceiling is pinned to `limit` (deterministic for tests). */
function pinned(limit: number, clock: ManualClock) {
  return unifiedAdmission({
    concurrency: adaptiveConcurrency({ minLimit: limit, maxLimit: limit, clock }),
    clock,
  });
}

describe("admission lifecycle — in-process service core", () => {
  let clock: ManualClock;
  let service: RateLimiterService;

  beforeEach(() => {
    clock = new ManualClock(0);
    service = createRateLimiterService({
      limiters: {},
      admitters: { cc: pinned(2, clock), one: pinned(1, clock) },
      clock,
      leaseTtlMs: 2000,
    });
  });

  it("admits up to the pinned limit, then denies on the concurrency axis (a deny holds no slot)", async () => {
    const a1 = await service.admit("cc", "k");
    const a2 = await service.admit("cc", "k");
    const a3 = await service.admit("cc", "k");
    expect([a1.decision.allowed, a2.decision.allowed, a3.decision.allowed]).toEqual([
      true,
      true,
      false,
    ]);
    expect(a1.leaseId).not.toBe("");
    expect(a2.leaseId).not.toBe("");
    expect(a1.leaseId).not.toBe(a2.leaseId);
    expect(a1.leaseExpiresAt).toBe(2000); // now(0) + leaseTtlMs(2000)
    expect(a3.leaseId).toBe("");
    expect(a3.bindingAxis).toBe("concurrency");
  });

  it("mints unguessable lease ids (capability tokens, not an enumerable counter)", async () => {
    // Release/Heartbeat key only on the lease id and do no per-caller ownership check, so the id IS the
    // capability. The old `String(++nextLeaseId)` made it trivially guessable — a peer holding "5" could
    // release/renew "4"/"6". Ids must be high-entropy and underivable from one another.
    const a1 = await service.admit("cc", "k");
    const a2 = await service.admit("cc", "k");
    expect(a1.leaseId).toMatch(/^[0-9a-f]{32}$/); // 128-bit random hex, not "1"
    expect(a2.leaseId).toMatch(/^[0-9a-f]{32}$/);
    expect(a1.leaseId).not.toBe(a2.leaseId);
    expect(a2.leaseId).not.toBe(String(Number(a1.leaseId) + 1)); // not the next counter value
    // The mint must not break the lifecycle: the random id still releases its slot.
    service.release(a1.leaseId);
    expect((await service.admit("cc", "k")).decision.allowed).toBe(true);
  });

  it("release frees a slot for the next admit; release of an unknown id is a no-op", async () => {
    const a1 = await service.admit("cc", "k");
    await service.admit("cc", "k"); // fill the second slot
    expect((await service.admit("cc", "k")).decision.allowed).toBe(false);
    service.release(a1.leaseId);
    expect((await service.admit("cc", "k")).decision.allowed).toBe(true);
    service.release("no-such-lease"); // idempotent, must not throw
  });

  it("sweep reclaims an unheart-beaten lease at the TTL (crash recovery)", async () => {
    const a = await service.admit("one", "k");
    expect(a.decision.allowed).toBe(true);
    expect((await service.admit("one", "k")).decision.allowed).toBe(false); // single slot full
    clock.set(1999);
    service.sweep(); // before the TTL → still held
    expect((await service.admit("one", "k")).decision.allowed).toBe(false);
    clock.set(2000);
    service.sweep(); // at the TTL → reclaimed (dropped)
    expect((await service.admit("one", "k")).decision.allowed).toBe(true);
  });

  it("heartbeat extends the deadline so the sweep does not reclaim; unknown ids report reclaimed", async () => {
    const a = await service.admit("one", "k");
    clock.set(1000);
    const hb = service.heartbeat([a.leaseId, "ghost"]);
    expect(hb.liveIds).toEqual([a.leaseId]);
    expect(hb.reclaimedIds).toEqual(["ghost"]);
    expect(hb.nextDeadline).toBe(3000); // 1000 + 2000
    clock.set(2500);
    service.sweep(); // past the original 2000 deadline but within the renewed 3000 → survives
    expect((await service.admit("one", "k")).decision.allowed).toBe(false);
  });

  it("rejects mismatched ops: admit on a limiter, check on an admitter, admit on an unknown policy", async () => {
    const mixed = createRateLimiterServiceFromConfig(
      [
        "limiters:",
        "  api:",
        "    strategy: gcra",
        "    limit: 10",
        "    period: 1s",
        "    burst: 10",
        "  cc:",
        "    concurrency:",
        "      minLimit: 1",
        "      maxLimit: 1",
      ].join("\n"),
      { clock: new ManualClock(0) },
    );
    await expect(mixed.admit("api", "k")).rejects.toBeInstanceOf(OperationNotSupportedError);
    await expect(mixed.check("cc", "k")).rejects.toBeInstanceOf(OperationNotSupportedError);
    await expect(mixed.admit("ghost", "k")).rejects.toBeInstanceOf(PolicyNotFoundError);
  });
});

describe("admission config (YAML)", () => {
  it("builds concurrency-only and unified (rate × concurrency) admitters", async () => {
    const svc = createRateLimiterServiceFromConfig(
      [
        "limiters:",
        "  cc:",
        "    concurrency:",
        "      minLimit: 2",
        "      maxLimit: 2",
        "  unified:",
        "    strategy: gcra",
        "    limit: 5",
        "    period: 1s",
        "    burst: 5",
        "    concurrency:",
        "      minLimit: 3",
        "      maxLimit: 3",
      ].join("\n"),
      { clock: new ManualClock(0) },
    );
    expect(svc.policies()).toEqual(expect.arrayContaining(["cc", "unified"]));

    // Concurrency-only: two admits, then a concurrency deny.
    expect((await svc.admit("cc", "k")).decision.allowed).toBe(true);
    expect((await svc.admit("cc", "k")).decision.allowed).toBe(true);
    expect((await svc.admit("cc", "k")).decision.allowed).toBe(false);

    // Unified: the concurrency axis (3) binds before the rate axis (5).
    const allowed: boolean[] = [];
    for (let i = 0; i < 4; i++) allowed.push((await svc.admit("unified", "u")).decision.allowed);
    expect(allowed).toEqual([true, true, true, false]);
    expect((await svc.admit("unified", "u")).bindingAxis).toBe("concurrency");
  });

  it("unified: the rate axis binds when concurrency has room (admit+release exhausts rate)", async () => {
    const svc = createRateLimiterServiceFromConfig(
      [
        "limiters:",
        "  unified:",
        "    strategy: gcra",
        "    limit: 3",
        "    period: 1s",
        "    burst: 3",
        "    concurrency:",
        "      minLimit: 5",
        "      maxLimit: 5",
      ].join("\n"),
      { clock: new ManualClock(0) },
    );
    // admit+release keeps the concurrency axis empty while spending the 3 rate tokens.
    for (let i = 0; i < 3; i++) {
      const a = await svc.admit("unified", "u");
      expect(a.decision.allowed, `admit ${i}`).toBe(true);
      svc.release(a.leaseId);
    }
    const denied = await svc.admit("unified", "u");
    expect(denied.decision.allowed).toBe(false);
    expect(denied.bindingAxis).toBe("rate"); // concurrency had room; rate is exhausted
    expect(denied.leaseId).toBe(""); // the transiently-acquired concurrency slot was released
  });
});

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

describe("admission over gRPC (the wire path)", () => {
  let clock: ManualClock;
  let service: RateLimiterService;
  let running: RunningServer;
  let h: { client: any; call: (m: string, req: unknown) => Promise<any> };

  beforeEach(async () => {
    clock = new ManualClock(0);
    service = createRateLimiterService({
      limiters: {},
      admitters: { cc: pinned(2, clock), one: pinned(1, clock) },
      clock,
      leaseTtlMs: 2000,
    });
    // Park serve()'s auto-sweeper far in the future; the reclaim test drives `service.sweep()` directly
    // so the assertion is deterministic rather than racing a real timer.
    running = await serve({ service, host: "127.0.0.1", port: 0, sweepIntervalMs: 3_600_000 });
    h = makeClient(running.port);
    await new Promise<void>((resolve, reject) => {
      h.client.waitForReady(Date.now() + 5000, (err: unknown) => (err ? reject(err) : resolve()));
    });
  });

  afterEach(async () => {
    h?.client.close();
    await running?.close();
  });

  it("admit → release → admit holds and frees a slot over the wire", async () => {
    const a1 = await h.call("admit", { policy: "cc", key: "k" });
    const a2 = await h.call("admit", { policy: "cc", key: "k" });
    const a3 = await h.call("admit", { policy: "cc", key: "k" });
    expect([a1.decision.allowed, a2.decision.allowed, a3.decision.allowed]).toEqual([
      true,
      true,
      false,
    ]);
    expect(a1.leaseId).not.toBe("");
    expect(a3.leaseId).toBe("");
    expect(a3.bindingAxis).toBe("concurrency");
    await h.call("release", { leaseId: a1.leaseId, dropped: false });
    expect((await h.call("admit", { policy: "cc", key: "k" })).decision.allowed).toBe(true);
  });

  it("heartbeat renews live leases and reports reclaimed ids over the wire", async () => {
    const a = await h.call("admit", { policy: "one", key: "k" });
    clock.set(1000);
    const hb = await h.call("heartbeat", { leaseIds: [a.leaseId, "ghost"] });
    expect(hb.liveIds).toEqual([a.leaseId]);
    expect(hb.reclaimedIds).toEqual(["ghost"]);
    expect(Number(hb.nextDeadline)).toBe(3000);
  });

  it("the server reclaims an unheart-beaten lease (crash recovery) over the wire", async () => {
    const a = await h.call("admit", { policy: "one", key: "k" });
    expect(a.decision.allowed).toBe(true);
    expect((await h.call("admit", { policy: "one", key: "k" })).decision.allowed).toBe(false);
    clock.set(2000);
    service.sweep(); // a crashed client never sent Release; the sweep reclaims its slot
    expect((await h.call("admit", { policy: "one", key: "k" })).decision.allowed).toBe(true);
  });

  it("maps admit on an unknown policy to NOT_FOUND", async () => {
    await expect(h.call("admit", { policy: "nope", key: "k" })).rejects.toMatchObject({
      code: grpc.status.NOT_FOUND,
    });
  });
});
