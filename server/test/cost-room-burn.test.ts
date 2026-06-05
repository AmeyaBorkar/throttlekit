import { ManualClock } from "throttlekit";
import { weightedFairEscrow } from "throttlekit/twotier";
import { describe, expect, it } from "vitest";
import {
  BurnAccumulator,
  type CostRoomStats,
  buildCostRoom,
  costRoomSource,
  isCostRoomSnapshot,
} from "../src/monitor/burn.js";
import { createLensHub } from "../src/monitor/hub.js";

/**
 * #293 — Cost Room P2 (the bounded burn accumulation). The mandatory gate (design §9 P2) is the
 * ManualClock-across-window-boundary proof: (a) the burn rate resets at the roll, (b) the ETA caps at the
 * window edge. The rest pins the edge cases the #291 P0 hunt surfaced: passive-stats-lag (no phantom
 * burn), -Infinity warming, vanish-without-roll, the {error}-shape skip, and activity-ranked eviction.
 *
 * Design: `research/dashboard/designs/282-token-budget-control-room.md` §3-§4. Burn-source contract:
 * `server/test/cost-room-burn-source.test.ts` (#291 P0).
 */

const BASE = 1_700_000_000_000; // epoch-aligned to both 1000ms and 10_000ms grids
const WINDOW = 10_000;

const OPTS = {
  windowMs: WINDOW,
  unit: "tokens",
  minSpanMs: 1000,
  ringSize: 16,
  maxKeys: 64,
  renderCap: 12,
  redactKey: (k: string): string => k,
};

/** A synthetic single-tenant WFE stats frame. */
function mkStats(
  used: number,
  opts: { windowStart?: number; limit?: number; weight?: number } = {},
): CostRoomStats {
  const limit = opts.limit ?? 10_000;
  const windowStart = opts.windowStart ?? BASE;
  const effectiveLimit = limit;
  return {
    windowStart,
    limit,
    effectiveLimit,
    pool: effectiveLimit - used,
    totalUsed: used,
    tenants: [{ tenant: "acct", weight: opts.weight ?? 1, used }],
  };
}

describe("#293 Cost Room P2 — burn rate resets at the window roll (mandatory gate a)", () => {
  it("computes a steady burn mid-window, then resets to warming at the roll", () => {
    const clock = new ManualClock(BASE);
    const wfe = weightedFairEscrow({ limit: 1_000_000, windowMs: WINDOW, clock });
    const source = costRoomSource(
      "cost",
      () => wfe.stats(),
      { windowMs: WINDOW, minSpanMs: 1000 },
      clock,
    );

    // First sample: 1 ring entry → warming.
    wfe.checkSync("acct", 1000);
    let snap = source();
    expect(snap.tenants[0]?.burnPerSec).toBeNull();
    expect(snap.tenants[0]?.burnReason).toBe("warming");

    // Five steady frames: +1000 used every 1000ms → 1000 tokens/s.
    for (let i = 0; i < 5; i++) {
      clock.advance(1000);
      wfe.checkSync("acct", 1000);
      snap = source();
    }
    const row = snap.tenants.find((r) => r.tenant === "acct");
    expect(row?.burnPerSec).toBeCloseTo(1000, 5);
    expect(row?.burnReason).toBeUndefined(); // burning — no degradation reason

    // Cross the window boundary (BASE+10_000): the next check rolls WFE, the accumulator detects the
    // windowStart advance and clears the ring → back to warming, used reset.
    clock.advance(6000); // BASE+5000 → BASE+11_000, past the BASE+10_000 edge
    wfe.checkSync("acct", 1000);
    snap = source();
    const rolled = snap.tenants.find((r) => r.tenant === "acct");
    expect(snap.windowStart).toBe(BASE + WINDOW); // advanced by exactly one window
    expect(rolled?.used).toBe(1000); // used reset, fresh debit
    expect(rolled?.burnPerSec).toBeNull(); // ring cleared at the roll → 1 sample → warming
    expect(rolled?.burnReason).toBe("warming");
  });
});

