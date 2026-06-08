import { describe, expect, it } from "vitest";
import { ManualClock } from "../../../src/core/clock";
import {
  type CandidateOp,
  DEFAULT_REDUCERS,
  ReplayRefusedError,
  type ReplayTrace,
  type SpecPath,
  allowRate,
  candidate,
  candidateField,
  denyCount,
  quantile,
  rankByFlips,
  recordLimiter,
  remainingP50,
  replay,
  resolveCandidate,
  retryP99,
  scale,
  scorecard,
  set,
  swap,
} from "../../../src/testkit/replay";

/**
 * #281 What-If Replay — P2 (#288): the candidate-compare DSL (`set`/`scale`/`swap`) and the
 * multi-candidate `scorecard`. A pure orchestration layer over the P1 `replay()`: no engine change.
 *
 * The crown property is that the scorecard's exact headline — directional admit/deny flips vs the
 * recording — matches a hand-computed expectation, that an ill-formed or unbuildable candidate becomes a
 * loud `refused` row (never a silent zero), and that strategy-specific columns are flagged not-comparable
 * across a strategy change. Pure MemoryStore + ManualClock.
 */

/** fixedWindow(limit, 1000ms): N checks on one key at a single instant ⇒ [A×limit, D×(N-limit)]. */
function recordFixed(limit: number, n: number): ReplayTrace {
  const rec = recordLimiter(
    { strategy: "fixedWindow", limit, windowMs: 1000 },
    { clock: new ManualClock(1000) },
  );
  for (let i = 0; i < n; i++) rec.limiter.checkSync("u");
  return rec.trace();
}

describe("replay P2 — candidate DSL (delta algebra)", () => {
  const trace = recordFixed(3, 6); // base spec: fixedWindow limit 3

  it("set overrides one field; classed comparable when the strategy is unchanged", () => {
    const { spec, class: klass } = resolveCandidate(trace, candidate("hi", set("limit", 9)));
    expect(spec).toEqual({ strategy: "fixedWindow", limit: 9, windowMs: 1000 });
    expect(klass).toBe("comparable");
  });

  it("scale resolves against the BASE value (exact multiplication)", () => {
    const { spec } = resolveCandidate(trace, candidate("x2", scale("limit", 2)));
    expect(spec.limit).toBe(6);
    // Non-integer factors are exact, not rounded.
    const half = resolveCandidate(trace, candidate("x.5", scale("limit", 0.5)));
    expect(half.spec.limit).toBe(1.5);
  });

  it("swap changes the strategy ⇒ cross-strategy, carrying the supplied fields", () => {
    const { spec, class: klass } = resolveCandidate(
      trace,
      candidate("to-sliding", swap("slidingWindow", { buckets: 4 })),
    );
    expect(spec.strategy).toBe("slidingWindow");
    expect(spec.buckets).toBe(4);
    expect(spec.limit).toBe(3); // base field retained
    expect(klass).toBe("cross-strategy");
  });

  it("classification is by OUTCOME: a set() of strategy is also cross-strategy", () => {
    const { class: klass } = resolveCandidate(
      trace,
      candidate("via-set", set("strategy", "slidingWindow")),
    );
    expect(klass).toBe("cross-strategy");
  });

  it("a no-op delta (field already equals value) is comparable and zero-divergent", () => {
    const { class: klass } = resolveCandidate(trace, candidate("noop", set("limit", 3)));
    expect(klass).toBe("comparable");
    const r = replay(trace, { candidate: candidateField(trace, "limit", 3) });
    expect(r.divergence.divergent).toBe(0);
  });

  it("refuses more than one op on a field (compounding is ambiguous)", () => {
    expect(() =>
      resolveCandidate(trace, candidate("dup", set("limit", 5), set("limit", 7))),
    ).toThrow(ReplayRefusedError);
    try {
      resolveCandidate(trace, candidate("dup", scale("limit", 2), set("limit", 7)));
    } catch (e) {
      expect((e as ReplayRefusedError).reason).toBe("candidate-invalid");
      expect((e as Error).message).toMatch(/more than one op/);
    }
  });

  it("refuses an unknown field from an untyped caller (fail-fast, not a silent no-op)", () => {
    const badOp = { kind: "set", path: "bogus" as unknown as SpecPath, value: 1 } as CandidateOp;
    try {
      resolveCandidate(trace, candidate("typo", badOp));
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ReplayRefusedError);
      expect((e as ReplayRefusedError).reason).toBe("candidate-invalid");
      expect((e as Error).message).toMatch(/unknown field/);
    }
  });

  it("refuses scale over a non-numeric / absent base value", () => {
    // base fixedWindow has no `burst` ⇒ scale has nothing numeric to multiply.
    try {
      resolveCandidate(trace, candidate("bad-scale", scale("burst", 2)));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ReplayRefusedError).reason).toBe("candidate-invalid");
      expect((e as Error).message).toMatch(/finite numeric base/);
    }
  });

  it("refuses a non-finite scale factor", () => {
    expect(() =>
      resolveCandidate(trace, candidate("inf", scale("limit", Number.POSITIVE_INFINITY))),
    ).toThrow(/factor must be finite/);
  });

  it("refuses a windowMs/periodMs delta when the spec uses `period` (it would silently not apply)", () => {
    // Base spec written with `period` (a duration string) — `period` shadows windowMs/periodMs in the
    // builder, so a delta targeting them would silently not take effect.
    const rec = recordLimiter(
      { strategy: "fixedWindow", limit: 3, period: "1s" },
      { clock: new ManualClock(1000) },
    );
    rec.limiter.checkSync("u");
    const periodTrace = rec.trace();
    try {
      resolveCandidate(periodTrace, candidate("set-window", set("windowMs", 500)));
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ReplayRefusedError);
      expect((e as ReplayRefusedError).reason).toBe("candidate-invalid");
      expect((e as Error).message).toMatch(/period.*takes precedence/i);
    }
    // When the base uses windowMs (no period), the same field is a valid target.
    expect(() =>
      resolveCandidate(recordFixed(3, 1), candidate("ok", set("windowMs", 500))),
    ).not.toThrow();
  });
});

