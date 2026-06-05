import { ManualClock, type UnifiedAdmitter, withAdmissionAnalytics } from "throttlekit";
import { weightedFairEscrow } from "throttlekit/twotier";
import { describe, expect, it } from "vitest";
import { buildServiceConfig } from "../src/config.js";

/**
 * #291 — Cost Room P0 (confirm + spike). The Token-Budget Control Room (#282) renders a per-tenant
 * burn-rate / ETA off **`WeightedFairEscrowStats`** — the one server source with a real per-tenant
 * roster — sampled once per frame at `snapshot()` time. Before any of that is built, this spike pins
 * the exact stats contract the burn estimator rests on, and the two structural facts the design's
 * honesty depends on. It is intentionally a *contract guard*, not a feature test: nothing here imports
 * the (unbuilt) Cost Room — it pins what the Cost Room is allowed to assume.
 *
 * Design: `research/dashboard/designs/282-token-budget-control-room.md` §3 (the math) + §9 P0.
 * Findings note: `research/dashboard/designs/282-P0-confirmation.md`.
 *
 * The load-bearing subtlety this spike exists to lock down: **`stats()` does NOT roll the window** —
 * only a `check`/`checkSync` does. So a passive `stats()` read taken after a window boundary, with no
 * intervening check, reports the PREVIOUS window's `windowStart` and `used` until the next check. A
 * burn estimator that trusts `stats().windowStart` for a "resets in Ns" countdown would print a
 * negative number. The P2 accumulator MUST detect `windowStart + windowMs <= now` (a stale read) and
 * the `windowStart`-advanced case, exactly as design §3 step 1 requires.
 */

const BASE = 1_700_000_000_000; // epoch-aligned to a 1000ms grid (divisible by 1000)
const WINDOW = 1000;
const ws = (now: number): number => Math.floor(now / WINDOW) * WINDOW;

describe("#291 Cost Room P0 — WFE stats() is the burn-source contract", () => {
  it("windowStart is epoch-aligned and advances by exactly windowMs across a roll", () => {
    const clock = new ManualClock(BASE);
    const wfe = weightedFairEscrow({ limit: 100, windowMs: WINDOW, clock });

    wfe.checkSync("acct", 10);
    const s0 = wfe.stats();
    expect(s0.windowStart).toBe(ws(BASE)); // floor(now/windowMs)*windowMs
    expect(s0.tenants.find((t) => t.tenant === "acct")?.used).toBe(10);

    // Cross exactly one window boundary, then check → roll.
    clock.advance(WINDOW); // now = BASE + WINDOW, a fresh epoch-aligned window
    wfe.checkSync("acct", 3);
    const s1 = wfe.stats();
    expect(s1.windowStart).toBe(s0.windowStart + WINDOW); // advanced by exactly one window
    expect(s1.tenants.find((t) => t.tenant === "acct")?.used).toBe(3); // used reset, fresh debit
  });

  it("per-tenant used resets to 0 at the roll; tenants that don't re-check vanish (Δ = 0 across boundary)", () => {
    const clock = new ManualClock(BASE);
    const wfe = weightedFairEscrow({
      limit: 100,
      windowMs: WINDOW,
      weightOf: (t) => (t === "big" ? 4 : 1),
      clock,
    });

    wfe.checkSync("big", 30);
    wfe.checkSync("small", 10);
    expect(wfe.stats().totalUsed).toBe(40);

    clock.advance(WINDOW + 1); // past the boundary
    wfe.checkSync("big", 5); // only 'big' re-checks in the new window
    const s = wfe.stats();
    expect(s.totalUsed).toBe(5); // 'small' did not carry forward
    expect(s.tenants.find((t) => t.tenant === "big")?.used).toBe(5);
    // tenants.clear() at the roll means a tenant that doesn't re-check is ABSENT, not used:0 —
    // the burn accumulator must drop it rather than read a phantom 0 → negative delta.
    expect(s.tenants.find((t) => t.tenant === "small")).toBeUndefined();
  });
});

