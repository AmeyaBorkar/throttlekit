import { describe, expect, it } from "vitest";
import { withAdmissionAnalytics } from "../../src/admission/analytics";
import { type AdmissionEvent, admissionTap } from "../../src/admission/tap";
import {
  type UnifiedAdmitter,
  type UnifiedAxis,
  unifiedAdmission,
} from "../../src/admission/unified";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { gcra } from "../../src/algorithms/gcra";
import { adaptiveConcurrency } from "../../src/concurrency/adaptive";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";
import type { Decision } from "../../src/core/types";
import { tapDecisions } from "../../src/observability/tap";

// The ThrottleKit Lens depends on three properties of admissionTap / withAdmissionAnalytics; this pins them.

const HOUR = 3_600_000;
/** A concurrency guard that never binds (so rate/cost can be the binding axis). */
const wideConc = () => adaptiveConcurrency({ minLimit: 1000, maxLimit: 1000, initialLimit: 1000 });
const wideRate = () => rateLimit({ strategy: gcra({ limit: 100_000, periodMs: HOUR }) });
const wideCost = () => rateLimit({ strategy: fixedWindow({ limit: 100_000, windowMs: HOUR }) });

/** Independent reconstruction of the binding axis from a per-axis snapshot (mirrors otel.bindingAxisOf). */
function reconstruct(
  last: Readonly<Partial<Record<UnifiedAxis, Decision | undefined>>>,
): UnifiedAxis | undefined {
  if (last.concurrency?.allowed === false) return "concurrency";
  if (last.rate?.allowed === false) return "rate";
  if (last.cost?.allowed === false) return "cost";
  return undefined;
}

describe("admissionTap", () => {
  it("emits one event per admit with exact fields; perAxis agrees with the binding axis", async () => {
    const events: AdmissionEvent[] = [];
    const admit = admissionTap(
      unifiedAdmission({
        rate: rateLimit({ strategy: gcra({ limit: 3, periodMs: HOUR, burst: 3 }) }),
        concurrency: wideConc(),
        cost: wideCost(),
      }),
      (e) => events.push(e),
    );
    for (let i = 0; i < 5; i++) (await admit.admit({ key: "k", cost: 1, value: 1 })).release();

    expect(events).toHaveLength(5);
    // First three admitted, last two rate-denied (gcra burst 3).
    expect(events.slice(0, 3).every((e) => e.decision.allowed)).toBe(true);
    expect(events.slice(3).every((e) => !e.decision.allowed)).toBe(true);
    for (const e of events) {
      expect(e.key).toBe("k");
      expect(e.cost).toBe(1);
      expect(e.value).toBe(1);
      expect(e.kind).toBe("admit");
      expect(e.policyDenied).toBe(false);
      // The single attributed lane + the binding axis + the per-axis reconstruction all agree.
      if (e.decision.allowed) {
        expect(e.lane).toBeUndefined();
        expect(e.bindingAxis).toBeUndefined();
      } else {
        expect(e.lane).toBe("rate");
        expect(e.bindingAxis).toBe("rate");
      }
      expect(reconstruct(e.perAxis)).toBe(e.bindingAxis);
    }
  });

  it("never lets a throwing observer break admission", async () => {
    const admit = admissionTap(unifiedAdmission({ rate: wideRate() }), () => {
      throw new Error("observer boom");
    });
    const a = await admit.admit({ key: "k" });
    expect(a.decision.allowed).toBe(true);
    a.release();
  });

  it("supports admitSync and tags kind", () => {
    const events: AdmissionEvent[] = [];
    const admit = admissionTap(unifiedAdmission({ rate: wideRate() }), (e) => events.push(e));
    admit.admitSync({ key: "k" }).release();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("admitSync");
    expect(events[0]?.decision.allowed).toBe(true);
  });

  it("attributes concurrency and joint-LP policy lanes", async () => {
    // Concurrency: limit 1, hold the first slot so the second admit is concurrency-bound.
    const concEvents: AdmissionEvent[] = [];
    const concAdmit = admissionTap(
      unifiedAdmission({
        rate: wideRate(),
        concurrency: adaptiveConcurrency({ minLimit: 1, maxLimit: 1, initialLimit: 1 }),
        cost: wideCost(),
      }),
      (e) => concEvents.push(e),
    );
    const held = await concAdmit.admit({ key: "k" }); // holds the only slot (not released)
    const blocked = await concAdmit.admit({ key: "k" });
    expect(held.decision.allowed).toBe(true);
    expect(blocked.decision.allowed).toBe(false);
    expect(concEvents[1]?.lane).toBe("concurrency");
    expect(concEvents[1]?.bindingAxis).toBe("concurrency");
    held.release();
    blocked.release();

    // Policy: joint-LP bid-price filter denies a low-value request; it is NOT a fourth axis.
    const polEvents: AdmissionEvent[] = [];
    const polAdmit = admissionTap(
      unifiedAdmission({
        rate: wideRate(),
        cost: wideCost(),
        policy: "joint-lp",
        jointLp: { duals: { rate: 1, cost: 1 } }, // bid = 1 + 1*cost
      }),
      (e) => polEvents.push(e),
    );
    (await polAdmit.admit({ key: "k", cost: 1, value: 0.5 })).release(); // value 0.5 < bid 2 => policy deny
    const e = polEvents[0];
    expect(e?.decision.allowed).toBe(false);
    expect(e?.policyDenied).toBe(true);
    expect(e?.bindingAxis).toBeUndefined();
    expect(e?.lane).toBe("policy");
  });
});

