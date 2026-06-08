import { describe, expect, it } from "vitest";
import { type LimiterSpec, buildStrategy } from "../../../src/config";
import { ManualClock } from "../../../src/core/clock";
import {
  type ReplayFingerprint,
  type ReplayRefusal,
  ReplayRefusedError,
  type ReplayTrace,
  TRACE_FORMAT_VERSION,
  assertReplayable,
  assertReplayableTrace,
  candidateField,
  fingerprint,
  parseTrace,
  rebuildLimiter,
  recordLimiter,
  replay,
  serializeTrace,
} from "../../../src/testkit/replay";

/**
 * #281 What-If Replay — P1 (#287): the fail-loud guard taxonomy. Every way a trace/spec can be
 * un-replayable (design §4.5) must be REFUSED with a distinct, machine-readable `ReplayRefusal` —
 * replay never silently produces a misleading result. Each case below synthesizes the hazard and
 * asserts the precise refusal.
 */

const GCRA_SPEC: LimiterSpec = { strategy: "gcra", limit: 10, periodMs: 2000, burst: 5 };

/** A correct fingerprint for GCRA_SPEC, to be tampered field-by-field. */
function baseFp(): ReplayFingerprint {
  return fingerprint({ spec: GCRA_SPEC, strategy: buildStrategy("t", GCRA_SPEC), clock: "manual" });
}

/** Assert `fn` throws a ReplayRefusedError with the given reason. */
function expectRefusal(fn: () => unknown, reason: ReplayRefusal): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ReplayRefusedError);
    expect((e as ReplayRefusedError).reason).toBe(reason);
    return;
  }
  throw new Error(`expected a ReplayRefusedError(${reason}) but nothing was thrown`);
}

describe("replay P1 — guard refusals (the fail-loud taxonomy)", () => {
  it("refuses a recording over the system clock", () => {
    expectRefusal(() => assertReplayable({ ...baseFp(), clock: "system" }), "non-manual-clock");
  });

  it("refuses a recording over a server (Redis TIME) clock", () => {
    expectRefusal(() => assertReplayable({ ...baseFp(), clock: "server" }), "non-manual-clock");
  });

  it("refuses a Lua-SHA-1 mismatch (the rebuilt strategy is not the one that produced the trace)", () => {
    const realStrategy = buildStrategy("t", GCRA_SPEC);
    expectRefusal(
      () =>
        assertReplayable(
          { ...baseFp(), luaSha1: "0000000000000000000000000000000000000000" },
          realStrategy,
        ),
      "lua-sha1-mismatch",
    );
  });

  it("refuses a strategy-identity mismatch (composite / mislabelled trace)", () => {
    const other = buildStrategy("t", { strategy: "fixedWindow", limit: 6, windowMs: 1000 });
    expectRefusal(() => assertReplayable(baseFp(), other), "strategy-mismatch");
  });

  it("refuses a non-rate axis (concurrency: releases are not decisions)", () => {
    expectRefusal(
      () => assertReplayable({ ...baseFp(), axis: "concurrency" as unknown as "rate" }),
      "unreplayable-axis",
    );
  });

  it("refuses a joint-LP admission policy (a bid-price filter, not a leaf decision)", () => {
    expectRefusal(
      () => assertReplayable({ ...baseFp(), policy: "joint-lp" }),
      "unreplayable-policy",
    );
  });

  it("refuses an unrebuildable strategy (e.g. leakyBucket — no spec form)", () => {
    const fp = { ...baseFp(), spec: { strategy: "leakyBucket" } as unknown as LimiterSpec };
    expectRefusal(() => assertReplayable(fp), "unrebuildable-strategy");
    expectRefusal(
      () =>
        rebuildLimiter({ strategy: "leakyBucket" } as unknown as LimiterSpec, {
          clock: new ManualClock(0),
        }),
      "unrebuildable-strategy",
    );
  });

  it("refuses a truncated trace", () => {
    const trace: ReplayTrace = {
      version: TRACE_FORMAT_VERSION,
      fingerprint: baseFp(),
      redacted: false,
      truncated: true,
      dropped: 2,
      steps: [
        {
          key: "k",
          cost: 1,
          at: 0,
          decision: { allowed: true, limit: 10, remaining: 9, resetAt: 2000, retryAfterMs: 0 },
        },
      ],
    };
    expectRefusal(() => assertReplayableTrace(trace), "trace-truncated");
  });

  it("refuses an empty trace", () => {
    const trace: ReplayTrace = {
      version: TRACE_FORMAT_VERSION,
      fingerprint: baseFp(),
      redacted: false,
      truncated: false,
      dropped: 0,
      steps: [],
    };
    expectRefusal(() => assertReplayableTrace(trace), "trace-empty");
  });

  it("refuses a redaction hook that collides two distinct keys (state-merge hazard)", () => {
    const rec = recordLimiter(GCRA_SPEC, { clock: new ManualClock(0), redactKey: () => "same" });
    rec.limiter.checkSync("a"); // first mapping is fine
    expectRefusal(() => rec.limiter.checkSync("b"), "keyref-collision"); // distinct key, same redaction
  });
});

