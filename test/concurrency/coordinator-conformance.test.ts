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
}

/** Flatten a grant to the three conformance-relevant fields. */
function grantOf(g: ConcurrencyGrant): Pick<ConcurrencyGrant, "share" | "lGlobal" | "nodes"> {
  return { share: g.share, lGlobal: g.lGlobal, nodes: g.nodes };
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
    async function expectConformant(label: string, beats: Beat[]): Promise<void> {
      const key = `${aggregate}-${label}`;
      // expiresAt far in the future for BOTH the Test clock and the server's
      // wall clock, so no eviction fires on either path.
      const expiresAt = Date.now() + 60_000;
      // Test clock anchored at 0 ⇒ now=0 ≤ expiresAt; Lua uses Date.now() ≤ expiresAt.
      const testCoord = new TestConcurrencyCoordinator({
        aggregate,
        clock: new ManualClock(0),
      });
      const redisCoord = new RedisConcurrencyCoordinator({
        client: fromNodeRedis(client),
        aggregate,
        prefix: key,
      });

      for (let i = 0; i < beats.length; i++) {
        const beat = beats[i]!;
        const report: ConcurrencyReport = {
          key,
          nodeId: beat.nodeId,
          lLocal: beat.lLocal,
          inflight: beat.inflight,
          expiresAt,
        };
        const testGrant = await testCoord.heartbeat(report);
        const redisGrant = await redisCoord.heartbeat(report);
        expect(grantOf(redisGrant), `${label} step ${i} (node ${beat.nodeId})`).toEqual(
          grantOf(testGrant),
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
    });
  }
});
