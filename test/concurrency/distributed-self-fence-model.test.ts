import { describe, expect, it } from "vitest";

/**
 * TK-1332 — the GATE for self-fencing (D-DAC-21): a timed model proving the
 * lease-expiry / outage in-flight overshoot (the residual 0.10.x documented as
 * liveness-only, D-DAC-7 / D-DAC-14 — a crashed/partitioned node still serving its
 * already-accepted in-flight while the coordinator reassigns its budget) is NOT
 * unfixable. It is fixable under a clearly-stated, standard timing assumption — and
 * this model derives the EXACT margin and refutes a too-small one.
 *
 * THE PROBLEM (why 0.10.x leaves it). A node renews a lease each heartbeat,
 * reporting `expiresAt = lastBeat + leaseTtl` on ITS clock. The coordinator reclaims
 * (reassigns the node's budget to peers) when `expiresAt < coordinatorNow`. If the
 * node PARTITIONS, it can no longer heartbeat — but it keeps serving its in-flight
 * and, in 0.10.x, keeps ADMITTING against its last-known share. So once the
 * coordinator reclaims, peers ramp into the reassigned budget WHILE the partitioned
 * node still occupies it ⇒ Σ inflight > L_global for the whole partition (bounded by
 * the budget, but persistent — the unreachable node never learns).
 *
 * THE FIX (self-fencing, family-2 / Chubby jeopardy + grace, K8s leaseDuration >
 * renewDeadline). The node enforces its OWN lease expiry on its OWN clock: it stops
 * admitting (and, with an abort hook, cancels in-flight) at
 *   fenceDeadline = lastBeat + leaseTtl − fenceSafetyMargin
 * — strictly BEFORE the coordinator's reclaim, so peers never ramp into budget the
 * node still holds.
 *
 * THE ASSUMPTION (made explicit, the load-bearing one). Bounded clock skew between
 * the node and the coordinator. The dangerous direction is the coordinator's clock
 * AHEAD of the node's (it reclaims "early" in the node's frame). This model sweeps
 * that skew and proves:
 *   - WITH an abort hook: `fenceSafetyMargin ≥ maxSkew` ⇒ ZERO overshoot for every
 *     skew ≤ maxSkew. A margin BELOW maxSkew is REFUTED (overshoot reachable).
 *   - WITHOUT abort (non-cancellable in-flight drains over `maxReq`):
 *     `fenceSafetyMargin ≥ maxSkew + maxReq` ⇒ zero overshoot; `= maxSkew` is REFUTED
 *     (the un-aborted in-flight outlives the reclaim). So abort buys the small margin;
 *     non-cancellable work trades reclaim speed for it.
 *
 * The honest core (FLP + Two Generals + CAP): with NEITHER a timing assumption (this)
 * NOR backend fencing tokens (D-DAC-22, the clock-free alternative), bounding Σ inflight
 * across a partition is provably impossible. "No tradeoff" = SHIP BOTH so every
 * deployment has a satisfiable path. This gate establishes the timing path; the fence
 * tokens establish the clock-free path.
 *
 * Time reference: the node's clock IS real time (lastBeat at t=0); the coordinator's
 * clock = real time + `skew`. This mirrors the implemented rule exactly (the guard
 * fences on its own clock vs the coordinator's eviction on `expiresAt < coordNow`).
 */

interface Params {
  leaseTtl: number;
  /** Coordinator clock ahead of the node by this (the dangerous direction). */
  skew: number;
  /** Self-fence safety margin; the node fences at leaseTtl − margin (node clock). */
  margin: number;
  /** The node's reassigned budget (overshoot magnitude when it persists past reclaim). */
  B: number;
  /** Max in-flight request duration (drain time when in-flight is NOT abortable). */
  maxReq: number;
  /** Whether the node aborts in-flight at the fence (onFenced) vs lets it drain. */
  abort: boolean;
  /** When false, model 0.10.x behavior: NO self-fence (the node never stops itself). */
  selfFence: boolean;
}

/** The node's in-flight at real time `t` (it is saturated at B until it fences). */
function nodeInflight(t: number, p: Params): number {
  if (!p.selfFence) return p.B; // 0.10.x: a partitioned node keeps admitting forever
  const fenceAt = p.leaseTtl - p.margin;
  if (t < fenceAt) return p.B; // still admitting / holding
  // fenced: abort ⇒ gone now; else the in-flight present at the fence drains over maxReq.
  return p.abort ? 0 : t < fenceAt + p.maxReq ? p.B : 0;
}