describe("replay P2 — score reducers", () => {
  it("quantile is exact nearest-rank", () => {
    expect(quantile([], 0.5)).toBe(0);
    expect(quantile([0, 1, 2, 3, 4], 0.5)).toBe(2);
    expect(quantile([0, 1, 2, 3, 4], 0.99)).toBe(4);
    expect(quantile([10], 0.5)).toBe(10);
  });

  it("admit/deny reducers count exactly; tagged comparable across any strategy", () => {
    const trace = recordFixed(3, 6); // [A,A,A,D,D,D]
    const decisions = trace.steps.map((s) => s.decision);
    expect(allowRate.reduce(decisions)).toBe(0.5);
    expect(denyCount.reduce(decisions)).toBe(3);
    expect(allowRate.comparableAcross).toBe("any");
  });

  it("retry/remaining reducers are tagged same-strategy (strategy-specific semantics)", () => {
    expect(retryP99.comparableAcross).toBe("same-strategy");
    expect(remainingP50.comparableAcross).toBe("same-strategy");
    expect(DEFAULT_REDUCERS.every((r) => r.kind === "exact")).toBe(true);
  });
});

describe("replay P2 — scorecard (multi-candidate compare)", () => {
  // recorded: fixedWindow limit 3, 6 reqs at one instant ⇒ [A,A,A,D,D,D] (allow 3, deny 3).
  const trace = recordFixed(3, 6);

  it("baseline columns are scored over the recorded decisions", () => {
    const card = scorecard(trace, []);
    const byId = Object.fromEntries(card.baseline.columns.map((c) => [c.id, c.value]));
    expect(byId["allow-count"]).toBe(3);
    expect(byId["deny-count"]).toBe(3);
    expect(byId["allow-rate"]).toBe(0.5);
    expect(card.rows).toHaveLength(0);
  });

  it("directional flips match a hand-computed what-if", () => {
    const card = scorecard(trace, [
      candidate("loosen-to-5", set("limit", 5)), // [A,A,A,A,A,D] ⇒ 2 deny→allow
      candidate("loosen-x2", scale("limit", 2)), // limit 6 ⇒ [A×6]     ⇒ 3 deny→allow
      candidate("tighten-to-2", set("limit", 2)), // [A,A,D,D,D,D]      ⇒ 1 allow→deny
      candidate("tighten-to-1", set("limit", 1)), // [A,D,D,D,D,D]      ⇒ 2 allow→deny
    ]);
    const byName = Object.fromEntries(card.rows.map((r) => [r.name, r]));

    expect(byName["loosen-to-5"]?.flips).toEqual({
      allowedToDenied: 0,
      deniedToAllowed: 2,
      total: 2,
    });
    expect(byName["loosen-x2"]?.flips).toEqual({
      allowedToDenied: 0,
      deniedToAllowed: 3,
      total: 3,
    });
    expect(byName["tighten-to-2"]?.flips).toEqual({
      allowedToDenied: 1,
      deniedToAllowed: 0,
      total: 1,
    });
    expect(byName["tighten-to-1"]?.flips).toEqual({
      allowedToDenied: 2,
      deniedToAllowed: 0,
      total: 2,
    });
    // Every row here keeps the strategy ⇒ comparable, all columns rankable.
    for (const r of card.rows) {
      expect(r.status).toBe("ok");
      expect(r.class).toBe("comparable");
      expect(r.columns.every((c) => c.comparable)).toBe(true);
    }
  });

  it("scored columns over the candidate's decisions are exact (loosen-to-5)", () => {
    const card = scorecard(trace, [candidate("loosen-to-5", set("limit", 5))]);
    const row = card.rows[0];
    const byId = Object.fromEntries((row?.columns ?? []).map((c) => [c.id, c.value]));
    expect(byId["allow-count"]).toBe(5); // [A,A,A,A,A,D]
    expect(byId["deny-count"]).toBe(1);
  });

  it("a cross-strategy row flags strategy-specific columns not-comparable, admit/deny still comparable", () => {
    const card = scorecard(trace, [candidate("to-sliding", swap("slidingWindow", { buckets: 4 }))]);
    const row = card.rows[0];
    expect(row?.class).toBe("cross-strategy");
    expect(row?.status).toBe("ok");
    // slidingWindow at one instant with limit 3 ⇒ same [A,A,A,D,D,D] ⇒ zero flips.
    expect(row?.flips?.total).toBe(0);
    const col = Object.fromEntries((row?.columns ?? []).map((c) => [c.id, c.comparable]));
    expect(col["allow-rate"]).toBe(true); // any-strategy
    expect(col["deny-count"]).toBe(true); // any-strategy
    expect(col["retry-p99-ms"]).toBe(false); // same-strategy ⇒ not comparable across a swap
    expect(col["remaining-p50"]).toBe(false);
  });

  it("an unbuildable candidate (swap missing required fields) is a LOUD refused row, not a silent zero", () => {
    const card = scorecard(trace, [
      candidate("ok", set("limit", 5)),
      candidate("broken", swap("tokenBucket")), // needs capacity + refillPerSec
    ]);
    const broken = card.rows.find((r) => r.name === "broken");
    expect(broken?.status).toBe("refused");
    expect(broken?.class).toBe("cross-strategy");
    expect(broken?.refusal?.reason).toBe("candidate-invalid");
    expect(broken?.refusal?.message).toMatch(/capacity/);
    expect(broken?.flips).toBeUndefined(); // NOT a fabricated zero
    expect(broken?.columns).toHaveLength(0);
    // One bad candidate does not sink the batch.
    expect(card.rows.find((r) => r.name === "ok")?.status).toBe("ok");
  });

  it("an ill-formed delta refuses at resolve time (no spec), still failure-isolated", () => {
    const card = scorecard(trace, [
      candidate("dup", set("limit", 5), set("limit", 7)),
      candidate("good", set("limit", 4)),
    ]);
    const dup = card.rows.find((r) => r.name === "dup");
    expect(dup?.status).toBe("refused");
    expect(dup?.refusal?.reason).toBe("candidate-invalid");
    expect(dup?.spec).toBeUndefined();
    expect(card.rows.find((r) => r.name === "good")?.status).toBe("ok");
  });

  it("a resolve-time refusal still carries an honest comparability class (a failed swap is cross-strategy)", () => {
    // A swap whose `fields` carry an unknown key fails at RESOLVE — but its intent is a strategy change.
    const badSwap = {
      kind: "swap",
      strategy: "slidingWindow",
      fields: { bogus: 1 },
    } as unknown as CandidateOp;
    const card = scorecard(trace, [candidate("bad-swap", badSwap)]);
    const row = card.rows[0];
    expect(row?.status).toBe("refused");
    expect(row?.refusal?.reason).toBe("candidate-invalid");
    expect(row?.class).toBe("cross-strategy"); // not mislabelled "comparable"
  });

  it("rankByFlips orders ok rows by most behavioural change first; omits refused", () => {
    const card = scorecard(trace, [
      candidate("x2", scale("limit", 2)), // 3 flips
      candidate("to-5", set("limit", 5)), // 2 flips
      candidate("to-2", set("limit", 2)), // 1 flip
      candidate("broken", swap("tokenBucket")), // refused
    ]);
    const ranked = rankByFlips(card);
    expect(ranked.map((r) => r.name)).toEqual(["x2", "to-5", "to-2"]);
    expect(ranked.map((r) => r.flips?.total)).toEqual([3, 2, 1]);
  });

  it("refuses the whole card (throws) on a trace-level fault — not a per-candidate refusal", () => {
    // Force truncation: record 5 steps with a cap of 3.
    const rec = recordLimiter(
      { strategy: "fixedWindow", limit: 3, windowMs: 1000 },
      { clock: new ManualClock(1000), maxSteps: 3 },
    );
    for (let i = 0; i < 5; i++) rec.limiter.checkSync("u");
    const truncated = rec.trace();
    expect(truncated.truncated).toBe(true);
    try {
      scorecard(truncated, [candidate("x", set("limit", 9))]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ReplayRefusedError);
      expect((e as ReplayRefusedError).reason).toBe("trace-truncated");
    }
  });
});
