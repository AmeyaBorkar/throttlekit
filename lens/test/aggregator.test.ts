import { ManualClock, adaptiveConcurrency, gcra, rateLimit, unifiedAdmission } from "throttlekit";
import type { AdmissionAnalyticsSnapshot } from "throttlekit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type LensAggregator,
  createLensAggregator,
  mergeSnapshots,
  pushSnapshots,
  serveLensAggregator,
} from "../src/aggregator.js";
import { createLensHub } from "../src/hub.js";
import type { RunningLens } from "../src/serve.js";
import type { LensSnapshot } from "../src/types.js";

const HOUR = 3_600_000;

/** Build a node hub, drive `n` rate-bound admits at one key + a guard, and snapshot it. */
async function nodeSnapshot(nodeId: string, n: number): Promise<LensSnapshot> {
  const hub = createLensHub({ clock: new ManualClock(0), windowMs: HOUR, nodeId });
  const admit = hub.trackAdmitter(
    "checkout",
    unifiedAdmission({
      rate: rateLimit({ strategy: gcra({ limit: 2, periodMs: HOUR, burst: 2 }) }),
    }),
  );
  hub.trackGuard("io", adaptiveConcurrency({ minLimit: 4, maxLimit: 4, initialLimit: 4 }));
  for (let i = 0; i < n; i++) (await admit.admit({ key: "t1" })).release();
  return hub.snapshot();
}

/** A minimal per-process snapshot (for the aggregator unit tests). */
function emptySnap(nodeId: string): LensSnapshot {
  return {
    meta: { generatedAt: 0, windowMs: HOUR, mode: "process", lensVersion: "test", nodeId },
    policies: [],
    guards: [],
    stats: [],
    recentDenials: [],
    recentFences: [],
  };
}

describe("mergeSnapshots", () => {
  it("merges per-node snapshots additively into one fleet view", async () => {
    const s1 = await nodeSnapshot("nodeA", 5); // 2 allow, 3 rate-deny
    const s2 = await nodeSnapshot("nodeB", 4); // 2 allow, 2 rate-deny
    const merged = mergeSnapshots([s1, s2], { now: 100 });

    expect(merged.meta.mode).toBe("fleet");
    expect(merged.meta.fleetNodes).toBe(2);
    const p = merged.policies.find((x) => x.name === "checkout");
    const a = p?.analytics as AdmissionAnalyticsSnapshot;
    expect(a.allowed).toBe(4); // 2 + 2
    expect(a.denied).toBe(5); // 3 + 2
    expect(a.deniedByLane.rate).toBe(5);
    // guards are node-qualified so each node's guard is distinguishable.
    expect(merged.guards.map((g) => g.name).sort()).toEqual(["nodeA/io", "nodeB/io"]);
  });
});

describe("createLensAggregator", () => {
  it("ingests, merges live nodes, and evicts stale ones", () => {
    const clock = new ManualClock(0);
    const agg = createLensAggregator({ clock, staleMs: 1000 });
    agg.ingest(emptySnap("a"));
    clock.advance(500);
    agg.ingest(emptySnap("b"));
    expect(agg.nodes().sort()).toEqual(["a", "b"]);
    expect(agg.snapshot().meta.fleetNodes).toBe(2);

    clock.advance(600); // now 1100: 'a' (pushed at 0) is stale (>1000), 'b' (at 500) is live
    const snap = agg.snapshot();
    expect(snap.meta.fleetNodes).toBe(1);
    expect(agg.nodes()).toEqual(["b"]);
  });
});

describe("serveLensAggregator", () => {
  let agg: LensAggregator;
  let lens: RunningLens;
  beforeAll(async () => {
    agg = createLensAggregator();
    lens = await serveLensAggregator(agg, { port: 0, host: "127.0.0.1", intervalMs: 200 });
  });
  afterAll(async () => {
    await lens.close();
  });

  it("accepts an ingest POST and serves the merged snapshot", async () => {
    const post = await fetch(`${lens.url}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(emptySnap("n1")),
    });
    expect(post.status).toBe(204);
    const res = await fetch(`${lens.url}/api/snapshot`);
    const merged = await res.json();
    expect(merged.meta.mode).toBe("fleet");
    expect(merged.meta.fleetNodes).toBe(1);
  });

  it("serves the UI and rejects a PUT", async () => {
    const ui = await fetch(`${lens.url}/`);
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain("ThrottleKit");
    const put = await fetch(`${lens.url}/api/ingest`, { method: "PUT" });
    expect(put.status).toBe(405);
  });
});

describe("pushSnapshots", () => {
  it("delivers a hub's snapshot to a live aggregator", async () => {
    const agg = createLensAggregator();
    const lens = await serveLensAggregator(agg, { port: 0, host: "127.0.0.1" });
    const hub = createLensHub({ windowMs: HOUR, nodeId: "pushy" });
    hub.trackLimiter("api", rateLimit({ strategy: gcra({ limit: 5, periodMs: HOUR }) }));
    const stop = pushSnapshots(hub, { url: lens.url, intervalMs: 50 });
    await new Promise((r) => setTimeout(r, 300));
    stop();
    expect(agg.nodes()).toContain("pushy");
    expect(agg.snapshot().meta.fleetNodes).toBeGreaterThanOrEqual(1);
    await lens.close();
  });
});
