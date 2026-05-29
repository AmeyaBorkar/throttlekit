/**
 * TK-1331 — eager (event-driven) handoff (D-DAC-20). The committed gate for Feature E:
 * acknowledged handoff makes `Σ inflight ≤ L_global` a HARD bound (D-DAC-19), but at a
 * ramp-latency cost (~2 heartbeats, batched onto the periodic tick). Eager handoff fires
 * OFF-CYCLE beats on three local triggers — PULL (capped below fair share), PUSH (in-flight
 * drained below the lowered share), ACK (applied a generation-changing grant) — collapsing
 * the ramp toward the physical floor (drain + one round-trip) WITHOUT loosening the bound.
 *
 * This drives the REAL `distributedAdaptiveConcurrency` guard + REAL
 * `TestConcurrencyCoordinator` (handoff on) through a deterministic discrete-event sim over
 * a `ManualClock`, sweeping the joiner's arrival PHASE across a heartbeat period, and asserts:
 *
 *   1. THE HARD BOUND HOLDS, eager or not, at EVERY instant and EVERY phase: Σ inflight over
 *      live nodes ≤ L_global. (Safety is inherited — an off-cycle beat is just a Report/
 *      Reallocate at a different time, a subset of interleavings the exhaustive async twin
 *      `distributed-async-leasing-model.test.ts` already proves safe. This is the end-to-end
 *      regression guard that no eager timing reopens the 1.5× residual.)
 *   2. THE RAMP WIN: eager mean ramp-to-fair is materially below periodic-only (which is a
 *      flat ~2×heartbeat). The residual is the irreducible pull-model "incumbent discovers on
 *      its next beat" term ([drain+RTT, heartbeat]); push (coordinator→incumbent) would remove
 *      it — documented as future, NOT claimed here.
 *
 * Plus focused unit tests: the triggers fire on the right events, steady state adds ZERO eager
 * beats (the perpetual-probe bug the model caught, fixed), eager-off is byte-identical, and
 * eagerHandoff requires a scheduler with setTimer.
 */
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Lease } from "../../src/concurrency/adaptive";
import { ManualClock, systemClock } from "../../src/core/clock";
import {
  type HeartbeatScheduler,
  RedisConcurrencyCoordinator,
  TestConcurrencyCoordinator,
  distributedAdaptiveConcurrency,
} from "../../src/index";
import { fromNodeRedis } from "../../src/redis/clients";

const KEY = "shared-backend";
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * A deterministic, clock-driven {@link HeartbeatScheduler}: the periodic beat and one-shot
 * `setTimer` eager beats are both parked with an absolute due time, and the driver fires them
 * when the {@link ManualClock} reaches that time. Models the default scheduler's "first beat on
 * construction, then every heartbeatMs" + the eager one-shot, with zero real timers.
 */
class ManualScheduler implements HeartbeatScheduler {
  periodicFn: (() => void) | undefined;
  periodicEvery = 0;
  nextPeriodicAt = Number.POSITIVE_INFINITY;
  timers: Array<{ fn: () => void; at: number; live: boolean }> = [];
  constructor(private readonly clock: ManualClock) {}

  schedule(fn: () => void, everyMs: number): { cancel(): void } {
    this.periodicFn = fn;
    this.periodicEvery = everyMs;
    this.nextPeriodicAt = this.clock.now(); // first beat fires immediately (next driver tick)
    return {
      cancel: (): void => {
        this.periodicFn = undefined;
        this.nextPeriodicAt = Number.POSITIVE_INFINITY;
      },
    };
  }
  setTimer(fn: () => void, delayMs: number): { cancel(): void } {
    const t = { fn, at: this.clock.now() + delayMs, live: true };
    this.timers.push(t);
    return {
      cancel: (): void => {
        t.live = false;
      },
    };
  }
  /** Collect (and consume) every beat due at the current clock time. */
  dueFns(): Array<() => void> {
    const now = this.clock.now();
    const out: Array<() => void> = [];
    if (this.periodicFn !== undefined && now >= this.nextPeriodicAt) {
      out.push(this.periodicFn);
      this.nextPeriodicAt = now + this.periodicEvery;
    }
    for (const t of this.timers) {
      if (t.live && now >= t.at) {
        t.live = false;
        out.push(t.fn);
      }
    }
    this.timers = this.timers.filter((t) => t.live);
    return out;
  }
}

