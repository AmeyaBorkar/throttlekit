import { ManualClock, adaptiveConcurrency, gcra, rateLimit, unifiedAdmission } from "throttlekit";
import type { AdmissionAnalyticsSnapshot, AnalyticsSnapshot } from "throttlekit";
import { describe, expect, it } from "vitest";
import { createLensHub } from "../src/hub.js";

const HOUR = 3_600_000;

describe("createLensHub", () => {
  it("tracks a plain limiter into the universal board + denial feed", async () => {
    const clock = new ManualClock(0);
    const hub = createLensHub({ clock, windowMs: HOUR });
    const limiter = hub.trackLimiter(
      "api",
      rateLimit({ strategy: gcra({ limit: 3, periodMs: HOUR, burst: 3 }) }),
    );
    const denials: string[] = [];
    hub.subscribe({ onDenial: (r) => denials.push(r.key) });

    for (let i = 0; i < 5; i++) await limiter.check("alice");

    const snap = hub.snapshot();
    expect(snap.meta.mode).toBe("process");
    expect(snap.policies).toHaveLength(1);
    const p = snap.policies[0];
    expect(p?.kind).toBe("limiter");
    expect(p?.strategy).toBe("gcra");
    const a = p?.analytics as AnalyticsSnapshot;
    expect(a.allowed).toBe(3);
    expect(a.denied).toBe(2);
    expect(snap.recentDenials).toHaveLength(2);
    expect(denials).toEqual(["alice", "alice"]);
    // Phase-3 enrichments: observed ceiling + latency ring + the decision on each denial row.
    expect(p?.limit).toBeGreaterThan(0);
    expect(p?.latency?.n).toBe(5);
    expect(snap.recentDenials[0]?.decision.allowed).toBe(false);
    expect(snap.recentDenials[0]?.decision.remaining).toBe(0);
  });

  it("tracks a unified admitter with the binding-axis breakdown", async () => {
    const clock = new ManualClock(0);
    const hub = createLensHub({ clock, windowMs: HOUR });
    const admit = hub.trackAdmitter(
      "checkout",
      unifiedAdmission({
        rate: rateLimit({ strategy: gcra({ limit: 2, periodMs: HOUR, burst: 2 }) }),
      }),
    );
    for (let i = 0; i < 5; i++) (await admit.admit({ key: "t1" })).release();

    const snap = hub.snapshot();
    const p = snap.policies.find((x) => x.name === "checkout");
    expect(p?.kind).toBe("admitter");
    const a = p?.analytics as AdmissionAnalyticsSnapshot;
    expect(a.denied).toBe(3);
    expect(a.deniedByLane.rate).toBe(3);
    expect(a.deniedByLane.cost).toBe(0);
    // The denial feed carries the binding lane + the drawer-grade per-axis decision.
    expect(snap.recentDenials.every((r) => r.lane === "rate")).toBe(true);
    const row = snap.recentDenials[0];
    expect(row?.decision.allowed).toBe(false);
    expect(row?.perAxis?.rate?.allowed).toBe(false);
    expect(p?.limit).toBeGreaterThan(0);
  });

  it("reads concurrency guard health and a custom stats source", () => {
    const hub = createLensHub();
    hub.trackGuard("io", adaptiveConcurrency({ minLimit: 4, maxLimit: 16, initialLimit: 8 }));
    hub.trackStats("fairness", "wfe", () => ({ tenants: [{ tenant: "a", used: 3 }] }));
    hub.trackStats("boom", "broken", () => {
      throw new Error("nope");
    });

    const snap = hub.snapshot();
    expect(snap.guards).toHaveLength(1);
    expect(snap.guards[0]?.limit).toBe(8);
    expect(snap.guards[0]?.inflight).toBe(0);
    const fairness = snap.stats.find((s) => s.name === "fairness");
    expect(fairness?.value).toEqual({ tenants: [{ tenant: "a", used: 3 }] });
    const boom = snap.stats.find((s) => s.name === "boom");
    expect((boom?.value as { error: string }).error).toContain("nope");
  });

  it("records fence events and lets the host set health", () => {
    const clock = new ManualClock(1000);
    const hub = createLensHub({ clock });
    const fences: string[] = [];
    hub.subscribe({ onFence: (r) => fences.push(r.guard) });
    hub.recordFence("io");
    hub.setHealth({ backend: "redis", reachable: true, failMode: "closed" });

    const snap = hub.snapshot();
    expect(snap.recentFences).toEqual([{ at: 1000, guard: "io" }]);
    expect(fences).toEqual(["io"]);
    expect(snap.health?.backend).toBe("redis");
  });
});
