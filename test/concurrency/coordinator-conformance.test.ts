/**
 * TK-1316 — dual-path conformance: `TestConcurrencyCoordinator` ≡
 * `RedisConcurrencyCoordinator`.
 *
 * The federation dual-path pattern (TK-903/908) relabeled for distributed
 * adaptive concurrency (DESIGN §11.4): feed an IDENTICAL `ConcurrencyReport`
 * sequence through BOTH coordinator backends — the in-memory reference
 * `TestConcurrencyCoordinator` and the Lua-backed `RedisConcurrencyCoordinator`
 * — and assert they return IDENTICAL `{share, lGlobal, nodes}` for every node
 * at every step. The reference algorithm (§10.1) and the Lua script (§10.2)
 * are two transcriptions of the same heartbeat-aggregate-split (§6 equal-split
 * + §7 aggregation); the only way they could diverge is an arithmetic bug in
 * one transcription.
 *
 * Eviction `now`-skew is eliminated by construction: the Lua path compares
 * `expiresAt` against the server's `Date.now()` while the Test path compares
 * against its injected clock, so we keep every report's `expiresAt` far in the
 * future for both clocks. No node is ever evicted in either path, so the two
 * live-sets — and therefore the aggregate and the split — match step for step.
 * (Per-node TTL eviction is covered deterministically by the unit suite
 * `test/concurrency/distributed.test.ts`, which drives a single injected clock.)
 *
 * Gated on `THROTTLEKIT_TEST_REDIS` (set to e.g. `redis://localhost:6380`);
 * uses Redis DB 13 — non-colliding with DB 7-12 used by the other gated
 * suites. The rest of `npm run check` runs even without a Redis available.
 */

import { createClient } from "redis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ConcurrencyGrant, ConcurrencyReport } from "../../src/concurrency/coordinator";
import { RedisConcurrencyCoordinator } from "../../src/concurrency/redis-concurrency-coordinator";
import { TestConcurrencyCoordinator } from "../../src/concurrency/test-concurrency-coordinator";
import { ManualClock } from "../../src/core/clock";
import { fromNodeRedis } from "../../src/redis/clients";

const url = process.env.THROTTLEKIT_TEST_REDIS;
const d = url ? describe : describe.skip;

/**
 * A heartbeat in an identical report sequence: which node reports, what its
 * locally-inferred `lLocal` is, and its current `inflight`. `key` /
 * `expiresAt` are filled in by the runner (the latter anchored far in the
 * future of both clocks, see file header).
 */
interface Beat {
  nodeId: string;
  lLocal: number;
  inflight: number;
  /** Acknowledged handoff (D-DAC-19): heartbeat sequence (freshness gate). */
  seq?: number;
  /** Acknowledged handoff: the grant generation the guard currently enforces. */
  appliedGen?: number;
}

/** Flatten a grant to the conformance-relevant fields (+ `gen` under handoff). */
function grantOf(
  g: ConcurrencyGrant,
  handoff: boolean,
): { share: number; lGlobal: number; nodes: number; gen?: number } {
  return handoff
    ? { share: g.share, lGlobal: g.lGlobal, nodes: g.nodes, gen: g.gen ?? 0 }
    : { share: g.share, lGlobal: g.lGlobal, nodes: g.nodes };
}