interface SimGuard {
  id: string;
  guard: ReturnType<typeof distributedAdaptiveConcurrency>;
  sched: ManualScheduler;
  held: Array<{ lease: Lease; doneAt: number }>;
  joinAt: number;
}

interface RampResult {
  rampToFairMs: number | null;
  maxSum: number;
}

/**
 * Drive a 1→2 ramp: incumbent A live from t=0 (saturates L), joiner B arrives at `bJoinAt`.
 * Greedy saturated demand on both; service time `serviceMs`. Returns the joiner's ramp-to-fair
 * latency and the peak Σ inflight observed over live nodes (the hard-bound witness).
 */
async function driveRamp(
  eager: boolean,
  opts: { L: number; serviceMs: number; hb: number; bJoinAt: number; horizon: number },
): Promise<RampResult> {
  const { L, serviceMs, hb, bJoinAt, horizon } = opts;
  const clock = new ManualClock(0);
  const coord = new TestConcurrencyCoordinator({
    acknowledgedHandoff: true,
    aggregate: "min",
    clock,
  });
  const fair = Math.floor(L / 2);

  const mk = (id: string): SimGuard => {
    const sched = new ManualScheduler(clock);
    const guard = distributedAdaptiveConcurrency({
      coordinator: coord,
      nodeId: id,
      key: KEY,
      local: { minLimit: L, maxLimit: L, initialLimit: L, clock },
      heartbeatMs: hb,
      leaseTtlMs: 2 * hb,
      onCoordinatorOutage: "fail-closed",
      ...(eager ? { eagerHandoff: true, minHeartbeatMs: Math.max(1, Math.floor(hb / 10)) } : {}),
      clock,
      scheduler: sched,
    });
    return { id, guard, sched, held: [], joinAt: clock.now() };
  };

  const guards: SimGuard[] = [mk("A")];
  let bMade = false;
  let maxSum = 0;
  let rampToFair: number | null = null;

  const liveSum = (): number => {
    const { shares } = coord.peek(KEY);
    return guards.reduce((acc, g) => acc + (g.id in shares ? g.guard.inflight : 0), 0);
  };

  for (let t = 0; t <= horizon; t++) {
    clock.set(t);
    if (!bMade && t >= bJoinAt) {
      guards.push(mk("B"));
      bMade = true;
    }
    // 1. releases (completions) at this tick — drains non-revocable in-flight.
    for (const g of guards) {
      const due = g.held.filter((h) => h.doneAt <= t);
      g.held = g.held.filter((h) => h.doneAt > t);
      for (const h of due) h.lease.release();
    }
    // 2. fire every due beat (periodic + eager), then let grants apply.
    let fired = false;
    for (const g of guards) {
      for (const fn of g.sched.dueFns()) {
        fn();
        fired = true;
      }
    }
    if (fired) await flush();
    // 3. greedy admit up to the gate (saturated demand).
    for (const g of guards) {
      for (;;) {
        const lease = g.guard.acquire();
        if (!lease.ok) break;
        g.held.push({ lease, doneAt: t + serviceMs });
      }
    }
    // 4. measure: hard bound + ramp.
    const sum = liveSum();
    if (sum > maxSum) maxSum = sum;
    const b = guards.find((g) => g.id === "B");
    if (b !== undefined && rampToFair === null && b.guard.inflight >= fair) {
      rampToFair = t - bJoinAt;
    }
  }
  for (const g of guards) await g.guard.close();
  return { rampToFairMs: rampToFair, maxSum };
}

