import { describe, expect, it } from "vitest";
import type { LimiterSpec } from "../../../src/config";
import { ManualClock } from "../../../src/core/clock";
import {
  ReplayRefusedError,
  type ReplayTrace,
  candidateField,
  parseTrace,
  recordLimiter,
  replay,
  serializeTrace,
} from "../../../src/testkit/replay";

/**
 * #281 What-If Replay — P1 (#287): the library recorder + replayer, the v1 deliverable.
 *
 * These tests exercise the productized form of the #286 store-invariant's final case (a fixed arrival
 * script replayed bit-identically): record a leaf limiter's synchronous decisions into a trace, then
 * replay it. The crown-jewel guarantee is the IDENTITY property — replaying the recorded spec
 * reproduces the recording bit-for-bit across every rebuildable strategy and a seeded arrival stream
 * — plus the single-field candidate (what-if) compare and the adversarial timing edges (coincident
 * and backward instants) that the absolute-`set()` drive must survive. Pure MemoryStore + ManualClock;
 * no Redis (the cross-store Lua equivalence is #286's job).
 */

/** Deterministic PRNG so any divergence is reproducible from the seed alone (mirrors the #286 gate). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE = 1_700_000_000_000;
const LEAP_BASE = 1_707_500_000_000; // ~2024-02-09, so calendar-month episodes cross the leap day
const DAY_MS = 86_400_000;

interface IdCase {
  name: string;
  spec: LimiterSpec;
  startAt: number;
  maxDelta: number;
  seed: number;
}

// The same strategies the #286 cross-store gate pins, expressed as declarative specs and driven
// through the P1 recorder. Each is rebuildable by buildStrategy.
const ID_CASES: IdCase[] = [
  {
    name: "gcra",
    spec: { strategy: "gcra", limit: 10, periodMs: 2000, burst: 5 },
    startAt: BASE,
    maxDelta: 1500,
    seed: 1,
  },
  {
    name: "tokenBucket",
    spec: { strategy: "tokenBucket", capacity: 8, refillPerSec: 4 },
    startAt: BASE,
    maxDelta: 1500,
    seed: 2,
  },
  {
    name: "fixedWindow",
    spec: { strategy: "fixedWindow", limit: 6, windowMs: 2000 },
    startAt: BASE,
    maxDelta: 800,
    seed: 3,
  },
  {
    name: "slidingWindow",
    spec: { strategy: "slidingWindow", limit: 8, windowMs: 1000, buckets: 4 },
    startAt: BASE,
    maxDelta: 600,
    seed: 4,
  },
  {
    name: "slidingWindowLog",
    spec: { strategy: "slidingWindowLog", limit: 6, windowMs: 1000 },
    startAt: BASE,
    maxDelta: 600,
    seed: 5,
  },
  {
    name: "quota-fixed",
    spec: { strategy: "quota", limit: 8, resetCadence: "fixed", periodMs: 3000, anchor: 250 },
    startAt: BASE,
    maxDelta: 1200,
    seed: 6,
  },
  {
    name: "quota-rolling",
    spec: { strategy: "quota", limit: 8, resetCadence: "rolling", periodMs: 1000, buckets: 4 },
    startAt: BASE,
    maxDelta: 500,
    seed: 7,
  },
  {
    name: "quota-month",
    spec: { strategy: "quota", limit: 12, resetCadence: "calendar-month" },
    startAt: LEAP_BASE,
    maxDelta: 5 * DAY_MS,
    seed: 8,
  },
];

const KEYS = ["a", "b", "c", "hot"];

describe("replay P1 — identity property (same config ⇒ zero divergence)", () => {
  for (const c of ID_CASES) {
    it(`${c.name}: replaying the recorded spec reproduces the recording bit-for-bit`, () => {
      const rec = recordLimiter(c.spec, { clock: new ManualClock(c.startAt), name: c.name });
      const rand = mulberry32(c.seed);
      let allowed = 0;
      let denied = 0;

      // Guaranteed denials: hammer one key past the limit at a single instant (no advance).
      for (let i = 0; i < 20; i++) {
        const d = rec.limiter.checkSync("hot", 1 + (i % 3));
        d.allowed ? allowed++ : denied++;
      }
      // Seeded arrival stream: forward jumps (refills/resets) + varied cost over a small key set.
      for (let s = 0; s < 300; s++) {
        rec.clock.advance(Math.floor(rand() * c.maxDelta));
        const cost = 1 + Math.floor(rand() * 4);
        const key = KEYS[Math.floor(rand() * KEYS.length)] as string;
        const d = rec.limiter.checkSync(key, cost);
        d.allowed ? allowed++ : denied++;
      }

      const trace = rec.trace();
      expect(trace.truncated).toBe(false);
      expect(trace.steps.length).toBe(320);

      const result = replay(trace); // identity: throws if it can't reproduce
      expect(result.isCandidate).toBe(false);
      expect(result.divergence.divergent).toBe(0);
      expect(result.divergence.flipped).toBe(0);
      expect(result.divergence.total).toBe(trace.steps.length);
      expect(result.replayed.length).toBe(trace.steps.length);

      // Anti-trivial: the stream genuinely exercised both outcomes.
      expect(allowed).toBeGreaterThan(0);
      expect(denied).toBeGreaterThan(0);
    });
  }
});

describe("replay P1 — single-field candidate (what-if) compare", () => {
  function recordWindow(): ReplayTrace {
    // 5 requests on one key in one fixed window of limit 3 ⇒ recorded [A, A, A, D, D].
    const rec = recordLimiter(
      { strategy: "fixedWindow", limit: 3, windowMs: 1000 },
      { clock: new ManualClock(1000) },
    );
    for (let i = 0; i < 5; i++) rec.limiter.checkSync("u");
    return rec.trace();
  }

  it("raising the limit flips exactly the previously-denied requests to allow", () => {
    const trace = recordWindow();
    const r = replay(trace, { candidate: candidateField(trace, "limit", 5) });
    expect(r.isCandidate).toBe(true);
    // `flipped` (the headline what-if signal) counts allow/deny changes — only the 2 denials.
    expect(r.divergence.flipped).toBe(2);
    // `divergent` is broader: changing the limit shifts the reported `limit`/`remaining` on EVERY
    // step, so all 5 differ at the field level starting at index 0. flipped ⊆ divergent.
    expect(r.divergence.divergent).toBe(5);
    expect(r.divergence.firstDivergenceIndex).toBe(0);
    expect(r.replayed.every((d) => d.allowed)).toBe(true);
  });

  it("lowering the limit flips exactly the now-excess allows to deny", () => {
    const trace = recordWindow();
    const r = replay(trace, { candidate: candidateField(trace, "limit", 1) });
    expect(r.divergence.flipped).toBe(2); // steps 1 and 2 (0-indexed) flip A→D
    expect(r.divergence.divergent).toBe(5); // every step's reported `limit` shifts 3→1
    expect(r.replayed.filter((d) => d.allowed).length).toBe(1);
  });

  it("a candidate equal to the recorded spec yields zero divergence", () => {
    const trace = recordWindow();
    const r = replay(trace, { candidate: candidateField(trace, "limit", 3) });
    expect(r.divergence.divergent).toBe(0);
  });

  it("the identity self-check runs before a candidate (a tampered trace is refused even with a candidate)", () => {
    const trace = recordWindow();
    const tampered: ReplayTrace = {
      ...trace,
      steps: trace.steps.map((s, i) =>
        i === 0 ? { ...s, decision: { ...s.decision, allowed: !s.decision.allowed } } : s,
      ),
    };
    expect(() => replay(tampered, { candidate: candidateField(trace, "limit", 5) })).toThrowError(
      ReplayRefusedError,
    );
  });
});

describe("replay P1 — adversarial timing (the absolute set() drive)", () => {
  it("coincident instants are DISTINCT steps, not a merged batch, and replay reproduces them", () => {
    const rec = recordLimiter(
      { strategy: "fixedWindow", limit: 2, windowMs: 1000 },
      { clock: new ManualClock(5000) },
    );
    rec.limiter.checkSync("k");
    rec.limiter.checkSync("k");
    rec.limiter.checkSync("k"); // no advance between any: all at == 5000
    const trace = rec.trace();

    expect(trace.steps.length).toBe(3);
    expect(trace.steps.every((s) => s.at === 5000)).toBe(true);
    expect(trace.steps.map((s) => s.decision.allowed)).toEqual([true, true, false]);
    expect(replay(trace).divergence.divergent).toBe(0);
  });

  it("checkManySync records each key as its own coincident step (a batch is N steps)", () => {
    const rec = recordLimiter(
      { strategy: "fixedWindow", limit: 5, windowMs: 1000 },
      { clock: new ManualClock(0) },
    );
    rec.limiter.checkManySync(["a", "b", "c"]);
    const trace = rec.trace();

    expect(trace.steps.length).toBe(3);
    expect(new Set(trace.steps.map((s) => s.at)).size).toBe(1);
    expect(trace.steps.map((s) => s.key)).toEqual(["a", "b", "c"]);
    expect(replay(trace).divergence.divergent).toBe(0);
  });

  it("a backward instant + a zero-delta repeat replay faithfully (set() is absolute, not cumulative)", () => {
    const clock = new ManualClock(10_000);
    const rec = recordLimiter({ strategy: "gcra", limit: 5, periodMs: 1000, burst: 5 }, { clock });
    rec.limiter.checkSync("k"); // at = 10_000
    clock.set(9_000); // backward (jump-safe algorithms)
    rec.limiter.checkSync("k"); // at = 9_000
    clock.set(9_000); // zero delta
    rec.limiter.checkSync("k"); // at = 9_000
    const trace = rec.trace();

    expect(trace.steps.map((s) => s.at)).toEqual([10_000, 9_000, 9_000]);
    const r = replay(trace);
    expect(r.divergence.divergent).toBe(0);
    // Determinism: a second replay is identical (no hidden wall-clock / random input).
    expect(replay(trace).replayed).toEqual(r.replayed);
  });
});

describe("replay P1 — non-consuming invariant", () => {
  function record(withPeeks: boolean): ReplayTrace {
    const rec = recordLimiter(
      { strategy: "fixedWindow", limit: 3, windowMs: 1000 },
      { clock: new ManualClock(1000) },
    );
    for (let i = 0; i < 6; i++) {
      if (withPeeks) {
        rec.limiter.peekSync?.("u");
        rec.limiter.forecastSync?.("u");
      }
      rec.limiter.checkSync("u");
      rec.clock.advance(100);
    }
    return rec.trace();
  }

  it("interleaved peek/forecast neither add steps nor perturb the recorded decisions", () => {
    const plain = record(false);
    const peeked = record(true);
    expect(peeked.steps.length).toBe(plain.steps.length); // peeks/forecasts are not recorded
    expect(peeked.steps).toEqual(plain.steps); // ...and never mutated state
    expect(replay(peeked).divergence.divergent).toBe(0);
  });
});

describe("replay P1 — bounded recording (tail-stop, fail-loud on replay)", () => {
  it("a trace truncated at maxSteps is flagged and refused by replay", () => {
    const rec = recordLimiter(
      { strategy: "fixedWindow", limit: 10, windowMs: 1000 },
      { clock: new ManualClock(0), maxSteps: 3 },
    );
    for (let i = 0; i < 5; i++) rec.limiter.checkSync("k");
    const trace = rec.trace();

    expect(trace.truncated).toBe(true);
    expect(trace.dropped).toBe(2);
    expect(trace.steps.length).toBe(3); // the kept PREFIX (not a drop-oldest ring)
    try {
      replay(trace);
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(ReplayRefusedError);
      expect((e as ReplayRefusedError).reason).toBe("trace-truncated");
    }
  });

  it("does no per-key work past the cap (redact/store bounded by maxSteps)", () => {
    // Past the cap, checkSync must NOT run redact() or the inner store write —
    // otherwise the keyref map + inner store grow with distinct-key cardinality,
    // not maxSteps. A colliding redactKey would throw on the 2nd distinct key if
    // redact still ran post-cap; after the fix the 2nd call is a no-op drop.
    const rec = recordLimiter(
      { strategy: "fixedWindow", limit: 10, windowMs: 1000 },
      { clock: new ManualClock(0), maxSteps: 1, redactKey: () => "SAME" },
    );
    expect(() => rec.limiter.checkSync("a")).not.toThrow(); // fills the single step
    // "b" redacts to the same "SAME" as "a"; pre-fix redact() ran first and threw
    // keyref-collision. Post-fix the cap is hit before any per-key work.
    expect(() => rec.limiter.checkSync("b")).not.toThrow();
    const trace = rec.trace();
    expect(trace.truncated).toBe(true);
    expect(trace.dropped).toBe(1);
    expect(trace.steps.length).toBe(1);
  });
});

describe("replay P1 — serialize / parse round-trip", () => {
  it("a trace survives JSON serialization and still replays identically", () => {
    const rec = recordLimiter(
      { strategy: "gcra", limit: 5, periodMs: 1000, burst: 5 },
      { clock: new ManualClock(2000) },
    );
    for (let i = 0; i < 8; i++) {
      rec.limiter.checkSync("k");
      rec.clock.advance(50);
    }
    const trace = rec.trace();
    const parsed = parseTrace(serializeTrace(trace));
    expect(parsed.steps.length).toBe(trace.steps.length);
    expect(replay(parsed).divergence.divergent).toBe(0);
  });
});
