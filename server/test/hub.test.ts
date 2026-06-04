import { MemoryStore, gcra, rateLimit } from "throttlekit";
import { describe, expect, it } from "vitest";
import { createLensHub } from "../src/monitor/hub.js";

describe("createLensHub", () => {
  it("taps a limiter: counts allow/deny and feeds the live denial ring", () => {
    const hub = createLensHub({ windowMs: 60_000 });
    const limiter = hub.trackLimiter(
      "api",
      rateLimit({ strategy: gcra({ limit: 2, periodMs: 60_000 }), store: new MemoryStore() }),
    );
    // Same key, same instant: a small burst is admitted, the rest denied (no refill within the ms).
    for (let i = 0; i < 5; i++) limiter.checkSync("k");

    const snap = hub.snapshot();
    expect(snap.policies).toHaveLength(1);
    const p = snap.policies[0];
    expect(p?.name).toBe("api");
    expect(p?.kind).toBe("limiter");
    const a = p?.analytics as { allowed: number; denied: number };
    expect(a.allowed + a.denied).toBe(5);
    expect(a.denied).toBeGreaterThan(0);
    expect(a.allowed).toBeGreaterThan(0);
    expect(snap.recentDenials.length).toBeGreaterThan(0);
    expect(snap.recentDenials.every((d) => d.policy === "api" && !d.allowed)).toBe(true);
  });

  it("surfaces the health block set by the host", () => {
    const hub = createLensHub();
    hub.setHealth({ backend: "redis", failMode: "closed" });
    expect(hub.snapshot().health).toEqual({ backend: "redis", failMode: "closed" });
  });

  it("stamps a nodeId into the snapshot meta when given", () => {
    const hub = createLensHub({ nodeId: "0.0.0.0:50051" });
    expect(hub.snapshot().meta.nodeId).toBe("0.0.0.0:50051");
  });
});