describe("eager handoff — hard bound preserved + ramp win (real guard, swept phase, TK-1331)", () => {
  it("Σ inflight ≤ L_global at every phase (eager AND periodic), and eager mean ramp ≪ periodic", async () => {
    const L = 4;
    const hb = 200;
    const serviceMs = 30; // not a divisor of hb (avoid beat/completion aliasing)
    const phases = [0, 37, 80, 123, 166]; // join offsets across one heartbeat period
    const periodic: number[] = [];
    const eager: number[] = [];
    let worstSum = 0;

    for (const phase of phases) {
      const bJoinAt = 1000 + phase;
      const horizon = bJoinAt + 6 * hb;
      const rp = await driveRamp(false, { L, serviceMs, hb, bJoinAt, horizon });
      const re = await driveRamp(true, { L, serviceMs, hb, bJoinAt, horizon });
      worstSum = Math.max(worstSum, rp.maxSum, re.maxSum);
      // The hard bound is the headline safety claim — it must hold for BOTH, every phase.
      expect(rp.maxSum, `periodic Σinflight (phase ${phase})`).toBeLessThanOrEqual(L);
      expect(re.maxSum, `eager Σinflight (phase ${phase})`).toBeLessThanOrEqual(L);
      expect(rp.rampToFairMs, `periodic ramped (phase ${phase})`).not.toBeNull();
      expect(re.rampToFairMs, `eager ramped (phase ${phase})`).not.toBeNull();
      periodic.push(rp.rampToFairMs as number);
      eager.push(re.rampToFairMs as number);
    }

    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    const periodicMean = mean(periodic);
    const eagerMean = mean(eager);

    // Periodic-only ramp is a flat ~2×heartbeat (one beat for the incumbent to report the
    // drain, one for the joiner to pick up). Eager removes the second beat entirely.
    expect(periodicMean, "periodic-only ramp is ~2 heartbeats").toBeGreaterThanOrEqual(1.5 * hb);
    // THE WIN: eager mean ramp is well under the periodic mean. Conservative bound (≤ 60% of
    // periodic) — the swept mean is far better, but this is the robust regression floor.
    expect(
      eagerMean,
      `eager mean ${eagerMean} must beat periodic mean ${periodicMean}`,
    ).toBeLessThan(0.6 * periodicMean);
    // And the eager BEST case approaches the physical floor (drain + a round-trip), ≪ a heartbeat.
    expect(Math.min(...eager), "eager best case approaches the floor").toBeLessThan(hb);
    // Sanity: the swept peak never breached the budget anywhere.
    expect(worstSum).toBeLessThanOrEqual(L);
  });
});

