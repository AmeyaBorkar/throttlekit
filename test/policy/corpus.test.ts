import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/core/clock";
import { arrivalsFromTrace, corpusFromRecordings, corpusFromTraces } from "../../src/policy";
import { recordLimiter } from "../../src/testkit/replay";

/**
 * Policy Plans P3 — corpus adapters. A corpus is fundamentally an arrival stream `(key, cost, at)` grouped
 * by policy name; the adapters extract it from recordings / traces and preserve the truncation flag (so a
 * capped source understates honestly rather than silently).
 */

function recordHits(n: number, opts: { maxSteps?: number } = {}) {
  const rec = recordLimiter(
    { strategy: "fixedWindow", limit: 3, windowMs: 1000 },
    {
      clock: new ManualClock(1000),
      ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
    },
  );
  for (let i = 0; i < n; i++) rec.limiter.checkSync("u");
  return rec;
}

describe("corpus adapters", () => {
  it("arrivalsFromTrace extracts (key, cost, at)", () => {
    const arrivals = arrivalsFromTrace(recordHits(3).trace());
    expect(arrivals).toHaveLength(3);
    expect(arrivals[0]).toEqual({ key: "u", cost: 1, at: 1000 });
  });

  it("corpusFromRecordings groups + counts traces", () => {
    const corpus = corpusFromRecordings({ api: recordHits(4) });
    expect(corpus.api?.arrivals).toHaveLength(4);
    expect(corpus.api?.traces).toBe(1);
    expect(corpus.api?.truncated).toBe(false);
  });

  it("corpusFromTraces concatenates an array of traces for one policy", () => {
    const corpus = corpusFromTraces({ api: [recordHits(2).trace(), recordHits(3).trace()] });
    expect(corpus.api?.arrivals).toHaveLength(5);
    expect(corpus.api?.traces).toBe(2);
  });

  it("propagates the truncation flag from a capped source", () => {
    const corpus = corpusFromRecordings({ api: recordHits(6, { maxSteps: 3 }) });
    expect(corpus.api?.arrivals).toHaveLength(3); // a faithful prefix
    expect(corpus.api?.truncated).toBe(true);
  });
});
