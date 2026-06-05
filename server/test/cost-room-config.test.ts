import { ManualClock } from "throttlekit";
import { describe, expect, it } from "vitest";
import { wireMonitor } from "../src/monitor/wire.js";

/**
 * #294 — Cost Room P3 (server config wiring). Exercises the full path: a `fairEscrow` policy's
 * `costRoom` config → `buildServiceConfig` → `wireMonitor` registers a cost-room source through the
 * existing `trackStats` door → `hub.snapshot().costRooms`. Default-on with an explicit opt-out, the
 * declared `unit` echoed verbatim, and the source routed to `costRooms` (never the generic stats feed).
 */

const BASE = 1_700_000_000_000;

const CFG = JSON.stringify({
  limiters: {
    budget: { fairEscrow: { limit: 100_000, windowMs: 10_000, unit: "tokens" } },
    "no-room": { fairEscrow: { limit: 1000, windowMs: 10_000, costRoom: false } },
  },
});

describe("#294 Cost Room P3 — fairEscrow costRoom config wiring", () => {
  it("default-on: an opted-in fairEscrow policy populates costRooms after debits", async () => {
    const clock = new ManualClock(BASE);
    const { service, hub } = wireMonitor(CFG, { clock }, "open", "memory");

    await service.check("budget", "acct-a", 1000);
    clock.advance(1000);
    await service.check("budget", "acct-a", 1000);
    const snap = hub.snapshot();

    const room = snap.costRooms?.find((r) => r.policy === "budget");
    expect(room).toBeDefined();
    expect(room?.unit).toBe("tokens"); // declared unit echoed verbatim, not hard-coded
    expect(room?.enforced).toBe(true);
    expect(room?.scope).toBe("single-node");
    expect(room?.fairShareReliable).toBe(false); // L1-only on the server today
    expect(room?.tenants.find((t) => t.tenant === "acct-a")).toBeDefined();
  });

  it("opt-out: costRoom:false leaves that policy out of costRooms, but Fairness still works", async () => {
    const clock = new ManualClock(BASE);
    const { service, hub } = wireMonitor(CFG, { clock }, "open", "memory");
    await service.check("no-room", "x", 10);
    const snap = hub.snapshot();

    expect(snap.costRooms?.find((r) => r.policy === "no-room")).toBeUndefined();
    // The Fairness view ('wfe' stat) is unaffected for the opted-out policy.
    expect(snap.stats.find((s) => s.name === "no-room" && s.kind === "wfe")).toBeDefined();
  });

  it("the cost-room source is routed to costRooms, never the generic stats feed", async () => {
    const clock = new ManualClock(BASE);
    const { service, hub } = wireMonitor(CFG, { clock }, "open", "memory");
    await service.check("budget", "acct", 500);
    const snap = hub.snapshot();

    expect(snap.stats.find((s) => s.kind === "cost-room")).toBeUndefined();
    expect(snap.stats.find((s) => s.name === "budget" && s.kind === "wfe")).toBeDefined();
  });

  it("rejects a non-positive costRoom bound at config time", () => {
    const bad = JSON.stringify({
      limiters: { b: { fairEscrow: { limit: 100, windowMs: 1000, costRoomMaxKeys: 0 } } },
    });
    expect(() => wireMonitor(bad, {}, "open", "memory")).toThrow(
      /costRoomMaxKeys.*positive integer/i,
    );
  });
});
