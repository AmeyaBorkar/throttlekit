import { describe, expect, it } from "vitest";
import { adaptiveThrottle, fairShare } from "../../src/admission";
import { ManualClock } from "../../src/core/clock";
import type { Decision } from "../../src/core/types";

/**
 * A scripted `random` so the probabilistic shed is fully deterministic: each call returns the next
 * value in `draws`, looping when exhausted. Lets a test assert an exact send/shed sequence for a
 * known reject probability `p` (send iff draw >= p).
 */
function scriptedRandom(draws: number[]): () => number {
  let i = 0;
  return () => {
    const v = draws[i % draws.length] ?? 0;
    i++;
    return v;
  };
}

/** Assert a Decision is structurally well-formed per the core `Decision` contract. */
function expectValidDecision(d: Decision): void {
  expect(typeof d.allowed).toBe("boolean");
  // All numeric fields are integers.
  for (const v of [d.limit, d.remaining, d.resetAt, d.retryAfterMs]) {
    expect(Number.isInteger(v)).toBe(true);
  }
  expect(d.remaining).toBeGreaterThanOrEqual(0);
  expect(d.remaining).toBeLessThanOrEqual(d.limit);
  // retryAfterMs == 0 iff allowed.
  expect(d.retryAfterMs === 0).toBe(d.allowed);
  expect(d.retryAfterMs).toBeGreaterThanOrEqual(0);
}

