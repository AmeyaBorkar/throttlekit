import type { AdmissionAnalyticsSnapshot, AnalyticsSnapshot } from "throttlekit";
import { describe, expect, it } from "vitest";
import { type RenderOptions, renderFrame } from "../src/monitor/render.js";
import type { LensSnapshot } from "../src/monitor/types.js";

function limiterAnalytics(
  allowed: number,
  denied: number,
  topDenied: { key: string; count: number }[] = [],
): AnalyticsSnapshot {
  const total = allowed + denied;
  return {
    windowStartedAt: 0,
    windowMs: 60_000,
    allowed,
    denied,
    total,
    denyRate: total > 0 ? denied / total : 0,
    topRequested: [],
    topDenied,
  };
}

function admitterAnalytics(
  deniedByLane: Record<string, number>,
  topDenied: { key: string; count: number }[] = [],
): AdmissionAnalyticsSnapshot {
  const denied = Object.values(deniedByLane).reduce((a, b) => a + b, 0);
  return {
    windowStartedAt: 0,
    windowMs: 60_000,
    allowed: 100,
    denied,
    total: 100 + denied,
    denyRate: denied / (100 + denied),
    deniedByLane: deniedByLane as AdmissionAnalyticsSnapshot["deniedByLane"],
    topRequested: [],
    topDenied,
    topDeniedByLane: {} as AdmissionAnalyticsSnapshot["topDeniedByLane"],
  };
}

function sampleSnapshot(): LensSnapshot {
  return {
    meta: { generatedAt: 1_700_000_000_000, windowMs: 60_000, mode: "process", lensVersion: "t" },
    policies: [
      {
        name: "api",
        kind: "limiter",
        strategy: "gcra",
        analytics: limiterAnalytics(1200, 84, [
          { key: "ip-10.0.0.7", count: 96 },
          { key: "user-7", count: 40 },
        ]),
        latency: { avgMs: 0.42, p50Ms: 0.31, p99Ms: 12.5, maxMs: 48, n: 1200 },
        forecast: {
          key: "ip-10.0.0.7",
          spendableNow: 0,
          nextReplenishAt: 1_700_000_000_240, // +240ms from `now`
          fullAt: 1_700_000_001_200, // +1.2s from `now`
        },
      },
      {
        name: "unified-api",
        kind: "admitter",
        analytics: admitterAnalytics({ rate: 6, concurrency: 2, cost: 1, policy: 1 }, [
          { key: "user-42", count: 312 },
        ]),
        limit: 5,
      },
    ],
    guards: [{ name: "checkout", limit: 8, inflight: 6, rttNoload: 12, lastRtt: 14 }],
    stats: [
      {
        name: "fair-api",
        kind: "wfe",
        value: {
          windowStart: 0,
          limit: 1000,
          effectiveLimit: 1000,
          pool: 50,
          totalUsed: 950,
          tenants: [
            { tenant: "tenant-a", weight: 3, used: 800 }, // guarantee 750 → borrowed +50
            { tenant: "tenant-b", weight: 1, used: 150 }, // guarantee 250 → under
          ],
        },
      },
    ],
    recentDenials: [
      {
        at: 1_700_000_000_000,
        policy: "unified-api",
        key: "user-42",
        lane: "concurrency",
        allowed: false,
        decision: { allowed: false, limit: 5, remaining: 0, resetAt: 0, retryAfterMs: 240 },
      },
    ],
    recentFences: [],
    health: { backend: "memory", failMode: "open" },
  };
}

const baseOpts = (cols: number, rows: number): RenderOptions => ({
  cols,
  rows,
  now: 1_700_000_000_000,
  denyHistory: [1, 3, 2, 5, 8, 4],
  view: { scroll: 0, paused: false, tab: "overview" },
  color: false,
});

