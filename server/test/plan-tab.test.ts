import { describe, expect, it } from "vitest";
import { type RenderOptions, renderFrame } from "../src/monitor/render.js";
import type { LensPlanSnapshot, LensSnapshot } from "../src/monitor/types.js";
import { corpusFromShadow } from "../src/policy/corpus.js";
import type { Shadow } from "../src/replay/shadow.js";

/**
 * Policy Plans P6 (#312): the TUI Plan tab — a whole-config "terraform plan for limits" rendered on demand
 * (the `P` key) against the live shadow corpus. Pure-render coverage (mirrors the Replay-tab test: the
 * rows×cols invariant + the honest states) plus the `corpusFromShadow` adapter that feeds it.
 */

const planOpts = (cols: number, rows: number): RenderOptions => ({
  cols,
  rows,
  now: 1_700_000_010_000,
  denyHistory: [],
  color: false,
  view: { scroll: 0, paused: false, tab: "plan" },
});

const snapWithPlan = (plan: LensPlanSnapshot | undefined): LensSnapshot => ({
  meta: { generatedAt: 1_700_000_010_000, windowMs: 60_000, mode: "process", lensVersion: "t" },
  policies: [],
  guards: [],
  stats: [],
  recentDenials: [],
  recentFences: [],
  ...(plan !== undefined ? { plan } : {}),
});

type PlanLast = NonNullable<LensPlanSnapshot["last"]>;
const lastOk = (over: Partial<PlanLast> = {}): PlanLast => ({
  ok: true,
  ranAt: 1_700_000_000_000, // 10s before meta.generatedAt above
  corpusSteps: 18,
  corpusPolicies: 2,
  truncated: false,
  allowToDeny: 3,
  denyToAllow: 1,
  affectedKeys: 2,
  replayable: 2,
  policies: 2,
  diffs: [
    { policy: "api", state: "ok", allowToDeny: 3, denyToAllow: 0, steps: 12 },
    { policy: "search", state: "ok", allowToDeny: 0, denyToAllow: 1, steps: 6 },
  ],
  ...over,
});

const enabledPlan = (over: Partial<LensPlanSnapshot> = {}): LensPlanSnapshot => ({
  enabled: true,
  candidateLabel: "candidate.yaml",
  ...over,
});

describe("renderFrame — Plan tab", () => {
  it("renders exactly `rows`×`cols` for the plan tab at any size and state", () => {
    const states: (LensPlanSnapshot | undefined)[] = [
      enabledPlan({ last: lastOk() }),
      enabledPlan({ last: lastOk({ truncated: true }) }),
      enabledPlan({
        last: lastOk({
          diffs: [
            { policy: "api", state: "ok", allowToDeny: 3, denyToAllow: 0, steps: 12 },
            { policy: "esc", state: "not-replayable", allowToDeny: 0, denyToAllow: 0, steps: 0 },
            { policy: "empty", state: "empty", allowToDeny: 0, denyToAllow: 0, steps: 0 },
          ],
        }),
      }),
      enabledPlan({
        last: { ...lastOk(), ok: false, error: "candidate config is missing a limiters map" },
      }),
      enabledPlan(), // no last yet
      { enabled: false, off: "no-candidate" },
      { enabled: false, off: "no-shadows" },
      undefined,
    ];
    for (const cols of [40, 80, 120] as const) {
      for (const rows of [10, 24] as const) {
        for (const p of states) {
          const frame = renderFrame(snapWithPlan(p), planOpts(cols, rows));
          expect(frame).toHaveLength(rows);
          for (const line of frame) expect(line.length).toBe(cols);
        }
      }
    }
  });

  it("shows the whole-config flip ledger + honest footer for an ok plan", () => {
    const joined = renderFrame(
      snapWithPlan(enabledPlan({ last: lastOk() })),
      planOpts(110, 24),
    ).join("\n");
    expect(joined).toContain("3 newly DENIED");
    expect(joined).toContain("1 newly ALLOWED");
    expect(joined).toContain("2/2 replayable");
    expect(joined).toContain("api"); // per-policy rows
    expect(joined).toContain("search");
    expect(joined).toContain("candidate.yaml"); // the candidate label
    expect(joined).toContain("ran 10s ago"); // generatedAt − ranAt = 10_000ms
    expect(joined).toContain("not production's exact decisions"); // the honest non-claim footer
  });

  it("flags a truncated corpus (the diff understates)", () => {
    const joined = renderFrame(
      snapWithPlan(enabledPlan({ last: lastOk({ truncated: true }) })),
      planOpts(110, 24),
    ).join("\n");
    expect(joined).toContain("TRUNCATED");
  });

  it("renders honest per-policy states (not-replayable / no traffic), never a fabricated zero", () => {
    const joined = renderFrame(
      snapWithPlan(
        enabledPlan({
          last: lastOk({
            diffs: [
              { policy: "esc", state: "not-replayable", allowToDeny: 0, denyToAllow: 0, steps: 0 },
              { policy: "quiet", state: "empty", allowToDeny: 0, denyToAllow: 0, steps: 0 },
            ],
          }),
        }),
      ),
      planOpts(110, 24),
    ).join("\n");
    expect(joined).toContain("not replayable");
    expect(joined).toContain("no recorded traffic");
  });

  it("shows an honest off-placeholder (no candidate vs no shadows)", () => {
    const noCandidate = renderFrame(
      snapWithPlan({ enabled: false, off: "no-candidate" }),
      planOpts(90, 24),
    ).join("\n");
    expect(noCandidate).toContain("--plan-candidate");

    const noShadows = renderFrame(
      snapWithPlan({ enabled: false, off: "no-shadows" }),
      planOpts(90, 24),
    ).join("\n");
    expect(noShadows).toContain("deterministic capture off");

    // Absent entirely ⇒ still an honest placeholder, never a crash or a faked panel.
    const absent = renderFrame(snapWithPlan(undefined), planOpts(80, 20));
    expect(absent).toHaveLength(20);
    expect(absent.join("\n")).toContain("capture off");
  });

  it("prompts to press P when enabled with no plan yet, and shows a build error honestly", () => {
    const prompt = renderFrame(snapWithPlan(enabledPlan()), planOpts(90, 24)).join("\n");
    expect(prompt).toContain("press");
    expect(prompt).toContain("P");

    const errored = renderFrame(
      snapWithPlan(
        enabledPlan({ last: { ...lastOk(), ok: false, error: "bad candidate config" } }),
      ),
      planOpts(90, 24),
    ).join("\n");
    expect(errored).toContain("error");
    expect(errored).toContain("bad candidate config");
  });
});

