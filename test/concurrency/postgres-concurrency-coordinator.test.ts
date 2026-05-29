/**
 * TK-1402 — dual-path conformance: `TestConcurrencyCoordinator` ≡
 * `PostgresConcurrencyCoordinator`.
 *
 * Both coordinators run the SAME shared compute (`applyHeartbeat` / `heartbeat-core`), so they
 * are structurally identical; this test proves the Postgres PERSISTENCE layer round-trips
 * faithfully — the advisory-lock transaction, the row load → `applyHeartbeat` → delete-evicted
 * + upsert-self cycle, and the bigint→string→Number round-trip — across aggregate × allocation ×
 * acknowledged-handoff. `expiresAt` is pinned far in the future so eviction never fires and the
 * Test `ManualClock` vs Postgres `now` skew is irrelevant (Postgres uses `useServerTime:false`).
 *
 * Gated on `THROTTLEKIT_TEST_POSTGRES` (e.g.
 * postgres://throttlekit:throttlekit@localhost:5433/throttlekit). Uses a dedicated table
 * `tk_conc_state_conf` (dropped on setup + teardown) — no clash with the federation/store
 * Postgres suites. Unique per-case keys keep cases isolated within the shared table.
 */

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConcurrencyGrant } from "../../src/concurrency/coordinator";
import { PostgresConcurrencyCoordinator } from "../../src/concurrency/postgres-concurrency-coordinator";
import { TestConcurrencyCoordinator } from "../../src/concurrency/test-concurrency-coordinator";
import { ManualClock } from "../../src/core/clock";

const url = process.env.THROTTLEKIT_TEST_POSTGRES;
const d = url ? describe : describe.skip;
const TABLE = "tk_conc_state_conf";

interface Beat {
  nodeId: string;
  lLocal: number;
  inflight: number;
  seq?: number;
  appliedGen?: number;
}

function grantOf(
  g: ConcurrencyGrant,
  handoff: boolean,
): { share: number; lGlobal: number; nodes: number; gen?: number } {
  return handoff
    ? { share: g.share, lGlobal: g.lGlobal, nodes: g.nodes, gen: g.gen ?? 0 }
    : { share: g.share, lGlobal: g.lGlobal, nodes: g.nodes };
}