describe("renderFrame", () => {
  it("renders exactly `rows` lines, each exactly `cols` columns wide — at any size", () => {
    for (const [cols, rows] of [
      [40, 12],
      [80, 24],
      [120, 40],
      [24, 8], // tiny: exercises truncation + the min clamps
      [200, 50],
    ] as const) {
      const frame = renderFrame(sampleSnapshot(), baseOpts(cols, rows));
      expect(frame).toHaveLength(rows);
      for (const line of frame) {
        // color is off and the renderer uses only width-1 glyphs, so code-unit length == display width.
        expect(line.length).toBe(cols);
      }
    }
  });

  it("shows the header, every section, and the keybind status bar", () => {
    const frame = renderFrame(sampleSnapshot(), baseOpts(90, 24)).join("\n");
    expect(frame).toContain("ThrottleKit");
    expect(frame).toContain("memory");
    expect(frame).toContain("BINDING AXIS");
    expect(frame).toContain("CONCURRENCY");
    expect(frame).toContain("DENIALS (live)");
    expect(frame).toContain("quit");
  });

  it("renders the binding-axis breakdown for the unified admitter", () => {
    const frame = renderFrame(sampleSnapshot(), baseOpts(100, 24)).join("\n");
    expect(frame).toContain("unified-api");
    expect(frame).toContain("rate");
    expect(frame).toContain("concurrency");
    // rate is 6 of 10 denials → 60%.
    expect(frame).toContain("60%");
  });

  it("renders the live denial feed with the binding lane and exact numbers", () => {
    const frame = renderFrame(sampleSnapshot(), baseOpts(100, 24)).join("\n");
    expect(frame).toContain("[concurrency]");
    expect(frame).toContain("user-42");
    expect(frame).toContain("retry 240ms");
  });

  it("degrades cleanly with no policies and no denials", () => {
    const empty: LensSnapshot = {
      meta: { generatedAt: 0, windowMs: 60_000, mode: "process", lensVersion: "t" },
      policies: [],
      guards: [],
      stats: [],
      recentDenials: [],
      recentFences: [],
    };
    const frame = renderFrame(empty, baseOpts(80, 20));
    expect(frame).toHaveLength(20);
    for (const line of frame) expect(line.length).toBe(80);
    const joined = frame.join("\n");
    expect(joined).toContain("needs a unified policy");
    expect(joined).toContain("no denials yet");
  });

  it("marks the feed paused in the section header", () => {
    const opts = baseOpts(80, 20);
    opts.view.paused = true;
    expect(renderFrame(sampleSnapshot(), opts).join("\n")).toContain("DENIALS (paused)");
  });

  it("emits ANSI escapes when color is on, none when off", () => {
    const off = renderFrame(sampleSnapshot(), baseOpts(80, 20)).join("");
    expect(off).not.toContain("\x1b[");
    const opts = baseOpts(80, 20);
    opts.color = true;
    expect(renderFrame(sampleSnapshot(), opts).join("")).toContain("\x1b[");
  });

  it("renders the tab strip with every view label", () => {
    const frame = renderFrame(sampleSnapshot(), baseOpts(100, 24)).join("\n");
    for (const label of ["Overview", "Latency", "Fairness", "Capacity", "Guarantee", "Cost Room"]) {
      expect(frame).toContain(label);
    }
  });

  it("switches body by tab — a non-overview tab hides the overview sections", () => {
    const opts = baseOpts(100, 24);
    opts.view.tab = "guarantee";
    const frame = renderFrame(sampleSnapshot(), opts).join("\n");
    // The tab strip still lists every view, but the overview sections are gone — the active body changes.
    expect(frame).not.toContain("BINDING AXIS");
    expect(frame).not.toContain("DENIALS (live)");
    expect(frame).toContain("GUARANTEE");
  });

  it("renders the Latency view with per-policy avg/p50/p99 and an honest 'no samples' row", () => {
    const opts = baseOpts(100, 24);
    opts.view.tab = "latency";
    const frame = renderFrame(sampleSnapshot(), opts).join("\n");
    expect(frame).toContain("LATENCY");
    expect(frame).toContain("p99");
    expect(frame).toContain("api");
    expect(frame).toContain("12.5ms"); // api p99
    expect(frame).toContain("no samples yet"); // unified-api carries no latency in the sample
  });

  it("formats latency magnitudes at the boundary without leaking 4-digit ms (999.5 → 1.0s)", () => {
    const snap = sampleSnapshot();
    const p = snap.policies[0];
    if (p) p.latency = { avgMs: 5, p50Ms: 5, p99Ms: 999.5, maxMs: 1500, n: 10 };
    const opts = baseOpts(120, 24);
    opts.view.tab = "latency";
    const frame = renderFrame(snap, opts).join("\n");
    expect(frame).toContain("1.0s"); // 999.5 rounds up into seconds, not "1000ms"
    expect(frame).not.toContain("1000ms");
    expect(frame).toContain("1.5s"); // max 1500
  });

  it("renders the Fairness view with per-tenant guaranteed vs borrowed", () => {
    const opts = baseOpts(100, 24);
    opts.view.tab = "fairness";
    const frame = renderFrame(sampleSnapshot(), opts).join("\n");
    expect(frame).toContain("FAIRNESS");
    expect(frame).toContain("fair-api");
    expect(frame).toContain("tenant-a");
    expect(frame).toContain("+50"); // tenant-a borrowed 50 above its 750 guarantee
  });

  it("Fairness view survives a malformed wfe source without throwing (a bad row renders nothing)", () => {
    const snap = sampleSnapshot();
    snap.stats = [
      {
        name: "bad",
        kind: "wfe",
        // A non-core source could hand back garbage: a null row, negative weight/used.
        value: {
          effectiveLimit: 1000,
          totalUsed: 0,
          pool: 1000,
          tenants: [null, { tenant: "x", weight: -1, used: -5 }],
        },
      },
    ] as unknown as LensSnapshot["stats"];
    const opts = baseOpts(80, 20);
    opts.view.tab = "fairness";
    const frame = renderFrame(snap, opts); // must not throw
    expect(frame).toHaveLength(20);
    for (const line of frame) expect(line.length).toBe(80);
  });

  it("Fairness view shows an honest empty state with no wfe sources", () => {
    const snap = sampleSnapshot();
    snap.stats = [];
    const opts = baseOpts(80, 20);
    opts.view.tab = "fairness";
    const frame = renderFrame(snap, opts).join("\n");
    expect(frame).toContain("FAIRNESS");
    expect(frame).toContain("no fair-share policies");
  });

  it("renders the Capacity view with a forecast row and an n/a fallback", () => {
    const opts = baseOpts(110, 24);
    opts.view.tab = "capacity";
    const frame = renderFrame(sampleSnapshot(), opts).join("\n");
    expect(frame).toContain("CAPACITY");
    expect(frame).toContain("ip-10.0.0.7"); // api's hottest key
    expect(frame).toContain("240ms"); // next +1 in
    expect(frame).toContain("1.2s"); // full in
    expect(frame).toContain("(admitter)"); // unified-api carries no forecast
  });

  it("Capacity view labels an unavailable forecast by its reason, not a one-size-fits-all string", () => {
    const snap = sampleSnapshot();
    const p = snap.policies[0];
    if (p) {
      p.forecast = undefined;
      p.forecastUnavailable = "async";
    }
    const opts = baseOpts(110, 24);
    opts.view.tab = "capacity";
    const frame = renderFrame(snap, opts).join("\n");
    expect(frame).toContain("(async store)"); // not "(async / no traffic)"
  });

  it("renders the Guarantee view as observed node status + per-guard headroom (no proof verdict)", () => {
    const opts = baseOpts(100, 24);
    opts.view.tab = "guarantee";
    const frame = renderFrame(sampleSnapshot(), opts).join("\n");
    expect(frame).toContain("GUARANTEE");
    expect(frame).toContain("this node now");
    expect(frame).toContain("within slice"); // checkout inflight 6 <= enforced ceiling 8
    expect(frame).toContain("checkout");
    expect(frame).toContain("headroom");
    expect(frame).not.toContain("PASS"); // observed-state language, never a proof "PASS" needle
  });

  it("Guarantee view uses the ENFORCED ceiling (g.limit), not the raw share, to judge over-slice", () => {
    const snap = sampleSnapshot();
    // share 8 > limit 4, inflight 6: the enforced ceiling is 4, so inflight 6 is OVER its slice — it would
    // read "within" if the panel wrongly used `share` as the line.
    snap.guards = [
      {
        name: "g",
        limit: 4,
        inflight: 6,
        rttNoload: 1,
        lastRtt: 1,
        share: 8,
        lGlobal: 24,
        nodes: 3,
      },
    ];
    const opts = baseOpts(110, 24);
    opts.view.tab = "guarantee";
    const frame = renderFrame(snap, opts).join("\n");
    expect(frame).toContain("draining over slice");
  });

  it("Guarantee view shows a fenced guard (enforced ceiling 0) as fenced while it drains", () => {
    const snap = sampleSnapshot();
    // A real fenced guard reports limit:0 (effectiveLimit short-circuits) with a stale nonzero share.
    snap.guards = [
      {
        name: "g",
        limit: 0,
        inflight: 2,
        rttNoload: 1,
        lastRtt: 1,
        share: 4,
        lGlobal: 12,
        nodes: 3,
        fenced: true,
      },
    ];
    const opts = baseOpts(110, 24);
    opts.view.tab = "guarantee";
    const frame = renderFrame(snap, opts).join("\n");
    expect(frame).toContain("FENCED");
    expect(frame).toContain("fenced"); // the self-fence status row
    expect(frame).toContain("draining over slice"); // inflight 2 > enforced ceiling 0
  });

  it("Guarantee view shows an honest empty state with no guards", () => {
    const snap = sampleSnapshot();
    snap.guards = [];
    const opts = baseOpts(80, 20);
    opts.view.tab = "guarantee";
    const frame = renderFrame(snap, opts).join("\n");
    expect(frame).toContain("GUARANTEE");
    expect(frame).toContain("no concurrency guards");
  });

  it("keeps the exact width invariant on every tab — at any size", () => {
    for (const tab of [
      "overview",
      "latency",
      "fairness",
      "capacity",
      "guarantee",
      "cost",
    ] as const) {
      for (const [cols, rows] of [
        [40, 12],
        [80, 24],
        [24, 8],
        [200, 50],
      ] as const) {
        const opts = baseOpts(cols, rows);
        opts.view.tab = tab;
        const frame = renderFrame(sampleSnapshot(), opts);
        expect(frame).toHaveLength(rows);
        for (const line of frame) expect(line.length).toBe(cols);
      }
    }
  });
});

