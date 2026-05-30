import { describe, expect, it } from "vitest";
import { unifiedAdmission } from "../../src/admission";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { adaptiveConcurrency } from "../../src/concurrency/adaptive";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";
import { bindingAxisOf } from "../../src/observability/otel";
import { MemoryStore } from "../../src/stores/memory";

/**
 * The 1.0 `UnifiedAdmission.bindingAxis` decision (TK-1410): the ergonomic axis-of-denial on the result
 * wrapper. The load-bearing invariant is that it never disagrees with the two existing introspection
 * paths — `bindingAxisOf(admitter.lastDecisions())` and the OTel `throttlekit.binding_axis` attribute
 * (which is derived from the same `bindingAxisOf`). These tests pin that equivalence on every deny axis,
 * plus the allow + policy-deny paths.
 */

function makeLimiter(limit: number, clock: ManualClock) {
  return rateLimit({
    strategy: fixedWindow({ limit, windowMs: 60_000 }),
    store: new MemoryStore({ clock }),
    clock,
  });
}

describe("unifiedAdmission — bindingAxis (result wrapper)", () => {
  it("reports `rate` when the rate axis binds, agreeing with lastDecisions()", () => {
    const clock = new ManualClock(0);
    const admitter = unifiedAdmission({
      rate: makeLimiter(1, clock), // tight
      cost: makeLimiter(1000, clock), // roomy
      concurrency: adaptiveConcurrency({ clock, minLimit: 100, initialLimit: 100 }),
      clock,
    });
    admitter.admitSync({ key: "k" }).release(); // consume the 1 rate unit, free the slot
    const denied = admitter.admitSync({ key: "k" });
    expect(denied.decision.allowed).toBe(false);
    expect(denied.bindingAxis).toBe("rate");
    expect(denied.bindingAxis).toBe(bindingAxisOf(admitter.lastDecisions()));
  });

  it("reports `concurrency` when the concurrency axis binds (checked first)", () => {
    const clock = new ManualClock(0);
    const admitter = unifiedAdmission({
      rate: makeLimiter(1000, clock),
      cost: makeLimiter(1000, clock),
      concurrency: adaptiveConcurrency({ clock, minLimit: 1, initialLimit: 1 }),
      clock,
    });
    admitter.admitSync({ key: "k" }); // holds the only slot (NOT released)
    const denied = admitter.admitSync({ key: "k" });
    expect(denied.decision.allowed).toBe(false);
    expect(denied.bindingAxis).toBe("concurrency");
    expect(denied.bindingAxis).toBe(bindingAxisOf(admitter.lastDecisions()));
  });

  it("reports `cost` when the cost axis binds", () => {
    const clock = new ManualClock(0);
    const admitter = unifiedAdmission({
      rate: makeLimiter(1000, clock),
      cost: makeLimiter(1, clock), // tight
      concurrency: adaptiveConcurrency({ clock, minLimit: 100, initialLimit: 100 }),
      clock,
    });
    admitter.admitSync({ key: "k", cost: 1 }).release();
    const denied = admitter.admitSync({ key: "k", cost: 1 });
    expect(denied.decision.allowed).toBe(false);
    expect(denied.bindingAxis).toBe("cost");
    expect(denied.bindingAxis).toBe(bindingAxisOf(admitter.lastDecisions()));
  });

  it("is undefined when admitted", () => {
    const clock = new ManualClock(0);
    const admitter = unifiedAdmission({
      rate: makeLimiter(1000, clock),
      cost: makeLimiter(1000, clock),
      clock,
    });
    const ok = admitter.admitSync({ key: "k" });
    expect(ok.decision.allowed).toBe(true);
    expect(ok.bindingAxis).toBeUndefined();
    expect(bindingAxisOf(admitter.lastDecisions())).toBeUndefined();
  });

  it("leaves bindingAxis undefined on a joint-LP policy deny (policyDenied carries it)", () => {
    const clock = new ManualClock(0);
    const admitter = unifiedAdmission({
      rate: makeLimiter(1000, clock),
      cost: makeLimiter(1000, clock),
      policy: "joint-lp",
      jointLp: { duals: { rate: 0, cost: 1 } },
      clock,
    });
    // value (0) < bid (rate 0 + cost·1 = 1) ⇒ the bid-price filter denies, no axis bound.
    const denied = admitter.admitSync({ key: "k", cost: 1, value: 0 });
    expect(denied.decision.allowed).toBe(false);
    expect(denied.policyDenied).toBe(true);
    expect(denied.bindingAxis).toBeUndefined();
    expect(bindingAxisOf(admitter.lastDecisions())).toBeUndefined();
  });

  it("lastDecisions() leaves an unconfigured axis undefined (Partial snapshot)", () => {
    const clock = new ManualClock(0);
    const admitter = unifiedAdmission({ rate: makeLimiter(1, clock), clock }); // rate only
    admitter.admitSync({ key: "k" }).release();
    admitter.admitSync({ key: "k" }); // rate denies
    const snap = admitter.lastDecisions();
    expect(snap.rate?.allowed).toBe(false);
    expect(snap.concurrency).toBeUndefined();
    expect(snap.cost).toBeUndefined();
  });
});