d("PostgresConcurrencyCoordinator dual-path conformance (TK-1402)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await pool.end();
  });

  for (const aggregate of ["median", "min"] as const) {
    async function expectConformant(
      label: string,
      beats: Beat[],
      handoff = false,
      allocation: "equal-split" | "demand-proportional" = "equal-split",
    ): Promise<void> {
      const key = `${aggregate}-${allocation}-${label}`;
      const expiresAt = Date.now() + 60_000; // far future for both paths ⇒ no eviction
      const testCoord = new TestConcurrencyCoordinator({
        aggregate,
        clock: new ManualClock(0),
        acknowledgedHandoff: handoff,
        allocation,
      });
      const pgCoord = new PostgresConcurrencyCoordinator({
        pool,
        aggregate,
        allocation,
        acknowledgedHandoff: handoff,
        tableName: TABLE,
        useServerTime: false,
        gcIntervalMs: 0,
      });
      for (let i = 0; i < beats.length; i++) {
        const beat = beats[i]!;
        const report = {
          key,
          nodeId: beat.nodeId,
          lLocal: beat.lLocal,
          inflight: beat.inflight,
          expiresAt,
          ...(beat.seq !== undefined ? { seq: beat.seq } : {}),
          ...(beat.appliedGen !== undefined ? { appliedGen: beat.appliedGen } : {}),
        };
        const t = await testCoord.heartbeat(report);
        const p = await pgCoord.heartbeat(report);
        expect(grantOf(p, handoff), `${label} step ${i} (node ${beat.nodeId})`).toEqual(
          grantOf(t, handoff),
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

      it("two nodes, odd budget → remainder to the lexicographically-first node", async () => {
        await expectConformant("two-odd", [
          { nodeId: "n1", lLocal: 9, inflight: 0 },
          { nodeId: "n2", lLocal: 9, inflight: 0 },
          { nodeId: "n1", lLocal: 9, inflight: 2 },
          { nodeId: "n2", lLocal: 9, inflight: 2 },
        ]);
      });

      it("a peer's in-flight debt dominates the cap (D-DAC-18)", async () => {
        await expectConformant("debt", [
          { nodeId: "n1", lLocal: 10, inflight: 0 },
          { nodeId: "n2", lLocal: 10, inflight: 0 },
          { nodeId: "n1", lLocal: 10, inflight: 0 },
          { nodeId: "n1", lLocal: 10, inflight: 9 },
          { nodeId: "n2", lLocal: 10, inflight: 0 },
        ]);
      });

      it("demand-proportional: saturated node ramps as an idle peer drains", async () => {
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
          "demand-proportional",
        );
      });

      it("demand-proportional: multiple hungry nodes split the released budget", async () => {
        await expectConformant(
          "dp-multi",
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
          "demand-proportional",
        );
      });

      it("acknowledged handoff: un-acked high grant reserved until the peer acks", async () => {
        await expectConformant(
          "handoff",
          [
            { nodeId: "n1", lLocal: 6, inflight: 0, seq: 1, appliedGen: 0 },
            { nodeId: "n2", lLocal: 6, inflight: 0, seq: 1, appliedGen: 0 },
            { nodeId: "n1", lLocal: 6, inflight: 0, seq: 2, appliedGen: 1 },
            { nodeId: "n2", lLocal: 6, inflight: 0, seq: 2, appliedGen: 0 },
            { nodeId: "n1", lLocal: 6, inflight: 0, seq: 3, appliedGen: 2 },
            { nodeId: "n2", lLocal: 6, inflight: 0, seq: 3, appliedGen: 0 },
          ],
          true,
        );
      });

      it("demand-proportional × acknowledged handoff (the cross-product)", async () => {
        await expectConformant(
          "dp-handoff",
          [
            { nodeId: "n1", lLocal: 12, inflight: 0, seq: 1, appliedGen: 0 },
            { nodeId: "n2", lLocal: 12, inflight: 0, seq: 1, appliedGen: 0 },
            { nodeId: "n1", lLocal: 12, inflight: 6, seq: 2, appliedGen: 1 },
            { nodeId: "n2", lLocal: 12, inflight: 0, seq: 2, appliedGen: 0 },
            { nodeId: "n1", lLocal: 12, inflight: 6, seq: 3, appliedGen: 2 },
          ],
          true,
          "demand-proportional",
        );
      });

      it("eviction round-trips: an expired node is reclaimed (Postgres-only path)", async () => {
        // This case exercises eviction (NOT a Test-vs-Postgres equality — the Test path uses a
        // frozen ManualClock so it never evicts). We drive the Postgres coordinator with a
        // node whose lease is already in the past and assert it does not count toward the split.
        const key = `${aggregate}-evict`;
        const pg = new PostgresConcurrencyCoordinator({
          pool,
          aggregate,
          tableName: TABLE,
          useServerTime: false,
          gcIntervalMs: 0,
        });
        // n1 joins with a lease already expired; n2 joins live. n1 must be evicted, so n2 (sole
        // live node) gets the whole budget.
        await pg.heartbeat({
          key,
          nodeId: "n1",
          lLocal: 8,
          inflight: 0,
          expiresAt: Date.now() - 1,
        });
        const g = await pg.heartbeat({
          key,
          nodeId: "n2",
          lLocal: 8,
          inflight: 0,
          expiresAt: Date.now() + 60_000,
        });
        expect(g.nodes).toBe(1); // n1 evicted
        expect(g.share).toBe(8); // n2 sole survivor → whole budget
      });
    });
  }
});