describe("eager handoff — triggers fire on the right events, none at steady state (TK-1331)", () => {
  it("schedules an eager beat on PULL/ACK during a ramp, but ZERO at steady state", async () => {
    const clock = new ManualClock(0);
    const coord = new TestConcurrencyCoordinator({
      acknowledgedHandoff: true,
      aggregate: "min",
      clock,
    });
    const L = 4;
    let setTimerCalls = 0;
    const mk = (id: string) => {
      const inner = new ManualScheduler(clock);
      const sched: HeartbeatScheduler = {
        schedule: (fn, ev) => inner.schedule(fn, ev),
        setTimer: (fn, d) => {
          setTimerCalls++;
          return inner.setTimer(fn, d);
        },
      };
      return {
        sched: inner,
        guard: distributedAdaptiveConcurrency({
          coordinator: coord,
          nodeId: id,
          key: KEY,
          local: { minLimit: L, maxLimit: L, initialLimit: L, clock },
          heartbeatMs: 200,
          leaseTtlMs: 400,
          onCoordinatorOutage: "fail-closed",
          eagerHandoff: true,
          minHeartbeatMs: 20,
          clock,
          scheduler: sched,
        }),
      };
    };
    const a = mk("A");
    const b = mk("B");

    // A solo ⇒ share 4; saturate.
    await a.guard.heartbeat();
    const heldA: Lease[] = [];
    for (;;) {
      const l = a.guard.acquire();
      if (!l.ok) break;
      heldA.push(l);
    }
    expect(a.guard.inflight).toBe(4);

    // B joins with demand it can't satisfy (share 0, below fair) ⇒ PULL schedules an eager beat.
    await b.guard.heartbeat();
    const before = setTimerCalls;
    expect(b.guard.acquire().ok).toBe(false); // demand while capped below fair
    expect(setTimerCalls, "PULL schedules an eager beat for the starved joiner").toBeGreaterThan(
      before,
    );

    // A re-beats ⇒ committed share 2 (L=4 split over 2 nodes; gen change) ⇒ ACK schedules a beat.
    const beforeAck = setTimerCalls;
    await a.guard.heartbeat();
    expect(a.guard.stats().share).toBe(2);
    expect(
      setTimerCalls,
      "ACK schedules an eager beat after applying the lowered gen",
    ).toBeGreaterThan(beforeAck);

    // Converge: A drains to its fair share 2, both settle to the steady 2/2 split.
    while (heldA.length > 2) heldA.pop()?.release();
    // Run several beats to settle.
    for (let i = 0; i < 6; i++) {
      await a.guard.heartbeat();
      await b.guard.heartbeat();
    }
    // STEADY STATE: both at their fair share, saturated. NO eager beat should be scheduled
    // even under continuous demand — the perpetual-probe bug (a node at fair share is always
    // "blocked by share") that the model caught, now fixed (probe only when BELOW fair).
    const heldB: Lease[] = [];
    for (;;) {
      const l = b.guard.acquire();
      if (!l.ok) break;
      heldB.push(l);
    }
    const steadyBefore = setTimerCalls;
    for (let i = 0; i < 50; i++) {
      const l = b.guard.acquire(); // continuous demand at steady state
      if (l.ok) heldB.push(l);
    }
    expect(setTimerCalls, "steady state adds ZERO eager beats (no perpetual probing)").toBe(
      steadyBefore,
    );

    await a.guard.close();
    await b.guard.close();
  });
});

describe("eager handoff — config + compatibility (TK-1331)", () => {
  it("eagerHandoff: true requires a scheduler with setTimer", () => {
    const clock = new ManualClock(0);
    const coord = new TestConcurrencyCoordinator({ clock });
    const noSetTimer: HeartbeatScheduler = { schedule: () => ({ cancel: () => {} }) };
    expect(() =>
      distributedAdaptiveConcurrency({
        coordinator: coord,
        nodeId: "n",
        key: KEY,
        eagerHandoff: true,
        clock,
        scheduler: noSetTimer,
      }),
    ).toThrow(/setTimer/);
  });

  it("eager OFF never calls setTimer (byte-identical scheduling path)", async () => {
    const clock = new ManualClock(0);
    const coord = new TestConcurrencyCoordinator({ acknowledgedHandoff: true, clock });
    let setTimerCalls = 0;
    const inner = new ManualScheduler(clock);
    const sched: HeartbeatScheduler = {
      schedule: (fn, ev) => inner.schedule(fn, ev),
      setTimer: (fn, d) => {
        setTimerCalls++;
        return inner.setTimer(fn, d);
      },
    };
    const guard = distributedAdaptiveConcurrency({
      coordinator: coord,
      nodeId: "n",
      key: KEY,
      local: { minLimit: 4, maxLimit: 4, initialLimit: 4, clock },
      heartbeatMs: 200,
      leaseTtlMs: 400,
      onCoordinatorOutage: "fail-closed",
      clock,
      scheduler: sched, // setTimer present, but eagerHandoff is OFF
    });
    await guard.heartbeat();
    for (let i = 0; i < 10; i++) guard.acquire();
    expect(setTimerCalls, "eager OFF never schedules an off-cycle beat").toBe(0);
    await guard.close();
  });
});