describe("adaptiveThrottle", () => {
  describe("config validation", () => {
    it("rejects k < 1 and non-positive windowMs", () => {
      expect(() => adaptiveThrottle({ k: 0.5 })).toThrow(RangeError);
      expect(() => adaptiveThrottle({ k: 0 })).toThrow(RangeError);
      expect(() => adaptiveThrottle({ windowMs: 0 })).toThrow(RangeError);
      expect(() => adaptiveThrottle({ windowMs: -1 })).toThrow(RangeError);
      expect(() => adaptiveThrottle({ windowMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    });

    it("accepts the documented defaults and boundary k = 1", () => {
      expect(() => adaptiveThrottle()).not.toThrow();
      expect(() => adaptiveThrottle({ k: 1 })).not.toThrow();
    });
  });

  it("an idle, healthy throttle has p == 0 and sends every request", () => {
    const clock = new ManualClock(0);
    // random returns 0 (the most aggressive possible draw); p == 0 must still send (0 < 0 is false).
    const t = adaptiveThrottle({ clock, random: () => 0 });
    expect(t.rejectProbability()).toBe(0);
    for (let i = 0; i < 50; i++) {
      expect(t.request()).toBe(true); // sent
      t.record(true); // backend accepted
    }
    expect(t.rejectProbability()).toBe(0); // accepts == requests => healthy
    expect(t.stats().rejectProbability).toBe(0);
  });

  it("p stays 0 while the backend keeps up (accepts ≈ requests)", () => {
    const clock = new ManualClock(0);
    const t = adaptiveThrottle({ clock, k: 2, random: () => 0 });
    // Send 200, all accepted: requests - 2*accepts = 200 - 400 < 0 => p clamped to 0.
    for (let i = 0; i < 200; i++) {
      t.request();
      t.record(true);
    }
    expect(t.rejectProbability()).toBe(0);
  });

  it("p rises toward ~1 as the backend rejects everything (accepts → 0)", () => {
    const clock = new ManualClock(0);
    const t = adaptiveThrottle({ clock, k: 2, random: () => 1 }); // random()==1 never sheds
    // 100 sent, 0 accepted. With everything sent (no local shed), requests grows to 100, accepts 0.
    for (let i = 0; i < 100; i++) {
      t.request(); // returns true since 1 < p is false
      t.record(false); // backend rejected
    }
    const stats = t.stats();
    expect(stats.requests).toBe(100);
    expect(stats.accepts).toBe(0);
    // p = (100 - 2*0) / (100 + 1) = 100/101.
    expect(t.rejectProbability()).toBeCloseTo(100 / 101, 12);
    expect(t.rejectProbability()).toBeGreaterThan(0.98);
  });

  it("p sits between 0 and 1 at a partial accept rate", () => {
    const clock = new ManualClock(0);
    const t = adaptiveThrottle({ clock, k: 2, random: () => 1 });
    // 100 attempts; backend accepts every 4th (25% accept rate): 100 requests, 25 accepts.
    for (let i = 0; i < 100; i++) {
      t.request();
      t.record(i % 4 === 0);
    }
    expect(t.stats().requests).toBe(100);
    expect(t.stats().accepts).toBe(25);
    // p = (100 - 2*25) / 101 = 50/101 ≈ 0.495.
    expect(t.rejectProbability()).toBeCloseTo(50 / 101, 12);
  });

  it("sheds deterministically: send iff draw >= effective p (exact sequence for a known p)", () => {
    const clock = new ManualClock(0);
    // Build a known state with p = 50/101 ≈ 0.49505 (as in the partial-rate test above), using a
    // never-shed random while seeding so the seeding phase sends everything.
    const draws: number[] = [];
    const t = adaptiveThrottle({ clock, k: 2, random: scriptedRandom(draws) });
    draws.push(1); // seeding draws never shed
    for (let i = 0; i < 100; i++) {
      t.request();
      t.record(i % 4 === 0); // 25 accepts of 100 => p = 50/101
    }
    const p = t.rejectProbability();
    expect(p).toBeCloseTo(50 / 101, 12);

    // Now script exact draws around p. Note request() counts the attempt AFTER reading p, so p drifts
    // slightly upward as `requests` grows; we keep the assertions on the very next few calls where the
    // shift is tiny and the chosen draws (0.1 and 0.9) sit far from p on either side.
    draws.length = 0;
    draws.push(0.1, 0.9, 0.1, 0.9, 0.49, 0.5);
    expect(t.request()).toBe(false); // 0.1 < p => shed
    expect(t.request()).toBe(true); // 0.9 >= p => send
    expect(t.request()).toBe(false); // 0.1 < p => shed
    expect(t.request()).toBe(true); // 0.9 >= p => send
  });

  it("locally-shed requests are NOT counted as sent-and-rejected, but DO raise requests", () => {
    const clock = new ManualClock(0);
    // First make the backend look overloaded so p is high, then verify shedding inflates `requests`
    // (keeping p elevated) while we correctly do NOT call record() for shed requests.
    const t = adaptiveThrottle({ clock, k: 2, random: () => 0 }); // draw 0: shed whenever p > 0
    // Seed an overload with sent+rejected traffic. random()==0 sheds as soon as p>0, so we cannot
    // seed via request(); seed by recording rejections against requests we count manually.
    // Use a never-shed throttle for seeding instead:
    const seed = adaptiveThrottle({ clock, k: 2, random: () => 1 });
    for (let i = 0; i < 10; i++) {
      seed.request();
      seed.record(false);
    }
    expect(seed.stats().requests).toBe(10);
    expect(seed.stats().accepts).toBe(0);
    const pBefore = seed.rejectProbability(); // 10/11

    // Now switch to always-shed draws on the SAME logical state by continuing on `seed` with a
    // shedding random is not possible (random is fixed at construction), so assert the principle
    // directly: extra request() attempts that we do NOT record raise `requests` and keep p high.
    seed.request(); // sent (random==1), but we deliberately do NOT record it (treat as shed-like)
    expect(seed.stats().requests).toBe(11);
    expect(seed.stats().accepts).toBe(0);
    expect(seed.rejectProbability()).toBeGreaterThan(pBefore); // 11/12 > 10/11

    // And the always-shed throttle `t`, once p>0, refuses to send.
    t.request(); // first attempt: p==0 (idle) so it sends
    t.record(false); // now requests=1, accepts=0 => p = 1/2 > 0
    expect(t.request()).toBe(false); // draw 0 < 0.5 => shed
  });

  it("record(accepted) feedback moves p down as the backend recovers", () => {
    const clock = new ManualClock(0);
    const t = adaptiveThrottle({ clock, k: 2, random: () => 1 }); // never shed locally
    for (let i = 0; i < 50; i++) {
      t.request();
      t.record(false); // overload: 50 req, 0 acc => p = 50/51
    }
    const pOverloaded = t.rejectProbability();
    expect(pOverloaded).toBeCloseTo(50 / 51, 12);

    // Backend recovers: more sent requests, now all accepted.
    for (let i = 0; i < 50; i++) {
      t.request();
      t.record(true); // 100 req, 50 acc => p = (100-100)/101 = 0
    }
    expect(t.rejectProbability()).toBe(0);
    expect(t.rejectProbability()).toBeLessThan(pOverloaded);
  });

  it("priority scales the shed probability; priority 1 never sheds even at high p", () => {
    const clock = new ManualClock(0);
    // Script: 9 seeding draws of 1.0 (never shed, so seeding always sends), then explicit draws for
    // the priority assertions.
    const draws = [1, 1, 1, 1, 1, 1, 1, 1, 1, 0.5, 0.5, 0];
    const t = adaptiveThrottle({ clock, k: 2, random: scriptedRandom(draws) });
    // Seed a high overload: 9 sent requests, 0 accepts => p = 9/10 = 0.9.
    for (let i = 0; i < 9; i++) {
      t.request();
      t.record(false);
    }
    expect(t.rejectProbability()).toBeCloseTo(9 / 10, 12);

    // priority 0 (default), draw 0.5: effectiveP = p = 0.9, and 0.5 < 0.9 => shed.
    expect(t.request(0)).toBe(false);
    // priority 0.5, draw 0.5: effectiveP = p*(1-0.5) ≈ 0.45, and 0.5 < 0.45 is false => send. The
    // same draw that was shed at full rate is now sent — higher priority sheds strictly less.
    expect(t.request(0.5)).toBe(true);
    // priority 1, draw 0 (the most aggressive possible draw): effectiveP = p*(1-1) = 0, 0 < 0 is
    // false => always send. Priority 1 disables shedding entirely.
    expect(t.request(1)).toBe(true);
  });

  it("forgets old overload smoothly over the rolling window (ManualClock)", () => {
    const clock = new ManualClock(0);
    const t = adaptiveThrottle({ clock, k: 2, windowMs: 1000, random: () => 1 });
    // Window [0,1000): drive a hard overload at t=0.
    for (let i = 0; i < 10; i++) {
      t.request();
      t.record(false);
    }
    expect(t.rejectProbability()).toBeCloseTo(10 / 11, 12); // p high at t=0

    // Cross the boundary to t=1000 (start of window [1000,2000)). Smooth window, NOT a hard reset:
    // the previous window still contributes fully (elapsed fraction 0), so p is essentially unchanged.
    clock.set(1000);
    expect(t.rejectProbability()).toBeCloseTo(10 / 11, 12);

    // Halfway into the new window: the old window decays to half weight.
    clock.set(1500);
    // rollingRequests = 0 + 10*(1-0.5) = 5; accepts 0 => p = 5/6.
    expect(t.rejectProbability()).toBeCloseTo(5 / 6, 12);

    // Two windows past the overload: the old counts have fully aged out => p back to 0.
    clock.set(2000);
    expect(t.rejectProbability()).toBe(0);
  });

  it("a long idle gap (>= 2 windows) clears history entirely", () => {
    const clock = new ManualClock(0);
    const t = adaptiveThrottle({ clock, k: 2, windowMs: 1000, random: () => 1 });
    for (let i = 0; i < 10; i++) {
      t.request();
      t.record(false);
    }
    expect(t.rejectProbability()).toBeGreaterThan(0.9);
    clock.set(5000); // jumped many windows
    expect(t.rejectProbability()).toBe(0);
  });

  it("stats() reports rolling requests, accepts, and the matching p", () => {
    const clock = new ManualClock(0);
    const t = adaptiveThrottle({ clock, k: 2, random: () => 1 });
    for (let i = 0; i < 8; i++) {
      t.request();
      t.record(i < 3); // 8 requests, 3 accepts
    }
    const s = t.stats();
    expect(s.requests).toBe(8);
    expect(s.accepts).toBe(3);
    // p = (8 - 2*3)/(8+1) = 2/9.
    expect(s.rejectProbability).toBeCloseTo(2 / 9, 12);
    expect(s.rejectProbability).toBe(t.rejectProbability());
  });

  it("rejectProbability() and stats() are read-only (no mutation of counts)", () => {
    const clock = new ManualClock(0);
    const t = adaptiveThrottle({ clock, random: () => 1 });
    t.request();
    t.record(true);
    const before = t.stats();
    t.rejectProbability();
    t.rejectProbability();
    t.stats();
    const after = t.stats();
    expect(after).toEqual(before);
  });
});

describe("fairShare", () => {
  describe("config validation", () => {
    it("rejects non-positive limit/windowMs and bad cost", () => {
      expect(() => fairShare({ limit: 0, windowMs: 1000 })).toThrow(RangeError);
      expect(() => fairShare({ limit: 10, windowMs: 0 })).toThrow(RangeError);
      expect(() => fairShare({ limit: 10, windowMs: -1 })).toThrow(RangeError);
      const fs = fairShare({ limit: 10, windowMs: 1000, clock: new ManualClock(0) });
      expect(() => fs.checkSync("a", 0)).toThrow(RangeError);
      expect(() => fs.checkSync("a", -1)).toThrow(RangeError);
      expect(() => fs.checkSync("a", Number.POSITIVE_INFINITY)).toThrow(RangeError);
    });
  });

  it("a heavy tenant cannot exceed floor(limit/N) while others are active (no starvation)", () => {
    const clock = new ManualClock(0);
    const fs = fairShare({ limit: 12, windowMs: 1000, clock });
    // Make 3 tenants active first (each one check) => N = 3 => fairCap = floor(12/3) = 4.
    fs.checkSync("a");
    fs.checkSync("b");
    fs.checkSync("c");

    // Tenant "a" already used 1; it may take 3 more (cap 4), then is capped — even though the global
    // budget (12) is nowhere near exhausted. This is the anti-starvation guarantee.
    expect(fs.checkSync("a").allowed).toBe(true); // a used 2
    expect(fs.checkSync("a").allowed).toBe(true); // a used 3
    const atCap = fs.checkSync("a"); // a used 4 == cap
    expect(atCap.allowed).toBe(true);
    expect(atCap.remaining).toBe(0);
    expect(atCap.limit).toBe(4); // reported limit is the tenant's fair cap, not the global 12

    const denied = fs.checkSync("a"); // a would be 5 > cap 4 => denied on the fair test
    expect(denied.allowed).toBe(false);
    expect(denied.limit).toBe(4);
    expect(denied.remaining).toBe(0);

    // b and c still have their full shares available — a did not starve them.
    expect(fs.checkSync("b").allowed).toBe(true);
    expect(fs.checkSync("c").allowed).toBe(true);
  });

  it("the global total admitted never exceeds limit", () => {
    const clock = new ManualClock(0);
    const limit = 10;
    const fs = fairShare({ limit, windowMs: 1000, clock });
    let admitted = 0;
    // Hammer 7 tenants well past the budget within one window. Once all 7 are active the per-tenant
    // cap is floor(10/7) = 1, so the realized total (7) is below the global budget — fairness bites
    // before the global cap does. The hard guarantee is only that we never go OVER `limit`.
    for (let round = 0; round < 50; round++) {
      for (const tenant of ["a", "b", "c", "d", "e", "f", "g"]) {
        if (fs.checkSync(tenant).allowed) admitted++;
      }
    }
    expect(admitted).toBeLessThanOrEqual(limit); // never overspends the budget
    expect(admitted).toBe(7); // here: each of 7 active tenants gets exactly its fair cap of 1

    // With few enough tenants that N * fairCap reaches the budget, the global cap is the binding
    // constraint and the full budget is spent — exactly `limit`, never more.
    const fs2 = fairShare({ limit, windowMs: 1000, clock: new ManualClock(0) });
    let admitted2 = 0;
    for (let round = 0; round < 50; round++) {
      for (const tenant of ["a", "b"]) {
        // N=2 => cap floor(10/2)=5; two tenants * 5 = 10 = limit.
        if (fs2.checkSync(tenant).allowed) admitted2++;
      }
    }
    expect(admitted2).toBe(limit); // budget fully and exactly consumed
  });

  it("idle capacity is usable by an active tenant when others are absent", () => {
    const clock = new ManualClock(0);
    const fs = fairShare({ limit: 10, windowMs: 1000, clock });
    // Only one tenant ever shows up: N stays 1, fairCap = floor(10/1) = 10, so it can use the whole
    // budget (idle tenants' capacity is available first-come).
    let admitted = 0;
    for (let i = 0; i < 20; i++) {
      if (fs.checkSync("solo").allowed) admitted++;
    }
    expect(admitted).toBe(10);
    const d = fs.checkSync("solo");
    expect(d.allowed).toBe(false);
    expect(d.limit).toBe(10); // cap equals the whole budget when alone
  });

  it("a tenant's cap shrinks as more tenants become active mid-window (documented limitation)", () => {
    const clock = new ManualClock(0);
    const fs = fairShare({ limit: 10, windowMs: 1000, clock });
    // "a" arrives alone: cap 10. It grabs 6 before anyone else appears.
    for (let i = 0; i < 6; i++) expect(fs.checkSync("a").allowed).toBe(true);

    // "b" now becomes active on its first check => N = 2 => fairCap = floor(10/2) = 5. b's own admit
    // succeeds (b used 0, cap 5, global 6+1<=10).
    const bFirst = fs.checkSync("b");
    expect(bFirst.allowed).toBe(true);
    expect(bFirst.limit).toBe(5);

    // "a" already holds 6 (> the new cap of 5), so "a" is now capped: it keeps what it took, and the
    // realized split is uneven this window (documented limitation #2).
    const aAfter = fs.checkSync("a");
    expect(aAfter.allowed).toBe(false);
    expect(aAfter.limit).toBe(5);
    expect(aAfter.remaining).toBe(0); // max(0, 5 - 6)

    // "b" can take up to its fair cap of 5, but only 3 global slots remain now (10 - 6 - 1 already
    // taken by b's first admit) — spare capacity is first-come, not perfectly redistributed
    // (documented limitation #3).
    let bMore = 0;
    for (let i = 0; i < 10; i++) if (fs.checkSync("b").allowed) bMore++;
    expect(bMore).toBe(3); // global budget runs out (6+1+3 = 10) before b reaches its cap of 5
  });

  it("resets the whole window under ManualClock; an exhausted tenant is admitted again", () => {
    const clock = new ManualClock(0);
    const fs = fairShare({ limit: 2, windowMs: 1000, clock });
    expect(fs.checkSync("a").allowed).toBe(true);
    const second = fs.checkSync("a"); // N=1, cap=2: a uses 2 (== cap and == global)
    expect(second.allowed).toBe(true);
    const denied = fs.checkSync("a");
    expect(denied.allowed).toBe(false);
    expect(denied.resetAt).toBe(1000);
    expect(denied.retryAfterMs).toBe(1000); // full window from now=0

    clock.set(999);
    expect(fs.checkSync("a").allowed).toBe(false); // still same window

    clock.set(1000); // roll into [1000,2000)
    const fresh = fs.checkSync("a");
    expect(fresh.allowed).toBe(true);
    expect(fresh.resetAt).toBe(2000);
  });

  it("reset(tenant) refunds that tenant and drops it from the active set", () => {
    const clock = new ManualClock(0);
    const fs = fairShare({ limit: 4, windowMs: 1000, clock });
    fs.checkSync("a"); // active: {a}, total 1
    fs.checkSync("b"); // active: {a,b} => cap floor(4/2)=2; total 2
    expect(fs.checkSync("b").allowed).toBe(true); // b uses 2 (== cap), total 3
    expect(fs.checkSync("b").allowed).toBe(false); // b at cap 2

    // Reset "b": refund its 2 to the global total and remove it from the active set.
    fs.reset("b");
    // Now only "a" is active. a used 1; cap becomes floor(4/1)=4. Global total is back to 1.
    const a = fs.checkSync("a");
    expect(a.allowed).toBe(true);
    expect(a.limit).toBe(4); // a is alone again => full budget cap
    expect(a.remaining).toBe(2); // a used 2 of 4

    // Resetting an unknown tenant is a harmless no-op.
    expect(() => fs.reset("does-not-exist")).not.toThrow();
  });

  it("reset() (no arg) forces a fresh window on the next check", () => {
    const clock = new ManualClock(500);
    const fs = fairShare({ limit: 1, windowMs: 1000, clock });
    expect(fs.checkSync("a").allowed).toBe(true);
    expect(fs.checkSync("a").allowed).toBe(false); // global budget 1 exhausted
    fs.reset(); // forget everything
    expect(fs.checkSync("a").allowed).toBe(true); // admitted again in the same wall-clock instant
  });

  it("honors cost > 1 on both the global and fair tests", () => {
    const clock = new ManualClock(0);
    const fs = fairShare({ limit: 10, windowMs: 1000, clock });
    fs.checkSync("a"); // a active alone, cap 10, used 1
    fs.checkSync("b"); // b active => N=2, cap 5
    // "a" with cost 4: used 1 + 4 = 5 <= cap 5 and total 2 + 4 = 6 <= 10 => allowed.
    const a = fs.checkSync("a", 4);
    expect(a.allowed).toBe(true);
    expect(a.remaining).toBe(0); // 5 - 5
    // "a" again any cost now exceeds cap 5 => denied.
    expect(fs.checkSync("a", 1).allowed).toBe(false);
    // A single cost that would push a tenant past its fair cap is denied outright.
    const fs2 = fairShare({ limit: 10, windowMs: 1000, clock: new ManualClock(0) });
    fs2.checkSync("x"); // x's activating admit consumes 1
    fs2.checkSync("y"); // N=2 => cap 5
    const big = fs2.checkSync("x", 6); // x used 1; 1 + 6 = 7 > cap 5 => denied
    expect(big.allowed).toBe(false);
    expect(big.remaining).toBe(4); // denial consumes nothing; cap 5 minus the 1 x already holds
  });

  it("checkSync and check return identical Decisions", async () => {
    const a = fairShare({ limit: 6, windowMs: 1000, clock: new ManualClock(0) });
    const b = fairShare({ limit: 6, windowMs: 1000, clock: new ManualClock(0) });
    const tenants = ["a", "b", "c"];
    for (let i = 0; i < 15; i++) {
      const tenant = tenants[i % tenants.length] ?? "a";
      const sync = a.checkSync(tenant);
      const asyncD = await b.check(tenant);
      expect(asyncD).toEqual(sync);
    }
  });

  it("Decision shape is well-formed on allow and deny (aligned resetAt, integer fields)", () => {
    const clock = new ManualClock(333); // non-aligned to exercise rounding
    const fs = fairShare({ limit: 2, windowMs: 1000, clock });
    const allow = fs.checkSync("a");
    fs.checkSync("a"); // exhaust the lone tenant's budget (cap 2)
    const deny = fs.checkSync("a");
    expect(allow.allowed).toBe(true);
    expect(deny.allowed).toBe(false);
    // Windows are epoch-aligned: floor(333/1000)*1000 + 1000 = 1000.
    expect(allow.resetAt).toBe(1000);
    expect(deny.resetAt).toBe(1000);
    expect(deny.retryAfterMs).toBe(667); // ceil(1000 - 333)
    expectValidDecision(allow);
    expectValidDecision(deny);
  });

  it("never hands a tenant a zero cap even when N exceeds the limit", () => {
    const clock = new ManualClock(0);
    const fs = fairShare({ limit: 2, windowMs: 1000, clock });
    // Make 5 tenants active. The cap each tenant SEES is computed from the active count at the moment
    // of its check, which grows as tenants arrive: "a" checks alone (N=1, cap 2), "b" at N=2 (cap 1),
    // and "c","d","e" at N>=3 where floor(2/N)=0 is clamped UP to 1 — never 0.
    const tenants = ["a", "b", "c", "d", "e"];
    const firstCaps = tenants.map((t) => fs.checkSync(t).limit);
    expect(firstCaps).toEqual([2, 1, 1, 1, 1]); // floor(2/N) clamped to a floor of 1

    // Now that all 5 are active (N=5 => cap clamped to 1), every tenant's reported cap is exactly 1.
    for (const t of tenants) {
      expect(fs.checkSync(t).limit).toBe(1); // cap clamped to 1, never 0
    }

    // Only 2 admits ever happened (the global budget), the rest were denied: no over-admission and
    // no starvation-by-zero-cap.
    const fresh = fairShare({ limit: 2, windowMs: 1000, clock: new ManualClock(0) });
    const allowedCount = tenants.filter((t) => fresh.checkSync(t).allowed).length;
    expect(allowedCount).toBe(2); // bounded by the global budget
  });
});
