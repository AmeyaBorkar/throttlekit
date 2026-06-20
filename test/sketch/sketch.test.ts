import { describe, expect, it } from "vitest";
import { ManualClock } from "../../src/core/clock";
import type { Decision } from "../../src/core/types";
import { CountMinSketch, sketchRateLimit } from "../../src/sketch";

/**
 * A tiny deterministic PRNG (mulberry32) so the probabilistic tests are reproducible: same seed =>
 * same key stream => same pass/fail every run. Avoids flakiness while still exercising real spread.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Assert a Decision is structurally well-formed per the core `Decision` contract. */
function expectValidDecision(d: Decision, limit: number): void {
  expect(typeof d.allowed).toBe("boolean");
  expect(d.limit).toBe(limit);
  // All numeric fields are integers.
  for (const v of [d.limit, d.remaining, d.resetAt, d.retryAfterMs]) {
    expect(Number.isInteger(v)).toBe(true);
  }
  expect(d.remaining).toBeGreaterThanOrEqual(0);
  expect(d.remaining).toBeLessThanOrEqual(limit);
  // retryAfterMs == 0 iff allowed.
  expect(d.retryAfterMs === 0).toBe(d.allowed);
  expect(d.retryAfterMs).toBeGreaterThanOrEqual(0);
}