describe("withAdmissionAnalytics", () => {
  /** Drive `n` admits at `key`, releasing each (so a wide concurrency guard never fills). */
  async function drive(admit: UnifiedAdmitter, key: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) (await admit.admit({ key })).release();
  }

  it("partitions denials by lane with Σ deniedByLane === denied", async () => {
    const a = withAdmissionAnalytics(
      unifiedAdmission({
        rate: rateLimit({ strategy: gcra({ limit: 3, periodMs: HOUR, burst: 3 }) }),
        cost: wideCost(),
      }),
    );
    await drive(a, "k", 5); // 3 allow, 2 rate-deny
    const s = a.analytics();
    expect(s.allowed).toBe(3);
    expect(s.denied).toBe(2);
    expect(s.total).toBe(5);
    expect(s.denyRate).toBeCloseTo(2 / 5);
    expect(Object.keys(s.deniedByLane).sort()).toEqual(["concurrency", "cost", "policy", "rate"]);
    const sum =
      s.deniedByLane.rate +
      s.deniedByLane.concurrency +
      s.deniedByLane.cost +
      s.deniedByLane.policy;
    expect(sum).toBe(s.denied);
    expect(s.deniedByLane.rate).toBe(2);
    expect(s.deniedByLane.cost).toBe(0);
  });

  it("counts concurrency- and policy-lane denials", async () => {
    // Concurrency: limit 1, hold the slot, then five blocked admits all bind concurrency.
    const conc = withAdmissionAnalytics(
      unifiedAdmission({
        concurrency: adaptiveConcurrency({ minLimit: 1, maxLimit: 1, initialLimit: 1 }),
      }),
    );
    const held = await conc.admit({ key: "k" }); // holds the slot
    for (let i = 0; i < 5; i++) (await conc.admit({ key: "k" })).release();
    const cs = conc.analytics();
    expect(cs.deniedByLane.concurrency).toBe(5);
    expect(cs.deniedByLane.rate + cs.deniedByLane.cost + cs.deniedByLane.policy).toBe(0);
    expect(cs.topDeniedByLane.concurrency[0]?.key).toBe("k");
    held.release();

    const pol = withAdmissionAnalytics(
      unifiedAdmission({
        rate: wideRate(),
        cost: wideCost(),
        policy: "joint-lp",
        jointLp: { duals: { rate: 1, cost: 1 } },
      }),
    );
    for (let i = 0; i < 4; i++) (await pol.admit({ key: "k", value: 0 })).release();
    const ps = pol.analytics();
    expect(ps.deniedByLane.policy).toBe(4);
    expect(ps.denied).toBe(4);
  });

  it("bounds top-K under a flood of distinct keys (Space-Saving)", async () => {
    // Concurrency limit 1, slot held: every distinct key denies concurrency, so memory must stay bounded.
    const a = withAdmissionAnalytics(
      unifiedAdmission({
        concurrency: adaptiveConcurrency({ minLimit: 1, maxLimit: 1, initialLimit: 1 }),
      }),
      { topK: 3 },
    );
    const held = await a.admit({ key: "holder" });
    for (let i = 0; i < 100; i++) (await a.admit({ key: `key-${i}` })).release();
    const s = a.analytics();
    expect(s.topRequested.length).toBeLessThanOrEqual(3);
    expect(s.topDenied.length).toBeLessThanOrEqual(3);
    expect(s.topDeniedByLane.concurrency.length).toBeLessThanOrEqual(3);
    expect(s.denied).toBe(100);
    held.release();
  });

  it("rolls the window on the analytics clock", async () => {
    const clock = new ManualClock(0);
    const a = withAdmissionAnalytics(
      unifiedAdmission({
        rate: rateLimit({ strategy: gcra({ limit: 1, periodMs: HOUR, burst: 1 }) }),
      }),
      { windowMs: 1000, clock },
    );
    await drive(a, "k", 3); // 1 allow, 2 deny in window [0,1000)
    expect(a.analytics().total).toBe(3);
    clock.advance(1000); // cross the window boundary
    const fresh = a.analytics();
    expect(fresh.allowed).toBe(0);
    expect(fresh.denied).toBe(0);
    expect(fresh.deniedByLane.rate).toBe(0);
  });

  it("resetAnalytics clears all counters", async () => {
    const a = withAdmissionAnalytics(
      unifiedAdmission({
        rate: rateLimit({ strategy: gcra({ limit: 1, periodMs: HOUR, burst: 1 }) }),
      }),
    );
    await drive(a, "k", 3);
    expect(a.analytics().total).toBe(3);
    a.resetAnalytics();
    expect(a.analytics().total).toBe(0);
  });
});

describe("universal attribution contract (the Lens relies on tapDecisions for non-unified users)", () => {
  it("attributes a plain rateLimit()'s denials by (strategy, key) from the tap alone", async () => {
    type Ev = { key: string; strategy: string; allowed: boolean };
    const events: Ev[] = [];
    const limiter = tapDecisions(
      rateLimit({ strategy: gcra({ limit: 3, periodMs: HOUR, burst: 3 }) }),
      (e) => events.push({ key: e.key, strategy: e.strategy, allowed: e.decision.allowed }),
    );
    for (let i = 0; i < 5; i++) await limiter.check("alice");
    for (let i = 0; i < 2; i++) await limiter.check("bob");
    const denies = new Map<string, number>();
    for (const e of events) if (!e.allowed) denies.set(e.key, (denies.get(e.key) ?? 0) + 1);
    expect(events).toHaveLength(7);
    expect(events.every((e) => e.strategy === "gcra")).toBe(true);
    expect(denies.get("alice")).toBe(2);
    expect(denies.has("bob")).toBe(false);
  });
});
