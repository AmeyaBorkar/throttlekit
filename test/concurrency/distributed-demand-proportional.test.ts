/**
 * TK-1403 — demand-proportional allocation: properties + behavior.
 *
 * The TK-1403a gate proved the utilization win; the exhaustive BFS twin
 * (distributed-leasing-model.test.ts) proves GlobalCap/InflightCap hold under the
 * demand-proportional TARGET; the dual-path conformance (coordinator-conformance.test.ts)
 * proves Test ≡ Redis. This suite pins, against the real `TestConcurrencyCoordinator`:
 *
 *   1. DEFAULT-UNCHANGED — `allocation` defaults to `"equal-split"`; grants are byte-for-
 *      byte what they were before TK-1403 (behavior-preserving; this is the safety contract
 *      for existing deployments).
 *   2. GlobalCap under RANDOM staggered heartbeat sequences — Σ committed shares ≤ L_global
 *      after every heartbeat (the coordinator's hard invariant), demand-proportional.
 *   3. The WIN — under skew the hungry node is granted strictly MORE than equal-split would.
 *   4. RECLAIM + CONVERGE — when load moves, the new hot node ramps and the idled node drains
 *      to its probe slot; the allocation settles (no thrash).
 *   5. STARVATION-FREEDOM — an idle node keeps a ≥1 probe slot whenever L_global ≥ N, so it
 *      can always admit its first request and reveal demand.
 *
 * No Redis: pure in-memory `TestConcurrencyCoordinator` under a `ManualClock`, so it runs in
 * every `npm run check`.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ConcurrencyReport } from "../../src/concurrency/coordinator";
import { TestConcurrencyCoordinator } from "../../src/concurrency/test-concurrency-coordinator";
import { ManualClock } from "../../src/core/clock";

const KEY = "k";
const FAR = 10_000_000; // expiresAt far in the future of the ManualClock(0) → no eviction

type Allocation = "equal-split" | "demand-proportional";

function makeCoord(allocation?: Allocation): TestConcurrencyCoordinator {
  return new TestConcurrencyCoordinator({
    clock: new ManualClock(0),
    ...(allocation ? { allocation } : {}),
  });
}

function beat(nodeId: string, lLocal: number, inflight: number): ConcurrencyReport {
  return { key: KEY, nodeId, lLocal, inflight, expiresAt: FAR };
}

/** Round-robin heartbeats to steady state (constant lLocal=L). Hot nodes report inflight =
 *  their current share (stay saturated/hungry); the rest are idle. Returns final shares. */
async function steadyShares(
  ids: string[],
  L: number,
  hotIds: string[],
  allocation: Allocation = "demand-proportional",
): Promise<Record<string, number>> {
  const coord = makeCoord(allocation);
  const share: Record<string, number> = {};
  for (const id of ids) share[id] = 0;
  for (let round = 0; round < 40; round++) {
    for (const id of ids) {
      const inflight = hotIds.includes(id) ? Math.min(share[id]!, L) : 0;
      const g = await coord.heartbeat(beat(id, L, inflight));
      share[id] = g.share;
    }
  }
  return share;
}