/** A snapshot with a populated Cost Room (#282) in varied per-tenant states. */
function costRoomSnapshot(): LensSnapshot {
  const now = 1_700_000_000_000;
  return {
    meta: { generatedAt: now, windowMs: 60_000, mode: "process", lensVersion: "t" },
    policies: [],
    guards: [],
    stats: [],
    recentDenials: [],
    recentFences: [],
    costRooms: [
      {
        policy: "budget",
        windowStart: now - 5000, // 5s into a 60s window → resets in 55s
        windowMs: 60_000,
        limit: 1_000_000,
        effectiveLimit: 1_000_000,
        pool: 260_000,
        totalUsed: 740_000,
        unit: "tokens",
        scope: "single-node",
        fairShareReliable: false,
        enforced: true,
        poolEtaToExhaustAt: now + 88_000,
        activeTenants: 40,
        tenants: [
          // borrowing past its floor; floor-ETA is beyond the window edge → clamped to the reset.
          {
            tenant: "acct-hot",
            weight: 3,
            used: 900_000,
            guaranteed: 750_000,
            borrowed: 150_000,
            burnPerSec: 3200,
            etaToExhaustAt: now + 120_000,
            etaCappedByWindow: true,
          },
          // below its floor; floor-ETA within the window → shown as ~30s.
          {
            tenant: "acct-mid",
            weight: 1,
            used: 140_000,
            guaranteed: 250_000,
            borrowed: 0,
            burnPerSec: 800,
            etaToExhaustAt: now + 30_000,
            etaCappedByWindow: false,
          },
          {
            tenant: "acct-idle",
            weight: 1,
            used: 10_000,
            guaranteed: 250_000,
            borrowed: 0,
            burnPerSec: 0,
            etaToExhaustAt: null,
            etaCappedByWindow: false,
            burnReason: "idle",
          },
          {
            tenant: "acct-warm",
            weight: 1,
            used: 5_000,
            guaranteed: 250_000,
            borrowed: 0,
            burnPerSec: null,
            etaToExhaustAt: null,
            etaCappedByWindow: false,
            burnReason: "warming",
          },
        ],
      },
    ],
  };
}

