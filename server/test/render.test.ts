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
    stats: [],
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
  view: { scroll: 0, paused: false },
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
});
