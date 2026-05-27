import { describe, expect, it, vi } from "vitest";
import { createEnforcer } from "../../src/adapters/enforce";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";
import type { Store } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";

const strategy = () => fixedWindow({ limit: 2, windowMs: 60_000 });

function enforcer(extra: Record<string, unknown> = {}) {
  const clock = new ManualClock(0);
  return createEnforcer({
    strategy: strategy(),
    store: new MemoryStore({ clock, sweepIntervalMs: 0 }),
    clock,
    ...extra,
  });
}

/** A store whose every apply rejects, to drive the fail-policy branch. */
const downStore: Store = {
  apply: () => Promise.reject(new Error("store down")),
  reset: () => Promise.resolve(),
};

describe("createEnforcer", () => {
  it("admits under the limit (outcome ok) with standards headers", async () => {
    const e = enforcer();
    const r = await e.enforce("k");
    expect(r.allowed).toBe(true);
    expect(r.outcome).toBe("ok");
    expect(r.decision?.allowed).toBe(true);
    expect(r.retryAfterMs).toBe(0);
    // Draft headers are emitted by default.
    expect(Object.keys(r.headers).some((h) => h.toLowerCase().startsWith("ratelimit"))).toBe(true);
  });

  it("denies over the limit (outcome limited) and fires onLimited", async () => {
    const onLimited = vi.fn();
    const e = enforcer({ onLimited });
    await e.enforce("k");
    await e.enforce("k");
    const r = await e.enforce("k"); // 3rd over limit 2
    expect(r.allowed).toBe(false);
    expect(r.outcome).toBe("limited");
    expect(r.retryAfterMs).toBeGreaterThan(0);
    expect(onLimited).toHaveBeenCalledOnce();
    expect(onLimited).toHaveBeenCalledWith("k", expect.objectContaining({ allowed: false }));
  });

  it("fails OPEN on a store outage: allowed, outcome error, onError fired", async () => {
    const clock = new ManualClock(0);
    const onError = vi.fn();
    const e = createEnforcer({ strategy: strategy(), store: downStore, clock, onError });
    const r = await e.enforce("k");
    expect(r.allowed).toBe(true);
    expect(r.outcome).toBe("error");
    expect(r.decision).toBeUndefined();
    expect(r.headers).toEqual({});
    expect(onError).toHaveBeenCalledOnce();
  });

  it("fails CLOSED on a store outage: denied, outcome error", async () => {
    const clock = new ManualClock(0);
    const e = createEnforcer({ strategy: strategy(), store: downStore, clock, fail: "closed" });
    const r = await e.enforce("k");
    expect(r.allowed).toBe(false);
    expect(r.outcome).toBe("error");
    expect(r.error).toBeInstanceOf(Error);
  });

  it("emits no headers when emit is false", async () => {
    const e = enforcer({ emit: false });
    const r = await e.enforce("k");
    expect(r.headers).toEqual({});
  });

  it("honors cost", async () => {
    const e = enforcer();
    expect((await e.enforce("k", 2)).allowed).toBe(true); // consumes the whole limit of 2
    expect((await e.enforce("k", 1)).outcome).toBe("limited");
  });

  it("works with a prebuilt limiter", async () => {
    const clock = new ManualClock(0);
    const limiter = rateLimit({
      strategy: strategy(),
      store: new MemoryStore({ clock, sweepIntervalMs: 0 }),
      clock,
    });
    const e = createEnforcer({ limiter });
    expect(e.limiter).toBe(limiter);
    expect((await e.enforce("k")).allowed).toBe(true);
  });
});