describe("renderFrame — Cost Room tab", () => {
  const costOpts = (cols: number, rows: number): RenderOptions => ({
    ...baseOpts(cols, rows),
    view: { scroll: 0, paused: false, tab: "cost" },
  });

  it("renders exactly `rows`×`cols` for the cost tab at any size, including degraded rows", () => {
    for (const [cols, rows] of [
      [40, 12],
      [80, 24],
      [120, 40],
      [24, 8],
      [200, 50],
    ] as const) {
      const frame = renderFrame(costRoomSnapshot(), costOpts(cols, rows));
      expect(frame).toHaveLength(rows);
      for (const line of frame) expect(line.length).toBe(cols);
    }
  });

  it("shows the work-conserving ledger, burn, honest ETAs, and the dark cost lane", () => {
    const frame = renderFrame(costRoomSnapshot(), costOpts(120, 30)).join("\n");
    expect(frame).toContain("COST ROOM");
    expect(frame).toContain("budget");
    expect(frame).toContain("tokens"); // declared unit echoed verbatim, not hard-coded
    expect(frame).toContain("cost lane not configured"); // dark on the server today (#291 P0)
    expect(frame).toContain("pool ETA");
    expect(frame).toContain("acct-hot");
    expect(frame).toContain("(+150k)"); // borrow surfaced explicitly, never folded into used
    expect(frame).toContain("resets"); // acct-hot's floor-ETA is past the window edge → reset clamp
    expect(frame).toContain("idle"); // acct-idle: burn 0
    expect(frame).toContain("warming"); // acct-warm: burn null
    expect(frame).toContain("+36 more"); // 40 active − 4 rendered
  });

  it("degrades to an honest empty state when no fairEscrow policy is configured", () => {
    const frame = renderFrame(sampleSnapshot(), costOpts(80, 20)); // sampleSnapshot has no costRooms
    expect(frame).toHaveLength(20);
    for (const line of frame) expect(line.length).toBe(80);
    expect(frame.join("\n")).toContain("no fairEscrow policy configured");
  });
});