describe("replay P1 — trace format version gate", () => {
  it("rejects a trace from an incompatible format version", () => {
    expectRefusal(
      () => parseTrace(JSON.stringify({ version: 999, steps: [] })),
      "trace-format-version",
    );
  });

  it("rejects non-JSON and non-object input", () => {
    expectRefusal(() => parseTrace("{ not json"), "trace-format-version");
    expectRefusal(() => parseTrace("[]"), "trace-format-version");
  });

  it("accepts the current version and round-trips", () => {
    const rec = recordLimiter(GCRA_SPEC, { clock: new ManualClock(0) });
    rec.limiter.checkSync("k");
    const parsed = parseTrace(serializeTrace(rec.trace()));
    expect(parsed.version).toBe(TRACE_FORMAT_VERSION);
    expect(parsed.steps.length).toBe(1);
  });
});

describe("replay P1 — structural validation of untrusted traces (the trust boundary)", () => {
  // A serialized/transmitted/hand-built trace is untrusted input. Without structural validation a
  // version-1 trace with a non-array `steps` reads `steps.length === undefined`, slips past the
  // empty/loop guards, and yields a misleading "zero divergence" PASS (and a fabricated flipped:0
  // what-if) instead of a refusal. These cases were surfaced by an adversarial review.
  const validStep = {
    key: "k",
    cost: 1,
    at: 0,
    decision: { allowed: true, limit: 10, remaining: 9, resetAt: 2000, retryAfterMs: 0 },
  };
  function trace(over: Record<string, unknown>): ReplayTrace {
    return {
      version: TRACE_FORMAT_VERSION,
      fingerprint: baseFp(),
      redacted: false,
      truncated: false,
      dropped: 0,
      steps: [validStep],
      ...over,
    } as unknown as ReplayTrace;
  }

  it("refuses a non-array steps instead of silently reporting zero divergence (CRITICAL)", () => {
    const bad = trace({ steps: {} });
    expectRefusal(() => replay(bad), "trace-malformed");
    // ...and the candidate (what-if) path must not fabricate a flipped:0 result either
    expectRefusal(
      () => replay(bad, { candidate: candidateField(bad, "limit", 1) }),
      "trace-malformed",
    );
  });

  it("refuses a forged array-like steps with a numeric length but no entries", () => {
    expectRefusal(() => replay(trace({ steps: { length: 3 } })), "trace-malformed");
  });

  it("refuses a trace that dropped steps even if its truncated flag is false", () => {
    expectRefusal(() => replay(trace({ truncated: false, dropped: 99 })), "trace-truncated");
  });

  it("refuses a missing steps or fingerprint as a refusal, not a raw TypeError", () => {
    expectRefusal(() => replay(trace({ steps: undefined })), "trace-malformed");
    expectRefusal(() => replay(trace({ fingerprint: undefined })), "trace-malformed");
  });

  it("refuses steps with degenerate timing/cost or a malformed decision", () => {
    expectRefusal(
      () => replay(trace({ steps: [{ ...validStep, at: Number.NaN }] })),
      "trace-malformed",
    );
    expectRefusal(() => replay(trace({ steps: [{ ...validStep, cost: 0 }] })), "trace-malformed");
    expectRefusal(
      () =>
        replay(
          trace({ steps: [{ ...validStep, decision: { ...validStep.decision, allowed: "yes" } }] }),
        ),
      "trace-malformed",
    );
    expectRefusal(
      () =>
        replay(
          trace({
            steps: [
              {
                ...validStep,
                decision: { ...validStep.decision, remaining: Number.POSITIVE_INFINITY },
              },
            ],
          }),
        ),
      "trace-malformed",
    );
  });

  it("parseTrace rejects a version-1 but structurally-broken trace", () => {
    expectRefusal(() => parseTrace(JSON.stringify(trace({ steps: {} }))), "trace-malformed");
  });
});

describe("replay P1 — rebuild via buildStrategy (the single source of truth)", () => {
  it("rebuilds the quota-rolling alias to its sliding-window behaviour", () => {
    const clock = new ManualClock(0);
    const limiter = rebuildLimiter(
      { strategy: "quota", limit: 3, resetCadence: "rolling", periodMs: 1000, buckets: 4 },
      { clock },
    );
    expect(limiter.checkSync("k").allowed).toBe(true);
    expect(limiter.checkSync("k").allowed).toBe(true);
    expect(limiter.checkSync("k").allowed).toBe(true);
    expect(limiter.checkSync("k").allowed).toBe(false); // 4th in the window is denied
  });

  it("rebuilds each spec-buildable strategy and enforces its limit deterministically", () => {
    const specs: LimiterSpec[] = [
      { strategy: "gcra", limit: 2, periodMs: 1000, burst: 2 },
      { strategy: "tokenBucket", capacity: 2, refillPerSec: 1 },
      { strategy: "fixedWindow", limit: 2, windowMs: 1000 },
      { strategy: "slidingWindow", limit: 2, windowMs: 1000, buckets: 4 },
      { strategy: "slidingWindowLog", limit: 2, windowMs: 1000 },
      { strategy: "quota", limit: 2, resetCadence: "fixed", periodMs: 1000 },
    ];
    for (const spec of specs) {
      const limiter = rebuildLimiter(spec, { clock: new ManualClock(0) });
      expect(limiter.checkSync("k").allowed).toBe(true);
      expect(limiter.checkSync("k").allowed).toBe(true);
      expect(limiter.checkSync("k").allowed).toBe(false); // the 3rd exceeds limit/capacity 2
    }
  });
});