describe("#293 Cost Room P2 — ETA caps at the window edge (mandatory gate b)", () => {
  it("a within-window floor-ETA is NOT capped; a beyond-window floor-ETA IS capped", () => {
    // Within: L=10_000 (sole tenant ⇒ g=10_000), burn 1000/s, used 2000 at now=BASE+1000 →
    // eta = now + (10000-2000)/1000·1000 = BASE+9000 < window edge BASE+10_000.
    const within = new BurnAccumulator(16, 64);
    within.sample(mkStats(1000), BASE);
    within.sample(mkStats(2000), BASE + 1000);
    const wSnap = buildCostRoom("cost", mkStats(2000), within, BASE + 1000, OPTS);
    const wRow = wSnap.tenants[0];
    expect(wRow?.burnPerSec).toBeCloseTo(1000, 5);
    expect(wRow?.etaToExhaustAt).toBeCloseTo(BASE + 9000, 5);
    expect(wRow?.etaCappedByWindow).toBe(false);

    // Beyond: L=1_000_000 (g=1_000_000), same 1000/s burn — the floor is ~996s away, far past the 10s
    // window, so the raw ETA is false and the clamp fires.
    const beyond = new BurnAccumulator(16, 64);
    beyond.sample(mkStats(1000, { limit: 1_000_000 }), BASE);
    beyond.sample(mkStats(2000, { limit: 1_000_000 }), BASE + 1000);
    const bSnap = buildCostRoom(
      "cost",
      mkStats(2000, { limit: 1_000_000 }),
      beyond,
      BASE + 1000,
      OPTS,
    );
    const bRow = bSnap.tenants[0];
    expect(bRow?.etaToExhaustAt).not.toBeNull();
    expect(bRow?.etaCappedByWindow).toBe(true);
  });

  it("the pool ETA is present only when the pool exhausts within the window", () => {
    // Within: pool 8000, burn 1000/s → 8s, anchored at BASE+1000 → BASE+9000 < edge → present.
    const within = new BurnAccumulator(16, 64);
    within.sample(mkStats(1000), BASE);
    within.sample(mkStats(2000), BASE + 1000);
    const wSnap = buildCostRoom("cost", mkStats(2000), within, BASE + 1000, OPTS);
    expect(wSnap.poolEtaToExhaustAt).toBeCloseTo(BASE + 9000, 5); // pool 8000 / 1000 = 8s

    // Beyond: a huge pool at the same burn refills before it empties → omitted (renderer shows reset).
    const beyond = new BurnAccumulator(16, 64);
    beyond.sample(mkStats(1000, { limit: 1_000_000 }), BASE);
    beyond.sample(mkStats(2000, { limit: 1_000_000 }), BASE + 1000);
    const bSnap = buildCostRoom(
      "cost",
      mkStats(2000, { limit: 1_000_000 }),
      beyond,
      BASE + 1000,
      OPTS,
    );
    expect(bSnap.poolEtaToExhaustAt).toBeUndefined();
  });
});