describe("#291 Cost Room P0 — passive stats() lag (the load-bearing burn-estimator trap)", () => {
  it("stats() does NOT roll: a read after the boundary with no intervening check is STALE", () => {
    const clock = new ManualClock(BASE);
    const wfe = weightedFairEscrow({ limit: 100, windowMs: WINDOW, clock });

    wfe.checkSync("acct", 40);
    const before = wfe.stats();
    expect(before.windowStart).toBe(ws(BASE));
    expect(before.totalUsed).toBe(40);

    // Advance several windows forward, but do NOT check.
    clock.advance(WINDOW * 3 + 7);
    const stale = wfe.stats();
    // stats() did not roll — windowStart and used are frozen at the prior window.
    expect(stale.windowStart).toBe(before.windowStart);
    expect(stale.totalUsed).toBe(40);
    // The live window edge is already in the PAST relative to this read: a naive
    // "resets in (windowStart + windowMs - now)" would go NEGATIVE. The P2 estimator must detect
    // `windowStart + windowMs <= now` and treat the read as stale rather than project off it.
    expect(stale.windowStart + WINDOW).toBeLessThan(clock.now());

    // A single check rolls it: windowStart jumps to the live window, used resets.
    wfe.checkSync("acct", 2);
    const rolled = wfe.stats();
    expect(rolled.windowStart).toBe(ws(clock.now()));
    expect(rolled.windowStart).toBeGreaterThan(stale.windowStart);
    expect(rolled.totalUsed).toBe(2);
  });
});

describe("#291 Cost Room P0 — initial + reset states the accumulator must guard", () => {
  it("before any check, windowStart is -Infinity (the warming case → arithmetic must be guarded)", () => {
    const clock = new ManualClock(BASE);
    const wfe = weightedFairEscrow({ limit: 100, windowMs: WINDOW, clock });

    const s = wfe.stats();
    expect(s.windowStart).toBe(Number.NEGATIVE_INFINITY);
    expect(s.tenants).toHaveLength(0);
    expect(s.totalUsed).toBe(0);
    // windowStart + windowMs is still -Infinity — the estimator must short-circuit to "burn n/a
    // (warming)" rather than feed -Infinity into a countdown or a rate denominator.
    expect(s.windowStart + WINDOW).toBe(Number.NEGATIVE_INFINITY);
  });

  it("reset(tenant) drops a tenant mid-window WITHOUT advancing windowStart (a drop that is not a roll)", () => {
    const clock = new ManualClock(BASE);
    const wfe = weightedFairEscrow({ limit: 100, windowMs: WINDOW, clock });

    wfe.checkSync("a", 20);
    wfe.checkSync("b", 15);
    const anchor = wfe.stats().windowStart;
    expect(wfe.stats().totalUsed).toBe(35);

    wfe.reset("a"); // 'a' leaves the active set mid-window
    const s = wfe.stats();
    expect(s.windowStart).toBe(anchor); // the window did NOT advance
    expect(s.tenants.find((t) => t.tenant === "a")).toBeUndefined();
    // A same-window usage decrease (totalUsed 35 → 15) that is NOT a boundary roll: the accumulator
    // must distinguish "tenant vanished" from "window rolled", or it logs a phantom negative burn.
    expect(s.totalUsed).toBe(15);
  });
});

describe("#291 Cost Room P0 — the cost lane is structurally dark on the server", () => {
  it("a server admitter built from a concurrency policy wires NO cost axis (cost lane stays empty)", async () => {
    const clock = new ManualClock(BASE);
    // The actual server config path: buildAdmitter assembles unifiedAdmission({ concurrency, rate? })
    // and never passes a `cost:` Limiter.
    const cfg = buildServiceConfig(
      JSON.stringify({ limiters: { cc: { concurrency: { minLimit: 1, maxLimit: 1 } } } }),
      { clock },
    );
    const admitter: UnifiedAdmitter | undefined = cfg.admitters.cc;
    if (admitter === undefined) throw new Error("expected the 'cc' admitter to be built");

    const tracked = withAdmissionAnalytics(admitter, { clock });
    const a1 = await tracked.admit({ key: "k" });
    const a2 = await tracked.admit({ key: "k" }); // 2nd concurrent admit denies on concurrency
    expect(a1.decision.allowed).toBe(true);
    expect(a2.decision.allowed).toBe(false);
    expect(a2.bindingAxis).toBe("concurrency");

    // Structural: no cost axis is wired, so lastDecisions().cost is undefined (never a Decision).
    expect(admitter.lastDecisions().cost).toBeUndefined();

    // Behavioral: the lane-segmented analytics show the cost lane permanently empty — so the Cost
    // Room must render "cost lane not configured", never an always-empty panel dressed as a feature.
    const an = tracked.analytics();
    expect(an.deniedByLane.cost).toBe(0);
    expect(an.topDeniedByLane.cost).toHaveLength(0);
    expect(an.deniedByLane.concurrency).toBeGreaterThan(0); // the denial landed on the real lane
  });
});