describe("demand-proportional allocation — properties + behavior (TK-1403)", () => {
  it("DEFAULT is equal-split: grants are byte-identical to the pre-TK-1403 behavior", async () => {
    // A coordinator constructed with NO allocation option must grant exactly what an
    // explicit equal-split coordinator does, for an identical report sequence — the
    // behavior-preserving contract for existing deployments.
    const seq: ConcurrencyReport[] = [
      beat("n1", 12, 3),
      beat("n2", 12, 7),
      beat("n1", 12, 9),
      beat("n3", 12, 0),
      beat("n2", 12, 4),
      beat("n1", 12, 11),
    ];
    const dflt = makeCoord();
    const explicit = makeCoord("equal-split");
    for (const r of seq) {
      const a = await dflt.heartbeat(r);
      const b = await explicit.heartbeat(r);
      expect(a).toEqual(b);
    }
    // Golden: two nodes, lLocal 8 ⇒ lGlobal 8. A JOINING node is capped at 0 until the
    // incumbent re-splits down (the §6 cap / cold start), then both converge to the even
    // split 4/4 — unchanged from the shipped equal-split behavior.
    const c = makeCoord();
    expect(await c.heartbeat(beat("a", 8, 0))).toEqual({ share: 8, lGlobal: 8, nodes: 1 });
    expect(await c.heartbeat(beat("b", 8, 0))).toEqual({ share: 0, lGlobal: 8, nodes: 2 });
    await c.heartbeat(beat("a", 8, 0)); // a re-splits down to 4, freeing budget
    expect(await c.heartbeat(beat("b", 8, 0))).toEqual({ share: 4, lGlobal: 8, nodes: 2 });
  });

  it("GlobalCap: Σ committed shares ≤ L_global after EVERY heartbeat (random staggered)", async () => {
    // The coordinator's hard invariant must hold for demand-proportional under any
    // interleaving — exactly as it does for equal-split (the cap owns it). fast-check
    // generates random staggered heartbeats over a small fleet; we assert after each.
    // GlobalCap (§9.2) is the constant-L_global theorem — all nodes agree on one lLocal so
    // lGlobal is stable across the epoch (a varying lLocal is the cross-epoch shrink-drain
    // regime of §9.3, where committed shares transiently exceed a freshly-lowered lGlobal
    // until each node re-heartbeats; equal-split has the identical transient — NOT a bug).
    const nodeArb = fc.constantFrom("n1", "n2", "n3", "n4");
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }), // the constant L_global for this epoch
        fc.array(fc.record({ nodeId: nodeArb, inflight: fc.integer({ min: 0, max: 20 }) }), {
          minLength: 1,
          maxLength: 40,
        }),
        async (L, beats) => {
          const coord = makeCoord("demand-proportional");
          for (const b of beats) {
            await coord.heartbeat(beat(b.nodeId, L, Math.min(b.inflight, L)));
            const { lGlobal, shares } = coord.peek(KEY);
            expect(lGlobal).toBe(L); // constant — the regime GlobalCap covers
            const sumShares = Object.values(shares).reduce((s, v) => s + v, 0);
            expect(sumShares).toBeLessThanOrEqual(lGlobal); // GlobalCap (D-DAC-17)
            for (const v of Object.values(shares)) {
              expect(v).toBeGreaterThanOrEqual(0);
              expect(v).toBeLessThanOrEqual(lGlobal);
            }
          }
          return true;
        },
      ),
      { numRuns: 300, seed: 20260530 },
    );
  });

  it("THE WIN: under skew a hungry node is granted MORE than equal-split would give it", async () => {
    // 4 nodes, L=12. n0 is saturated (wants everything), n1..n3 idle. Drive both
    // allocations to steady state and compare n0's share. equal-split caps n0 at ≈3;
    // demand-proportional lets it reclaim the idle peers' budget (≈9).
    async function steadyHotShare(allocation: Allocation): Promise<number> {
      const coord = makeCoord(allocation);
      let hot = 0;
      // round-robin heartbeats; idle nodes report inflight 0, hot node reports its share.
      for (let round = 0; round < 30; round++) {
        for (const id of ["n0", "n1", "n2", "n3"]) {
          const inflight = id === "n0" ? hot : 0;
          const g = await coord.heartbeat(beat(id, 12, Math.min(inflight, 12)));
          if (id === "n0") hot = g.share; // hot node fills to its granted share
        }
      }
      return hot;
    }
    const eq = await steadyHotShare("equal-split");
    const dp = await steadyHotShare("demand-proportional");
    expect(eq).toBe(3); // ⌊12/4⌋ — the stranded-capacity baseline
    expect(dp).toBeGreaterThan(eq); // demand-proportional reclaims idle budget
    expect(dp).toBe(9); // 12 − 3 idle probe slots
  });

  it("RECLAIM + CONVERGE: when the hot node moves, the new one ramps and the old drains", async () => {
    const coord = makeCoord("demand-proportional");
    const ids = ["n0", "n1", "n2", "n3"];
    const inflight: Record<string, number> = { n0: 0, n1: 0, n2: 0, n3: 0 };
    const share: Record<string, number> = { n0: 0, n1: 0, n2: 0, n3: 0 };
    // Phase 1: n0 hot. Phase 2: n0 idle, n3 hot.
    for (let round = 0; round < 60; round++) {
      const hotId = round < 30 ? "n0" : "n3";
      for (const id of ids) {
        const want = id === hotId ? 12 : 0;
        const g = await coord.heartbeat(beat(id, 12, Math.min(want, share[id]!, 12)));
        share[id] = g.share;
        inflight[id] = Math.min(want, g.share, 12);
      }
    }
    // After the shift, n3 holds the lion's share; n0 has drained to its probe slot.
    expect(share.n3).toBe(9);
    expect(share.n0).toBe(1);
    // Σ shares still within budget (safety) and the hot node converged (no thrash).
    expect(Object.values(share).reduce((s, v) => s + v, 0)).toBeLessThanOrEqual(12);
  });

  // STARVATION-FREEDOM is scoped to L_global ≥ N — sweep the boundary (L=N, L=N+1), N>2,
  // and L≫N, with one hot node and the rest idle. Even fully starved of demand, every node
  // must retain a ≥1 probe slot so it can admit its first request and reveal demand.
  it.each([
    { n: 2, l: 10 }, // L ≫ N
    { n: 4, l: 5 }, // L = N + 1 (just past the boundary)
    { n: 4, l: 4 }, // L = N (the boundary itself)
    { n: 3, l: 6 }, // N > 2
  ])(
    "STARVATION-FREEDOM: L_global=$l ≥ N=$n ⇒ every node keeps a ≥1 probe slot",
    async ({ n, l }) => {
      const ids = Array.from({ length: n }, (_, i) => `n${i}`);
      const share = await steadyShares(ids, l, ["n0"]); // n0 hot, rest idle
      for (const id of ids) expect(share[id]).toBeGreaterThanOrEqual(1); // no node starved
      expect(share.n0).toBe(l - (n - 1)); // hot node reclaims all but one probe slot per idle peer
      expect(ids.reduce((s, id) => s + share[id]!, 0)).toBeLessThanOrEqual(l); // GlobalCap
    },
  );

  it("L_global < N: the ≥1 probe slot provably CANNOT be guaranteed (documents the scope)", async () => {
    // Fewer budget units than nodes ⇒ not everyone can hold a slot; the "L≥N" qualifier on
    // starvation-freedom is load-bearing, not decorative. Some node is granted 0 here — and
    // safety (Σ shares ≤ L) still holds. (Which node holds the scarce slots is the cap's call;
    // we assert only that the floor is NOT universally honored, plus GlobalCap.)
    const ids = ["n0", "n1", "n2", "n3"];
    const share = await steadyShares(ids, 2, ["n0"]); // L=2 < N=4
    expect(ids.filter((id) => share[id] === 0).length).toBeGreaterThan(0);
    expect(ids.reduce((s, id) => s + share[id]!, 0)).toBeLessThanOrEqual(2);
  });
});