describe("#293 Cost Room P2 — burn-source edge cases the accumulator must guard", () => {
  it("passive-stats-lag: a stale read (used unchanged, time jumped) decays burn, never phantom-increases it", () => {
    const acc = new BurnAccumulator(16, 64);
    acc.sample(mkStats(1000), BASE);
    acc.sample(mkStats(2000), BASE + 1000);
    const before = acc.rate("acct", 1000);
    expect(before).toBeCloseTo(1000, 5);

    // Stale: stats() did not roll, used is unchanged, but the clock jumped forward.
    acc.sample(mkStats(2000), BASE + 5000);
    const after = acc.rate("acct", 1000);
    expect(after).not.toBeNull();
    expect(after as number).toBeLessThan(before as number); // decays toward 0 — no phantom burn
  });

  it("-Infinity warming: a pre-first-check read samples nothing and builds an empty, crash-free snapshot", () => {
    const acc = new BurnAccumulator(16, 64);
    const empty: CostRoomStats = {
      windowStart: Number.NEGATIVE_INFINITY,
      limit: 100,
      effectiveLimit: 100,
      pool: 100,
      totalUsed: 0,
      tenants: [],
    };
    acc.sample(empty, BASE); // no-op (non-finite windowStart)
    const snap = buildCostRoom("cost", empty, acc, BASE, OPTS);
    expect(snap.windowStart).toBe(Number.NEGATIVE_INFINITY);
    expect(snap.tenants).toHaveLength(0);
    expect(snap.activeTenants).toBe(0);
    expect(snap.poolEtaToExhaustAt).toBeUndefined();
  });

  it("vanish-without-roll: a tenant absent from a frame is dropped; survivors are unaffected", () => {
    const acc = new BurnAccumulator(16, 64);
    const two = (a: number, b: number): CostRoomStats => ({
      windowStart: BASE,
      limit: 10_000,
      effectiveLimit: 10_000,
      pool: 10_000 - a - b,
      totalUsed: a + b,
      tenants: [
        { tenant: "a", weight: 1, used: a },
        { tenant: "b", weight: 1, used: b },
      ],
    });
    acc.sample(two(1000, 500), BASE);
    acc.sample(two(2000, 1000), BASE + 1000);
    expect(acc.rate("a", 1000)).not.toBeNull();
    expect(acc.rate("b", 1000)).not.toBeNull();

    // 'b' vanishes mid-window (reset / eviction) — same windowStart, no roll.
    acc.sample(
      {
        windowStart: BASE,
        limit: 10_000,
        effectiveLimit: 10_000,
        pool: 7000,
        totalUsed: 3000,
        tenants: [{ tenant: "a", weight: 1, used: 3000 }],
      },
      BASE + 2000,
    );
    expect(acc.rate("b", 1000)).toBeNull(); // dropped — no ghost series
    expect(acc.rate("a", 1000)).not.toBeNull(); // survivor unaffected
  });

  it("the {error}-shape read is skipped honestly (the source throws → the hub drops it)", () => {
    const clock = new ManualClock(BASE);
    const src = costRoomSource(
      "cost",
      () => ({ error: "stats blew up" }),
      { windowMs: WINDOW },
      clock,
    );
    expect(() => src()).toThrow(/unavailable/i);
    expect(isCostRoomSnapshot({ error: "x" })).toBe(false);
    expect(isCostRoomSnapshot({ policy: "p", tenants: [] })).toBe(true);
  });

  it("activity-ranked eviction: above maxKeys, only the hottest tenants keep a warm ring", () => {
    const acc = new BurnAccumulator(16, 2); // keep only the top 2 by used
    const three = (hi: number, mid: number, lo: number): CostRoomStats => ({
      windowStart: BASE,
      limit: 1000,
      effectiveLimit: 1000,
      pool: 1000 - hi - mid - lo,
      totalUsed: hi + mid + lo,
      tenants: [
        { tenant: "hi", weight: 1, used: hi },
        { tenant: "mid", weight: 1, used: mid },
        { tenant: "lo", weight: 1, used: lo },
      ],
    });
    acc.sample(three(30, 20, 10), BASE);
    acc.sample(three(60, 40, 20), BASE + 1000);
    expect(acc.rate("hi", 1000)).not.toBeNull(); // hottest — retained, accrues a rate
    expect(acc.rate("lo", 1000)).toBeNull(); // coldest — evicted every frame, never 2 samples
  });
});

describe("#293 Cost Room P2 — hub integration via the existing trackStats door", () => {
  it("a cost-room source populates snapshot.costRooms and stays out of the generic stats feed", () => {
    const clock = new ManualClock(BASE);
    const wfe = weightedFairEscrow({ limit: 100_000, windowMs: WINDOW, clock });
    const hub = createLensHub({ clock });
    hub.trackStats(
      "budget",
      "cost-room",
      costRoomSource("budget", () => wfe.stats(), { windowMs: WINDOW, minSpanMs: 1000 }, clock),
    );

    wfe.checkSync("acct", 1000);
    clock.advance(1000);
    wfe.checkSync("acct", 1000);
    const snap = hub.snapshot();

    expect(snap.costRooms).toBeDefined();
    expect(snap.costRooms).toHaveLength(1);
    expect(snap.costRooms?.[0]?.policy).toBe("budget");
    expect(snap.costRooms?.[0]?.unit).toBe("units (cost)"); // default label
    expect(snap.costRooms?.[0]?.enforced).toBe(true);
    expect(snap.costRooms?.[0]?.scope).toBe("single-node");
    expect(snap.costRooms?.[0]?.tenants[0]?.tenant).toBe("acct");
    // Routed away from the generic stats feed — not double-counted.
    expect(snap.stats.find((s) => s.kind === "cost-room")).toBeUndefined();
  });

  it("a throwing cost-room source is dropped from costRooms without crashing the snapshot", () => {
    const clock = new ManualClock(BASE);
    const hub = createLensHub({ clock });
    hub.trackStats("broken", "cost-room", () => {
      throw new Error("boom");
    });
    const snap = hub.snapshot();
    expect(snap.costRooms).toBeUndefined(); // nothing valid → field omitted
  });
});