d("coordinator dual-path conformance (TK-1316)", () => {
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    client = createClient({ url: url as string, database: 13 });
    await client.connect();
    await client.flushDb();
  });

  afterAll(async () => {
    if (client?.isOpen) {
      await client.flushDb();
      await client.quit();
    }
  });

  afterEach(async () => {
    await client.flushDb();
  });

  for (const aggregate of ["median", "min"] as const) {
    /**
     * Drive one identical report sequence through both coordinators and assert
     * the `{share, lGlobal, nodes}` grants match step for step. A unique `key`
     * per case keeps Redis state isolated across cases.
     */
    async function expectConformant(
      label: string,
      beats: Beat[],
      handoff = false,
      allocation: "equal-split" | "demand-proportional" = "equal-split",
    ): Promise<void> {
      const key = `${aggregate}-${allocation}-${label}`;
      // expiresAt far in the future for BOTH the Test clock and the server's
      // wall clock, so no eviction fires on either path.
      const expiresAt = Date.now() + 60_000;
      // Test clock anchored at 0 ⇒ now=0 ≤ expiresAt; Lua uses Date.now() ≤ expiresAt.
      const testCoord = new TestConcurrencyCoordinator({
        aggregate,
        clock: new ManualClock(0),
        acknowledgedHandoff: handoff,
        allocation,
      });
      const redisCoord = new RedisConcurrencyCoordinator({
        client: fromNodeRedis(client),
        aggregate,
        prefix: key,
        acknowledgedHandoff: handoff,
        allocation,
      });

      for (let i = 0; i < beats.length; i++) {
        const beat = beats[i]!;
        const report: ConcurrencyReport = {
          key,
          nodeId: beat.nodeId,
          lLocal: beat.lLocal,
          inflight: beat.inflight,
          expiresAt,
          ...(beat.seq !== undefined ? { seq: beat.seq } : {}),
          ...(beat.appliedGen !== undefined ? { appliedGen: beat.appliedGen } : {}),
        };
        const testGrant = await testCoord.heartbeat(report);
        const redisGrant = await redisCoord.heartbeat(report);
        expect(grantOf(redisGrant, handoff), `${label} step ${i} (node ${beat.nodeId})`).toEqual(
          grantOf(testGrant, handoff),
        );
      }
    }

    describe(`aggregate="${aggregate}"`, () => {
      it("single node sees the whole budget", async () => {
        await expectConformant("single", [
          { nodeId: "n1", lLocal: 10, inflight: 3 },
          { nodeId: "n1", lLocal: 7, inflight: 5 },
          { nodeId: "n1", lLocal: 12, inflight: 0 },
        ]);
      });

      it("two nodes, even split (L divisible by N)", async () => {
        await expectConformant("two-even", [
          { nodeId: "n1", lLocal: 8, inflight: 1 },
          { nodeId: "n2", lLocal: 8, inflight: 2 },
          { nodeId: "n1", lLocal: 8, inflight: 4 },
          { nodeId: "n2", lLocal: 8, inflight: 4 },
        ]);
      });

      it("two nodes, odd budget → remainder goes to the lexicographically-first node", async () => {
        // median/min of {9,9} = 9; base=4, rem=1 → n1 gets 5, n2 gets 4.
        await expectConformant("two-odd", [
          { nodeId: "n1", lLocal: 9, inflight: 0 },
          { nodeId: "n2", lLocal: 9, inflight: 0 },
          { nodeId: "n1", lLocal: 9, inflight: 2 },
          { nodeId: "n2", lLocal: 9, inflight: 2 },
        ]);
      });

      it("a peer's in-flight debt dominates the cap (D-DAC-18 max(share,inflight))", async () => {
        // Drive n1 into DEBT (inflight > its granted share) so the cap reserves
        // n1's INFLIGHT, not its smaller share — the only path where the
        // occupancy term changes the grant. Both lLocal=10 ⇒ lGlobal=10 for
        // median AND min, so the case is aggregate-agnostic.
        //   1. n1 solo               → share 10
        //   2. n2 joins              → share 0  (n1 still holds 10)
        //   3. n1 re-splits          → share 5
        //   4. n1 reports inflight 9 → share 5 (stored inflight=9 > share=5: debt)
        //   5. n2 heartbeats         → reserve max(n1.share=5, n1.inflight=9)=9 ⇒
        //                              share = min(target 5, 10−9) = 1.
        // Share-only (the pre-D-DAC-18 cap) would have granted n2 = 5 here; both
        // coordinators must now agree on 1, which only the inflight term yields —
        // so this case fails if the Lua `fieldInflight` extraction is wrong.
        await expectConformant("debt-dominates", [
          { nodeId: "n1", lLocal: 10, inflight: 0 },
          { nodeId: "n2", lLocal: 10, inflight: 0 },
          { nodeId: "n1", lLocal: 10, inflight: 0 },
          { nodeId: "n1", lLocal: 10, inflight: 9 },
          { nodeId: "n2", lLocal: 10, inflight: 0 },
        ]);
      });

      it("three nodes with distinct lLocal — exercises median vs min divergence", async () => {
        // live lLocal {6,10,14}: median (lower median) = 10; min = 6.
        // The two coordinators must AGREE with each other for the chosen
        // `aggregate`, regardless of which value that is.
        await expectConformant("three-distinct", [
          { nodeId: "a", lLocal: 10, inflight: 0 },
          { nodeId: "b", lLocal: 6, inflight: 0 },
          { nodeId: "c", lLocal: 14, inflight: 0 },
          { nodeId: "a", lLocal: 10, inflight: 1 },
          { nodeId: "b", lLocal: 6, inflight: 1 },
          { nodeId: "c", lLocal: 14, inflight: 1 },
        ]);
      });

      it("four nodes, remainder > 1 spread across the first `rem` ranks", async () => {
        // 4 nodes all lLocal=7 ⇒ lGlobal=7; base=1, rem=3 → ranks 0..2 get 2, rank 3 gets 1.
        await expectConformant("four-rem", [
          { nodeId: "n1", lLocal: 7, inflight: 0 },
          { nodeId: "n2", lLocal: 7, inflight: 0 },
          { nodeId: "n3", lLocal: 7, inflight: 0 },
          { nodeId: "n4", lLocal: 7, inflight: 0 },
          { nodeId: "n1", lLocal: 7, inflight: 1 },
          { nodeId: "n4", lLocal: 7, inflight: 1 },
        ]);
      });

      it("nodeId sort is lexicographic, not insertion order", async () => {
        // Report out of lexicographic order; the rank/remainder assignment must
        // still follow sorted nodeId on both paths.
        await expectConformant("lex-order", [
          { nodeId: "z", lLocal: 5, inflight: 0 },
          { nodeId: "m", lLocal: 5, inflight: 0 },
          { nodeId: "a", lLocal: 5, inflight: 0 },
          { nodeId: "z", lLocal: 5, inflight: 0 },
        ]);
      });

      it("a node revising its lLocal downward re-aggregates identically", async () => {
        await expectConformant("revise-down", [
          { nodeId: "n1", lLocal: 20, inflight: 0 },
          { nodeId: "n2", lLocal: 18, inflight: 0 },
          { nodeId: "n1", lLocal: 4, inflight: 0 }, // backend degraded for n1
          { nodeId: "n2", lLocal: 18, inflight: 0 },
        ]);
      });

      it("longer mixed sequence over a 3-node fleet", async () => {
        const beats: Beat[] = [];
        const ids = ["alpha", "bravo", "charlie"];
        // Deterministic pseudo-sequence: rotate node, vary lLocal/inflight.
        for (let i = 0; i < 30; i++) {
          beats.push({
            nodeId: ids[i % ids.length]!,
            lLocal: 1 + ((i * 7) % 17),
            inflight: (i * 3) % 5,
          });
        }
        await expectConformant("mixed-30", beats);
      });

      describe("acknowledged handoff (D-DAC-19)", () => {
        it("un-acked high grant is reserved until the peer acks, then released (the hard-bound divergence)", async () => {
          // L=6, two nodes. The DEFAULT cap would grant n2=3 at step 4 (n1's committed
          // share is 3) — the 1.5× residual. Acknowledged handoff reserves n1's UN-ACKED
          // high grant (6) until n1 echoes appliedGen ≥ the lowering's gen, so n2 is held
          // at 0 until n1 confirms, then granted 3. Test ≡ Redis on {share,lGlobal,nodes,
          // gen} at every step proves the Lua gen/unackedHigh logic matches the reference.
          await expectConformant(
            "handoff-unacked-hold",
            [
              { nodeId: "n1", lLocal: 6, inflight: 0, seq: 1, appliedGen: 0 }, // solo → share 6, gen 1
              { nodeId: "n2", lLocal: 6, inflight: 0, seq: 1, appliedGen: 0 }, // joins → 0 (n1 un-acked high 6)
              { nodeId: "n1", lLocal: 6, inflight: 0, seq: 2, appliedGen: 1 }, // applied 6; lowered → 3, gen 2, floor stays 6
              { nodeId: "n2", lLocal: 6, inflight: 0, seq: 2, appliedGen: 0 }, // STILL 0 — n1 hasn't acked the drop
              { nodeId: "n1", lLocal: 6, inflight: 0, seq: 3, appliedGen: 2 }, // acks gen 2 → floor resets to 3
              { nodeId: "n2", lLocal: 6, inflight: 0, seq: 3, appliedGen: 0 }, // NOW granted 3
            ],
            true,
          );
        });

        it("non-revocable in-flight unions with the un-acked grant (max(unackedHigh, inflight))", async () => {
          // After n1's reserve floor resets to its current share (4), a reported in-flight
          // DEBT (6 > 4) dominates the cap — the occupancy term of the union — so n2 is
          // granted min(target 4, 8−6) = 2. Exercises the inflight term in handoff mode.
          await expectConformant(
            "handoff-inflight-union",
            [
              { nodeId: "n1", lLocal: 8, inflight: 0, seq: 1, appliedGen: 0 }, // solo → 8, gen 1
              { nodeId: "n2", lLocal: 8, inflight: 0, seq: 1, appliedGen: 0 }, // joins → 0
              { nodeId: "n1", lLocal: 8, inflight: 0, seq: 2, appliedGen: 1 }, // lowered → 4, gen 2, floor 8
              { nodeId: "n1", lLocal: 8, inflight: 6, seq: 3, appliedGen: 2 }, // acks → floor 4, but holds 6 in flight
              { nodeId: "n2", lLocal: 8, inflight: 0, seq: 2, appliedGen: 0 }, // reserve max(4,6)=6 → share 2
            ],
            true,
          );
        });

        it("generation bumps only on a value change (a stable value lets the peer catch up)", async () => {
          // Repeated identical grants keep gen stable (no per-heartbeat ratchet), so the
          // peer's appliedGen can reach committedGen. gen advances only on a value change.
          await expectConformant(
            "handoff-gen-stable",
            [
              { nodeId: "n1", lLocal: 5, inflight: 0, seq: 1, appliedGen: 0 }, // → 5, gen 1
              { nodeId: "n1", lLocal: 5, inflight: 0, seq: 2, appliedGen: 1 }, // 5 again → gen 1 (unchanged)
              { nodeId: "n1", lLocal: 5, inflight: 0, seq: 3, appliedGen: 1 }, // 5 again → gen 1
            ],
            true,
          );
        });

        it("a reordered/stale heartbeat (seq ≤ maxSeq) does not regress committed state", async () => {
          // n1 advances to seq 3; a late-arriving seq-2 heartbeat must be ignored for
          // state advance (return the current committed grant), so both paths agree.
          await expectConformant(
            "handoff-stale-seq",
            [
              { nodeId: "n1", lLocal: 6, inflight: 0, seq: 1, appliedGen: 0 },
              { nodeId: "n1", lLocal: 6, inflight: 0, seq: 3, appliedGen: 1 },
              { nodeId: "n1", lLocal: 6, inflight: 0, seq: 2, appliedGen: 1 }, // stale: ignored
            ],
            true,
          );
        });
      });

      describe("demand-proportional allocation (TK-1403)", () => {
        const DP = "demand-proportional" as const;

        it("skew: a saturated node ramps as an idle peer drains to its probe slot", async () => {
          // n1 fills the budget, then n2 joins idle. Under DP, n2 drains toward a 1-slot
          // probe and n1 reclaims the rest. Only Test≡Redis is asserted here (the
          // utilization win is the gate's job); divergence ⇒ a Lua target transcription bug.
          await expectConformant(
            "dp-skew",
            [
              { nodeId: "n1", lLocal: 12, inflight: 12 },
              { nodeId: "n2", lLocal: 12, inflight: 0 },
              { nodeId: "n1", lLocal: 12, inflight: 12 },
              { nodeId: "n2", lLocal: 12, inflight: 0 },
              { nodeId: "n1", lLocal: 12, inflight: 11 },
            ],
            false,
            DP,
          );
        });

        it("multiple hungry nodes split the released budget (rank tiebreak)", async () => {
          await expectConformant(
            "dp-multi-hungry",
            [
              { nodeId: "a", lLocal: 10, inflight: 0 },
              { nodeId: "b", lLocal: 10, inflight: 0 },
              { nodeId: "c", lLocal: 10, inflight: 0 },
              { nodeId: "a", lLocal: 10, inflight: 4 },
              { nodeId: "b", lLocal: 10, inflight: 4 },
              { nodeId: "c", lLocal: 10, inflight: 0 },
              { nodeId: "a", lLocal: 10, inflight: 5 },
            ],
            false,
            DP,
          );
        });

        it("L<N edge: probe floors exceed the budget (still conformant)", async () => {
          await expectConformant(
            "dp-l-lt-n",
            [
              { nodeId: "n1", lLocal: 3, inflight: 0 },
              { nodeId: "n2", lLocal: 3, inflight: 0 },
              { nodeId: "n3", lLocal: 3, inflight: 0 },
              { nodeId: "n4", lLocal: 3, inflight: 0 },
              { nodeId: "n1", lLocal: 3, inflight: 3 },
              { nodeId: "n2", lLocal: 3, inflight: 0 },
            ],
            false,
            DP,
          );
        });

        it("longer mixed demand-proportional sequence over a 3-node fleet", async () => {
          const beats: Beat[] = [];
          const ids = ["alpha", "bravo", "charlie"];
          for (let i = 0; i < 30; i++) {
            beats.push({
              nodeId: ids[i % ids.length]!,
              lLocal: 8 + ((i * 5) % 11),
              inflight: (i * 4) % 9,
            });
          }
          await expectConformant("dp-mixed-30", beats, false, DP);
        });

        it("composes with acknowledged handoff (demand-proportional target ⟂ handoff cap)", async () => {
          // The target (allocation) and the cap's reserve term (handoff) are orthogonal; this
          // locks the cross-product both flags on. n1 fills, lowers, holds in-flight debt while
          // n2 ramps — Test ≡ Redis on {share,lGlobal,nodes,gen} proves the Lua composes both.
          await expectConformant(
            "dp-handoff",
            [
              { nodeId: "n1", lLocal: 12, inflight: 0, seq: 1, appliedGen: 0 },
              { nodeId: "n2", lLocal: 12, inflight: 0, seq: 1, appliedGen: 0 },
              { nodeId: "n1", lLocal: 12, inflight: 6, seq: 2, appliedGen: 1 },
              { nodeId: "n2", lLocal: 12, inflight: 0, seq: 2, appliedGen: 0 },
              { nodeId: "n1", lLocal: 12, inflight: 6, seq: 3, appliedGen: 2 },
              { nodeId: "n2", lLocal: 12, inflight: 0, seq: 3, appliedGen: 0 },
            ],
            true,
            DP,
          );
        });
      });
    });
  }
});