/**
 * Peak overshoot over the partition: the coordinator reclaims at `leaseTtl − skew`
 * (its clock reaches expiresAt) and peers ramp into the reassigned budget B
 * immediately (worst case). Overshoot at `t` = the node's residual in-flight once the
 * budget has been reassigned. Returns max over a horizon spanning both deadlines.
 */
function peakOvershoot(p: Params): number {
  const reclaimAt = p.leaseTtl - p.skew;
  const horizon = p.leaseTtl + p.maxReq + p.margin + 5; // covers both deadlines + drain
  let peak = 0;
  for (let t = 0; t <= horizon; t++) {
    if (t >= reclaimAt) {
      const resid = nodeInflight(t, p);
      if (resid > peak) peak = resid;
    }
  }
  return peak;
}

const base = {
  leaseTtl: 100,
  B: 8,
  maxReq: 20,
} as const;

describe("self-fencing — timed model gate (TK-1332, D-DAC-21)", () => {
  const maxSkew = 10;
  const skews = Array.from({ length: maxSkew + 1 }, (_, i) => i); // 0..maxSkew

  it("BASELINE: 0.10.x (no self-fence) overshoots for the whole partition — the documented #4 residual", () => {
    // With no self-fence the partitioned node keeps admitting; once the coordinator
    // reclaims, the full budget B is double-counted. This is the residual we close.
    for (const skew of skews) {
      const p: Params = { ...base, skew, margin: 0, abort: false, selfFence: false };
      expect(peakOvershoot(p), `no self-fence overshoots (skew=${skew})`).toBe(base.B);
    }
  });

  it("FIX (abort): margin ≥ maxSkew ⇒ ZERO overshoot for every skew ≤ maxSkew", () => {
    for (const skew of skews) {
      const p: Params = { ...base, skew, margin: maxSkew, abort: true, selfFence: true };
      expect(peakOvershoot(p), `abort + margin=maxSkew is safe (skew=${skew})`).toBe(0);
    }
  });

  it("REFUTED: margin < maxSkew is UNSAFE — a skew in (margin, maxSkew] reopens the overshoot", () => {
    const margin = maxSkew - 1;
    // The exact boundary: any skew > margin makes the coordinator reclaim before the
    // node fences ⇒ overshoot. Pins the requirement margin ≥ maxSkew (not merely > 0).
    const reachable = skews.some((skew) => {
      const p: Params = { ...base, skew, margin, abort: true, selfFence: true };
      return peakOvershoot(p) > 0;
    });
    expect(reachable, "a too-small margin leaves a reachable overshoot").toBe(true);
    // And precisely: skew = margin+1 (= maxSkew) is the witness.
    expect(peakOvershoot({ ...base, skew: margin + 1, margin, abort: true, selfFence: true })).toBe(
      base.B,
    );
  });

  it("WITHOUT abort: non-cancellable in-flight needs margin ≥ maxSkew + maxReq (drain past reclaim)", () => {
    // margin = maxSkew is enough to stop ADMITTING before reclaim, but the in-flight
    // already accepted drains over maxReq and outlives the reclaim ⇒ still overshoots.
    const witnessSkew = maxSkew;
    expect(
      peakOvershoot({ ...base, skew: witnessSkew, margin: maxSkew, abort: false, selfFence: true }),
      "no abort + margin=maxSkew still overshoots (the in-flight drains past reclaim)",
    ).toBe(base.B);
    // The sufficient margin without abort: maxSkew + maxReq ⇒ zero for every skew.
    for (const skew of skews) {
      const p: Params = {
        ...base,
        skew,
        margin: maxSkew + base.maxReq,
        abort: false,
        selfFence: true,
      };
      expect(peakOvershoot(p), `no abort + margin=maxSkew+maxReq is safe (skew=${skew})`).toBe(0);
    }
  });

  it("margin exactly at the boundary (= maxSkew, abort) is the TIGHT minimum — maxSkew−1 fails, maxSkew holds", () => {
    // Tightness: the safe margin is exactly maxSkew (not maxSkew−1, not a slack overshoot).
    expect(
      peakOvershoot({ ...base, skew: maxSkew, margin: maxSkew - 1, abort: true, selfFence: true }),
      "margin one below maxSkew fails at skew=maxSkew",
    ).toBeGreaterThan(0);
    expect(
      peakOvershoot({ ...base, skew: maxSkew, margin: maxSkew, abort: true, selfFence: true }),
      "margin = maxSkew holds at skew=maxSkew",
    ).toBe(0);
  });
});