describe("#293 Cost Room P2 — defensive hardening (from the adversarial pass)", () => {
  it("rate() returns null (never Infinity) for a zero or negative span, even at minSpanMs=0", () => {
    const acc = new BurnAccumulator(16, 64);
    acc.sample(mkStats(100), BASE);
    acc.sample(mkStats(200), BASE); // same instant → span 0
    expect(acc.rate("acct", 0)).toBeNull();
    expect(acc.rate("acct", 1000)).toBeNull();
  });

  it("a non-finite used (Infinity/NaN) is coerced to 0 — never an Infinity burn or pool", () => {
    const acc = new BurnAccumulator(16, 64);
    const inf = (used: number): CostRoomStats => ({
      windowStart: BASE,
      limit: 100,
      effectiveLimit: 100,
      pool: 100,
      totalUsed: 0,
      tenants: [{ tenant: "a", weight: 1, used }],
    });
    acc.sample(inf(Number.POSITIVE_INFINITY), BASE);
    acc.sample(inf(Number.POSITIVE_INFINITY), BASE + 1000);
    const r = acc.rate("a", 1000);
    expect(r === null || Number.isFinite(r)).toBe(true);

    const snap = buildCostRoom("cost", inf(Number.POSITIVE_INFINITY), acc, BASE + 1000, OPTS);
    const burn = snap.tenants[0]?.burnPerSec;
    expect(burn === null || Number.isFinite(burn)).toBe(true);
    expect(Number.isFinite(snap.pool)).toBe(true);
  });

  it("a tenant element with a missing/empty key is dropped, not rendered as a blank row", () => {
    const acc = new BurnAccumulator(16, 64);
    const messy: CostRoomStats = {
      windowStart: BASE,
      limit: 1000,
      effectiveLimit: 1000,
      pool: 700,
      totalUsed: 300,
      tenants: [
        { tenant: "good", weight: 1, used: 200 },
        { tenant: "", weight: 1, used: 100 }, // empty key
        { weight: 1, used: 50 } as unknown as { tenant: string; weight: number; used: number }, // missing key
      ],
    };
    acc.sample(messy, BASE);
    const snap = buildCostRoom("cost", messy, acc, BASE, OPTS);
    expect(snap.tenants.map((t) => t.tenant)).toEqual(["good"]);
    expect(snap.activeTenants).toBe(1); // only the valid tenant counts toward "+N more"
  });

  it("a NaN windowStart is treated as warming, not a crash or a false countdown", () => {
    const acc = new BurnAccumulator(16, 64);
    const corrupt: CostRoomStats = {
      windowStart: Number.NaN,
      limit: 100,
      effectiveLimit: 100,
      pool: 100,
      totalUsed: 0,
      tenants: [{ tenant: "a", weight: 1, used: 10 }],
    };
    acc.sample(corrupt, BASE); // NaN → coerced to -Infinity → skipped (warming)
    const snap = buildCostRoom("cost", corrupt, acc, BASE, OPTS);
    expect(snap.windowStart).toBe(Number.NEGATIVE_INFINITY);
    expect(snap.tenants[0]?.burnPerSec).toBeNull();
    expect(snap.tenants[0]?.etaCappedByWindow).toBe(false);
  });

  it("costRoomSource bumps maxKeys up to renderCap so every rendered tenant stays tracked", () => {
    // Requested maxKeys 2 < renderCap 12 ⇒ effective maxKeys is bumped to 12, so all 5 tenants keep a ring.
    const clock = new ManualClock(BASE);
    const wfe = weightedFairEscrow({ limit: 1_000_000, windowMs: WINDOW, clock });
    const source = costRoomSource(
      "cost",
      () => wfe.stats(),
      { windowMs: WINDOW, minSpanMs: 1000, maxKeys: 2 },
      clock,
    );
    const ids = ["a", "b", "c", "d", "e"];
    for (const id of ids) wfe.checkSync(id, 1000);
    source();
    clock.advance(1000);
    for (const id of ids) wfe.checkSync(id, 1000);
    const snap = source();
    expect(snap.tenants).toHaveLength(5);
    expect(snap.tenants.every((t) => t.burnPerSec !== null)).toBe(true); // none stuck warming
  });
});