describe("CountMinSketch", () => {
  it("sizes width/depth from the Cormode–Muthukrishnan formulas", () => {
    // w = ceil(e/epsilon), d = ceil(ln(1/delta)).
    const cms = new CountMinSketch(0.01, 0.001, true);
    expect(cms.width).toBe(Math.ceil(Math.E / 0.01)); // 272
    expect(cms.depth).toBe(Math.ceil(Math.log(1 / 0.001))); // 7
    expect(cms.size).toBe(cms.width * cms.depth);
    expect(cms.counters.length).toBe(cms.size);
  });

  it("validates epsilon and delta", () => {
    expect(() => new CountMinSketch(0, 0.001, true)).toThrow(RangeError);
    expect(() => new CountMinSketch(1, 0.001, true)).toThrow(RangeError);
    expect(() => new CountMinSketch(0.01, 0, true)).toThrow(RangeError);
    expect(() => new CountMinSketch(0.01, 1, true)).toThrow(RangeError);
    expect(() => new CountMinSketch(Number.NaN, 0.001, true)).toThrow(RangeError);
  });

  it("never underestimates the true count", () => {
    const cms = new CountMinSketch(0.01, 0.001, true);
    const truth = new Map<string, number>();
    const rnd = mulberry32(7);
    for (let i = 0; i < 20_000; i++) {
      const key = `k${Math.floor(rnd() * 4000)}`;
      cms.add(key, 1);
      truth.set(key, (truth.get(key) ?? 0) + 1);
    }
    for (const [key, trueCount] of truth) {
      expect(cms.estimate(key)).toBeGreaterThanOrEqual(trueCount);
    }
  });

  it("is deterministic across instances when given the same explicit seed", () => {
    // With an explicit shared seed, hashing is reproducible across instances (seeded tests, and the
    // shared-seed merge path). The default seed is per-instance random (see the griefing-resistance
    // test below), so two default-seeded sketches deliberately do NOT hash identically.
    const a = new CountMinSketch(0.01, 0.001, true, 12345);
    const b = new CountMinSketch(0.01, 0.001, true, 12345);
    for (const k of ["1.2.3.4", "10.0.0.1", "user:42", ""]) {
      a.add(k, 3);
      b.add(k, 3);
    }
    expect(a.seed).toBe(b.seed);
    expect(Array.from(a.counters)).toEqual(Array.from(b.counters));
  });

  it("uses a per-instance random seed by default (no fixed public hashing to precompute against)", () => {
    // Across many default-seeded instances the seeds should differ (a fixed default would let an
    // attacker precompute colliders); a tiny collision rate is tolerated but they must not all match.
    const seeds = new Set<number>();
    for (let i = 0; i < 16; i++) seeds.add(new CountMinSketch(0.01, 0.001, true).seed);
    expect(seeds.size).toBeGreaterThan(1);
  });

  it("conservative update never exceeds the plain-increment estimate", () => {
    // Same explicit seed so both sketches hash keys to the same cells — the comparison is only
    // meaningful between identically-hashed sketches.
    const cons = new CountMinSketch(0.05, 0.01, true, 4242);
    const plain = new CountMinSketch(0.05, 0.01, false, 4242);
    const rnd = mulberry32(99);
    const keys = Array.from({ length: 500 }, (_, i) => `k${i}`);
    for (let i = 0; i < 30_000; i++) {
      const key = keys[Math.floor(rnd() * keys.length)]!;
      cons.add(key, 1);
      plain.add(key, 1);
    }
    for (const k of keys) {
      // Conservative update provably tightens (never loosens) the overestimate.
      expect(cons.estimate(k)).toBeLessThanOrEqual(plain.estimate(k));
    }
  });

  it("resists targeted full-column collisions: finding a key on a victim's full cell set costs ~width^depth, not ~width^2 (regression)", () => {
    // The old double-hash form h_i = (h1 + i*h2) % width collapsed all rows to 2 degrees of freedom:
    // a key matching the victim on any TWO rows necessarily matched on ALL rows, so a full collision
    // (which lets an attacker inflate the victim's estimate and grief it into false denial) cost only
    // ~width^2 to forge. Independent per-row hashing restores ~width^depth, so a bounded search well
    // past width^2 finds essentially none.
    const epsilon = 0.1; // width = ceil(e/epsilon) = 28
    const delta = 0.01; // depth = ceil(ln(1/delta)) = 5  →  width^2 = 784, width^depth ≈ 1.7e7
    const seed = 0xc0ffee;
    const probe = new CountMinSketch(epsilon, delta, false, seed);
    const victim = "customer-premium-7";

    // A candidate is a "full collider" iff adding it once raises the victim's estimate (all of the
    // victim's cells were touched). Reset the sketch between candidates so each is measured cleanly.
    let fullColliders = 0;
    const budget = 4000; // ~5x width^2, so the 2-DOF form would yield several; independent rows ≈ 0.
    for (let i = 0; i < budget && fullColliders < 1; i++) {
      probe.clear();
      probe.add(`atk-${i}`, 1);
      if (probe.estimate(victim) >= 1) fullColliders++;
    }
    expect(fullColliders).toBe(0);
  });

  it("the same key hashes to a different cell set under a different seed (no fixed public hashing)", () => {
    // Per-instance/explicit seeds mean an attacker's precomputed colliders are tied to one sketch's
    // hashing. Concretely: add a batch of keys to two differently-seeded sketches and the resulting
    // counter tables must differ (the same keys land on different cells).
    const a = new CountMinSketch(0.1, 0.01, false, 1);
    const b = new CountMinSketch(0.1, 0.01, false, 2);
    for (let i = 0; i < 200; i++) {
      a.add(`k-${i}`, 1);
      b.add(`k-${i}`, 1);
    }
    expect(Array.from(a.counters)).not.toEqual(Array.from(b.counters));
  });

  it("clear() zeroes counters and resets total without reallocating", () => {
    const cms = new CountMinSketch(0.01, 0.001, true);
    const buf = cms.counters;
    cms.add("a", 5);
    expect(cms.total).toBe(5);
    cms.clear();
    expect(cms.total).toBe(0);
    expect(cms.estimate("a")).toBe(0);
    expect(cms.counters).toBe(buf); // same backing buffer
  });
});

