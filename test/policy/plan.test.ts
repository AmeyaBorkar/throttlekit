import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/core/clock";
import { corpusFromRecordings, emptyCorpus, plan, policy, policySet } from "../../src/policy";
import { type Recording, recordLimiter } from "../../src/testkit/replay";

/**
 * Policy Plans P2 — the plan() engine (the hero). For each policy in both sets it cold-records the current
 * spec over the recorded arrivals (the baseline), replays the candidate over the same arrivals, and folds
 * the divergence into a directional flip ledger. The crown property: the flip ledger matches a
 * hand-computed expectation, and every honest state (ok / empty / truncated / not-replayable) is exercised
 * and never fabricates a number. Pure MemoryStore + ManualClock.
 */

const FW3 = { strategy: "fixedWindow", limit: 3, windowMs: 1000 } as const;
const FW5 = { strategy: "fixedWindow", limit: 5, windowMs: 1000 } as const;
const FW2 = { strategy: "fixedWindow", limit: 2, windowMs: 1000 } as const;

/** Record `n` hits on one key at a single instant against fixedWindow(limit 3) ⇒ [A×3, D×(n-3)]. */
function recordHits(n: number, opts: { maxSteps?: number } = {}): Recording {
  const rec = recordLimiter(FW3, {
    clock: new ManualClock(1000),
    ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
  });
  for (let i = 0; i < n; i++) rec.limiter.checkSync("u");
  return rec;
}

describe("plan() — the decision diff", () => {
  it("loosening (limit 3 → 5): exactly 2 deny→allow flips on the affected key", () => {
    const corpus = corpusFromRecordings({ api: recordHits(6) }); // baseline [A,A,A,D,D,D]
    const p = plan(policySet([policy("api", FW3)]), policySet([policy("api", FW5)]), corpus);

    expect(p.diffs).toHaveLength(1);
    const d = p.diffs[0];
    expect(d?.state).toBe("ok");
    expect(d?.allowToDeny).toBe(0);
    expect(d?.denyToAllow).toBe(2); // candidate [A,A,A,A,A,D] — steps 3,4 flip D→A
    expect(d?.flippedTotal).toBe(2);
    expect(d?.steps).toBe(6);
    expect(d?.affectedKeys).toBe(1);
    expect(d?.topFlippedKeys[0]).toEqual({ key: "u", allowToDeny: 0, denyToAllow: 2, total: 2 });
    // divergent (any-field diff) is broader than the flip count: `limit` shifts on every step.
    expect(d?.divergent).toBeGreaterThanOrEqual(d?.flippedTotal ?? 0);
    expect(p.summary.denyToAllow).toBe(2);
    expect(p.summary.replayable).toBe(1);
  });

  it("tightening (limit 3 → 2): 1 allow→deny flip — the blast radius", () => {
    const corpus = corpusFromRecordings({ api: recordHits(6) });
    const p = plan(policySet([policy("api", FW3)]), policySet([policy("api", FW2)]), corpus);
    const d = p.diffs[0];
    expect(d?.allowToDeny).toBe(1); // candidate [A,A,D,D,D,D] — step 2 flips A→D
    expect(d?.denyToAllow).toBe(0);
  });

  it("is deterministic — the same inputs produce an identical plan", () => {
    const cur = policySet([policy("api", FW3)]);
    const cand = policySet([policy("api", FW5)]);
    const a = plan(cur, cand, corpusFromRecordings({ api: recordHits(6) }));
    const b = plan(cur, cand, corpusFromRecordings({ api: recordHits(6) }));
    expect(a).toEqual(b);
  });

  it("empty: a policy with no recorded traffic is honestly empty, never a fabricated zero", () => {
    const p = plan(policySet([policy("api", FW3)]), policySet([policy("api", FW5)]), emptyCorpus());
    expect(p.diffs[0]?.state).toBe("empty");
    expect(p.diffs[0]?.flippedTotal).toBe(0);
    expect(p.summary.replayable).toBe(0);
  });

  it("truncated: a capped corpus diffs the prefix and flags it", () => {
    const corpus = corpusFromRecordings({ api: recordHits(6, { maxSteps: 3 }) }); // prefix [A,A,A]
    const p = plan(policySet([policy("api", FW3)]), policySet([policy("api", FW2)]), corpus);
    const d = p.diffs[0];
    expect(d?.state).toBe("truncated");
    expect(d?.allowToDeny).toBe(1); // over the prefix, limit 2 denies the 3rd
    expect(p.corpus.truncated).toBe(true);
  });

  it("not-replayable: a declared non-rate axis is surfaced, not omitted", () => {
    const u = [{ name: "workers", reason: "concurrency axis (releases are not decisions)" }];
    const p = plan(
      policySet([policy("api", FW3)], { unreplayable: u }),
      policySet([policy("api", FW5)], { unreplayable: u }),
      corpusFromRecordings({ api: recordHits(6) }),
    );
    const workers = p.diffs.find((d) => d.policy === "workers");
    expect(workers?.state).toBe("not-replayable");
    expect(workers?.refusal?.reason).toBe("not-replayable");
  });

  it("structural: reports added / removed policies in the summary", () => {
    const cur = policySet([policy("api", FW3), policy("old", FW3)]);
    const cand = policySet([policy("api", FW3), policy("new", FW5)]);
    const p = plan(cur, cand, emptyCorpus());
    expect(p.summary.added).toEqual(["new"]);
    expect(p.summary.removed).toEqual(["old"]);
    // only policies present in BOTH sets get a diff row
    expect(p.diffs.map((d) => d.policy)).toEqual(["api"]);
  });
});