// Dual-path: the eager guard drives the REAL Redis Lua coordinator to the same hard bound.
// Eager handoff is wire-IDENTICAL to the non-eager path (reportedGen/lastReportedInflight are
// guard-local; the report fields sent are unchanged), so the 26 coordinator-conformance cases
// already prove Redis handles an eager guard's reports. This integration drives a full ramp
// end-to-end. Beats are MANUAL (non-firing scheduler) so it is deterministic — no timer flake.
const redisUrl = process.env.THROTTLEKIT_TEST_REDIS;
const dRedis = redisUrl ? describe : describe.skip;

dRedis("eager handoff — hard bound holds against a live Redis coordinator (TK-1331)", () => {
  // biome-ignore lint/suspicious/noExplicitAny: the redis client type is structural here.
  let client: any;
  beforeAll(async () => {
    client = createClient({ url: redisUrl as string, database: 14 });
    await client.connect();
    await client.flushDb();
  });
  afterAll(async () => {
    if (client !== undefined) await client.quit();
  });

  it("incumbent → joiner handoff via an eager guard keeps Σ inflight ≤ L_global, then ramps", async () => {
    const coord = new RedisConcurrencyCoordinator({
      client: fromNodeRedis(client),
      acknowledgedHandoff: true,
      aggregate: "min",
      prefix: "tk:eagertest:",
    });
    // Non-firing scheduler: captures the periodic + eager timers but NEVER fires them, so the
    // only beats are the manual `heartbeat()` calls below — deterministic against real Redis.
    const noFire: HeartbeatScheduler = {
      schedule: () => ({ cancel: () => {} }),
      setTimer: () => ({ cancel: () => {} }),
    };
    const key = `eager-${Date.now()}`;
    const mk = (id: string) =>
      distributedAdaptiveConcurrency({
        coordinator: coord,
        nodeId: id,
        key,
        local: { minLimit: 4, maxLimit: 4, initialLimit: 4 },
        heartbeatMs: 10_000,
        leaseTtlMs: 60_000, // far future — nothing expires during the test
        onCoordinatorOutage: "fail-closed",
        eagerHandoff: true,
        minHeartbeatMs: 100,
        clock: systemClock,
        scheduler: noFire,
      });
    const a = mk("A");
    const b = mk("B");
    const heldA: Lease[] = [];
    const sum = () => a.inflight + b.inflight;
    const lG = () => Math.max(a.stats().lGlobal, b.stats().lGlobal, 1);

    await a.heartbeat(); // A solo ⇒ share 4
    for (;;) {
      const l = a.acquire();
      if (!l.ok) break;
      heldA.push(l);
    }
    expect(a.inflight).toBe(4);
    expect(sum()).toBeLessThanOrEqual(lG());

    await b.heartbeat(); // B joins ⇒ share 0 (A's un-acked 4 reserved)
    expect(b.stats().share).toBe(0);
    expect(sum()).toBeLessThanOrEqual(lG());

    await a.heartbeat(); // A re-beats ⇒ committed 2, debt (inflight 4 > 2)
    expect(a.stats().share).toBe(2);
    await b.heartbeat(); // B still held at 0 (A has not acked + drained)
    expect(b.stats().share).toBe(0);
    expect(sum(), "no overshoot while the incumbent still holds its in-flight").toBeLessThanOrEqual(
      lG(),
    );

    while (heldA.length > 2) heldA.pop()?.release(); // A drains to 2
    await a.heartbeat(); // A acks the lower gen + reports inflight 2 ⇒ reserve resets
    await b.heartbeat(); // B now earns the freed budget
    expect(b.stats().share, "joiner ramps once the incumbent acks AND drains").toBeGreaterThan(0);
    expect(sum(), "still ≤ L_global throughout the ramp").toBeLessThanOrEqual(lG());

    await a.close();
    await b.close();
  });
});