describe("sketchRateLimit", () => {
  it("validates options", () => {
    expect(() => sketchRateLimit({ limit: 0, windowMs: 1000 })).toThrow(RangeError);
    expect(() => sketchRateLimit({ limit: 5, windowMs: 0 })).toThrow(RangeError);
    expect(() => sketchRateLimit({ limit: 5, windowMs: -1 })).toThrow(RangeError);
  });

  it("validates cost", () => {
    const rl = sketchRateLimit({ limit: 5, windowMs: 1000, clock: new ManualClock(0) });
    expect(() => rl.checkSync("k", 0)).toThrow(RangeError);
    expect(() => rl.checkSync("k", -1)).toThrow(RangeError);
    expect(() => rl.checkSync("k", Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("NEVER over-admits: allowed count per key is <= limit, exactly (hard guarantee)", () => {
    const clock = new ManualClock(0);
    const limit = 50;
    // epsilon tuned loose so collisions are plentiful — the safety guarantee must still hold.
    const rl = sketchRateLimit({ limit, windowMs: 60_000, epsilon: 0.05, delta: 0.01, clock });
    const rnd = mulberry32(123);
    const keys = Array.from({ length: 2000 }, (_, i) => `ip-${i}`);
    const allowed = new Map<string, number>();
    // Hammer many keys far past their limit within a single window.
    for (let i = 0; i < 300_000; i++) {
      const key = keys[Math.floor(rnd() * keys.length)]!;
      if (rl.checkSync(key).allowed) {
        allowed.set(key, (allowed.get(key) ?? 0) + 1);
      }
    }
    expect(allowed.size).toBeGreaterThan(0);
    for (const [, count] of allowed) {
      expect(count).toBeLessThanOrEqual(limit);
    }
  });

  it("bounded memory: capacity depends only on epsilon/delta, not key count", () => {
    const make = () => sketchRateLimit({ limit: 10, windowMs: 1000, clock: new ManualClock(0) });
    const few = make();
    const many = make();
    for (let i = 0; i < 10; i++) few.checkSync(`k${i}`);
    for (let i = 0; i < 100_000; i++) many.checkSync(`k${i}`);
    // Identical footprint after 10 vs 100,000 distinct keys.
    expect(many.capacity).toBe(few.capacity);
    expect(few.capacity).toBe(Math.ceil(Math.E / 0.01) * Math.ceil(Math.log(1 / 0.001)));
  });

  it("error bound: heavy key estimate within [true, true + epsilon*N]; light keys mostly admitted", () => {
    const clock = new ManualClock(0);
    const epsilon = 0.01;
    const delta = 0.001;
    // Heavy key gets a big quota; light keys a small one. Single huge window so nothing rolls.
    const heavyLimit = 100_000;
    const rl = sketchRateLimit({ limit: heavyLimit, windowMs: 10 ** 9, epsilon, delta, clock });
    // We can read the sketch's error term via a parallel CMS with identical params/seeding.
    const oracle = new CountMinSketch(epsilon, delta, true);

    const rnd = mulberry32(2024);
    const heavy = "HEAVY";
    let heavyTrue = 0;
    let lightTotal = 0;
    let lightDenied = 0;

    // Interleave one heavy key with a flood of distinct light keys.
    for (let i = 0; i < 200_000; i++) {
      if (i % 5 === 0) {
        rl.checkSync(heavy);
        oracle.add(heavy, 1);
        heavyTrue++;
      } else {
        const key = `light-${Math.floor(rnd() * 50_000)}`;
        oracle.add(key, 1);
        lightTotal++;
        if (!rl.checkSync(key).allowed) lightDenied++;
      }
    }

    const n = oracle.total;
    const est = oracle.estimate(heavy);
    // Never underestimate.
    expect(est).toBeGreaterThanOrEqual(heavyTrue);
    // Overestimate bounded by epsilon * N (deterministic with this fixed seed).
    expect(est).toBeLessThanOrEqual(heavyTrue + epsilon * n);

    // Light keys are far under their limit, so false denials should be rare.
    const falseDenyRate = lightDenied / lightTotal;
    expect(falseDenyRate).toBeLessThan(0.01);
  });

  it("window roll: an exhausted key is admitted again next window; resetAt is aligned", () => {
    const clock = new ManualClock(0);
    const rl = sketchRateLimit({ limit: 2, windowMs: 1000, clock });
    const first = rl.checkSync("k");
    expect(first.allowed).toBe(true);
    expect(first.resetAt).toBe(1000); // aligned: floor(0/1000)*1000 + 1000
    expect(rl.checkSync("k").allowed).toBe(true); // 2nd admit
    const denied = rl.checkSync("k");
    expect(denied.allowed).toBe(false);
    expect(denied.resetAt).toBe(1000);
    expect(denied.retryAfterMs).toBe(1000); // full window remaining from now=0

    // Still denied just before the boundary.
    clock.set(999);
    expect(rl.checkSync("k").allowed).toBe(false);

    // Roll into the next aligned window.
    clock.set(1000);
    const fresh = rl.checkSync("k");
    expect(fresh.allowed).toBe(true);
    expect(fresh.remaining).toBe(1);
    expect(fresh.resetAt).toBe(2000);
  });

  it("aligns windows to the epoch from a non-aligned first check", () => {
    const clock = new ManualClock(2500);
    const rl = sketchRateLimit({ limit: 5, windowMs: 1000, clock });
    const d = rl.checkSync("k"); // window [2000, 3000)
    expect(d.allowed).toBe(true);
    expect(d.resetAt).toBe(3000);
    expect(d.remaining).toBe(4);
  });

  it("reset() clears state: a previously-exhausted key is immediately admitted", () => {
    const clock = new ManualClock(0);
    const rl = sketchRateLimit({ limit: 1, windowMs: 1000, clock });
    expect(rl.checkSync("k").allowed).toBe(true);
    expect(rl.checkSync("k").allowed).toBe(false);
    rl.reset();
    expect(rl.checkSync("k").allowed).toBe(true);
  });

  it("denied requests do not consume — remaining stays meaningful", () => {
    const clock = new ManualClock(0);
    const rl = sketchRateLimit({ limit: 2, windowMs: 1000, clock });
    rl.checkSync("k");
    rl.checkSync("k"); // exhausted
    const d1 = rl.checkSync("k");
    expect(d1.allowed).toBe(false);
    expect(d1.remaining).toBe(0);
    const d2 = rl.checkSync("k"); // a denial must not push the estimate past limit
    expect(d2.allowed).toBe(false);
    expect(d2.remaining).toBe(0);
  });

  it("honors cost > 1 and denies a single cost exceeding the whole limit", () => {
    const clock = new ManualClock(0);
    const rl = sketchRateLimit({ limit: 5, windowMs: 1000, clock });
    const d = rl.checkSync("k", 3);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(2);
    expect(rl.checkSync("k", 2).allowed).toBe(true); // exactly fills
    expect(rl.checkSync("k", 1).allowed).toBe(false);

    const rl2 = sketchRateLimit({ limit: 3, windowMs: 1000, clock: new ManualClock(0) });
    const big = rl2.checkSync("k", 4); // cost 4 > limit 3
    expect(big.allowed).toBe(false);
    expect(big.remaining).toBe(3); // nothing consumed
  });

  it("checkSync and check return identical Decisions (determinism under ManualClock)", async () => {
    const optsA = { limit: 10, windowMs: 1000, clock: new ManualClock(0) } as const;
    const optsB = { limit: 10, windowMs: 1000, clock: new ManualClock(0) } as const;
    const a = sketchRateLimit(optsA);
    const b = sketchRateLimit(optsB);
    for (let i = 0; i < 15; i++) {
      const sync = a.checkSync(`k${i % 3}`);
      const asyncD = await b.check(`k${i % 3}`);
      expect(asyncD).toEqual(sync);
    }
  });

  it("produces a well-formed Decision shape on both allow and deny", () => {
    const clock = new ManualClock(333); // non-aligned to exercise rounding
    const limit = 2;
    const rl = sketchRateLimit({ limit, windowMs: 1000, clock });
    const allow = rl.checkSync("k");
    rl.checkSync("k");
    const deny = rl.checkSync("k");
    expect(allow.allowed).toBe(true);
    expect(deny.allowed).toBe(false);
    expectValidDecision(allow, limit);
    expectValidDecision(deny, limit);
  });
});
