import { describe, expect, it } from "vitest";
import {
  GRPC_RESOURCE_EXHAUSTED,
  GRPC_UNAVAILABLE,
  type GrpcServerCallLike,
  type GrpcServiceError,
  type GrpcUnaryHandler,
  grpcRateLimit,
} from "../../src/adapters/grpc";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { ManualClock } from "../../src/core/clock";
import type { Store } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";

/** A fake unary call carrying a fixed peer. */
function call(peer = "ipv4:203.0.113.7:5000"): GrpcServerCallLike {
  return { getPeer: () => peer };
}

/** Invoke a wrapped handler and resolve with whatever it passes to the callback. */
function invoke<Call extends GrpcServerCallLike, Res>(
  wrapped: GrpcUnaryHandler<Call, Res>,
  c: Call,
): Promise<{ err: GrpcServiceError | null; value: Res | null | undefined }> {
  return new Promise((resolve) => {
    wrapped(c, (err, value) => resolve({ err, value }));
  });
}

const ok: GrpcUnaryHandler<GrpcServerCallLike, { msg: string }> = (_call, cb) =>
  cb(null, { msg: "ok" });

const downStore: Store = {
  apply: () => Promise.reject(new Error("store down")),
  reset: () => Promise.resolve(),
};

describe("grpcRateLimit", () => {
  it("forwards to the handler under the limit", async () => {
    const clock = new ManualClock(0);
    const gate = grpcRateLimit({
      strategy: fixedWindow({ limit: 2, windowMs: 60_000 }),
      store: new MemoryStore({ clock, sweepIntervalMs: 0 }),
      clock,
    });
    const r = await invoke(gate.unary(ok), call());
    expect(r.err).toBeNull();
    expect(r.value).toEqual({ msg: "ok" });
  });

  it("fails the call with RESOURCE_EXHAUSTED over the limit", async () => {
    const clock = new ManualClock(0);
    const gate = grpcRateLimit({
      strategy: fixedWindow({ limit: 1, windowMs: 60_000 }),
      store: new MemoryStore({ clock, sweepIntervalMs: 0 }),
      clock,
    });
    const wrapped = gate.unary(ok);
    await invoke(wrapped, call()); // consume the single slot
    const r = await invoke(wrapped, call());
    expect(r.err?.code).toBe(GRPC_RESOURCE_EXHAUSTED);
    expect(r.err?.details).toMatch(/retry after/);
    expect(r.value).toBeUndefined();
  });

  it("keys independent peers separately (default key = peer)", async () => {
    const clock = new ManualClock(0);
    const gate = grpcRateLimit({
      strategy: fixedWindow({ limit: 1, windowMs: 60_000 }),
      store: new MemoryStore({ clock, sweepIntervalMs: 0 }),
      clock,
    });
    const wrapped = gate.unary(ok);
    expect((await invoke(wrapped, call("ipv4:1.1.1.1:1"))).err).toBeNull();
    expect((await invoke(wrapped, call("ipv4:2.2.2.2:2"))).err).toBeNull(); // different peer, own bucket
    expect((await invoke(wrapped, call("ipv4:1.1.1.1:1"))).err?.code).toBe(GRPC_RESOURCE_EXHAUSTED);
  });

  it("supports a custom key and per-call cost", async () => {
    const clock = new ManualClock(0);
    const gate = grpcRateLimit<GrpcServerCallLike>({
      strategy: fixedWindow({ limit: 5, windowMs: 60_000 }),
      store: new MemoryStore({ clock, sweepIntervalMs: 0 }),
      clock,
      key: () => "fixed-tenant",
      cost: () => 5,
    });
    const wrapped = gate.unary(ok);
    expect((await invoke(wrapped, call())).err).toBeNull(); // cost 5 fills the limit
    expect((await invoke(wrapped, call())).err?.code).toBe(GRPC_RESOURCE_EXHAUSTED);
  });

  it("fails OPEN on a store outage (forwards to the handler)", async () => {
    const clock = new ManualClock(0);
    const gate = grpcRateLimit({
      strategy: fixedWindow({ limit: 1, windowMs: 60_000 }),
      store: downStore,
      clock,
    });
    const r = await invoke(gate.unary(ok), call());
    expect(r.err).toBeNull();
    expect(r.value).toEqual({ msg: "ok" });
  });

  it("fails CLOSED on a store outage with UNAVAILABLE", async () => {
    const clock = new ManualClock(0);
    const gate = grpcRateLimit({
      strategy: fixedWindow({ limit: 1, windowMs: 60_000 }),
      store: downStore,
      clock,
      fail: "closed",
    });
    const r = await invoke(gate.unary(ok), call());
    expect(r.err?.code).toBe(GRPC_UNAVAILABLE);
  });
});