// ---- corpusFromShadow: build the live-shadow corpus, skipping poisoned + empty shadows ----

function fakeShadow(
  steps: ReadonlyArray<{ key: string; at: number; cost?: number }>,
  opts: { poisoned?: boolean; truncated?: boolean } = {},
): Shadow {
  return {
    feed: () => {},
    trace: () => ({
      version: 1,
      fingerprint: {},
      redacted: false,
      truncated: opts.truncated ?? false,
      dropped: 0,
      steps: steps.map((s) => ({
        key: s.key,
        cost: s.cost ?? 1,
        at: s.at,
        decision: { allowed: true, limit: 0, remaining: 0, resetAt: 0, retryAfterMs: 0 },
      })),
    }),
    steps: steps.length,
    truncated: opts.truncated ?? false,
    poisoned: opts.poisoned ?? false,
  } as unknown as Shadow;
}

describe("corpusFromShadow", () => {
  it("builds a corpus from shadowed policies and reports empty + poisoned ones", () => {
    const shadows = new Map<string, Shadow>([
      [
        "api",
        fakeShadow([
          { key: "a", at: 1 },
          { key: "a", at: 2 },
          { key: "b", at: 3 },
        ]),
      ],
      ["quiet", fakeShadow([])], // recorded nothing yet
      ["bad", fakeShadow([{ key: "x", at: 1 }], { poisoned: true })], // unreliable trace
    ]);
    const { corpus, empty, poisoned } = corpusFromShadow(shadows);
    expect(Object.keys(corpus)).toEqual(["api"]); // only the policy with real traffic
    expect(corpus.api.arrivals).toHaveLength(3);
    expect(corpus.api.arrivals[0]).toEqual({ key: "a", cost: 1, at: 1 });
    expect(empty).toEqual(["quiet"]);
    expect(poisoned).toEqual(["bad"]);
  });

  it("propagates a truncated shadow's flag into the corpus (the diff then understates)", () => {
    const shadows = new Map<string, Shadow>([
      ["api", fakeShadow([{ key: "a", at: 1 }], { truncated: true })],
    ]);
    const { corpus } = corpusFromShadow(shadows);
    expect(corpus.api.truncated).toBe(true);
  });

  it("returns an empty corpus when no shadow has traffic", () => {
    const { corpus, empty } = corpusFromShadow(new Map<string, Shadow>([["api", fakeShadow([])]]));
    expect(Object.keys(corpus)).toHaveLength(0);
    expect(empty).toEqual(["api"]);
  });
});
