import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { gcra } from "../../src/algorithms/gcra";
import { slidingWindow } from "../../src/algorithms/sliding-window";
import { tokenBucket } from "../../src/algorithms/token-bucket";
import { ManualClock } from "../../src/core/clock";
import { rateLimit } from "../../src/core/limiter";
import type { Strategy } from "../../src/core/types";
import { PostgresStore } from "../../src/postgres/store";
import { MemoryStore } from "../../src/stores/memory";
import { runStoreConformance } from "../../src/testkit";

/**
 * End-to-end proof for the PostgresStore. Because the store runs the same pure JS transform the
 * in-memory store runs, "correct" means two things, both proven here against a live server:
 *  1. the full store-conformance suite (persist / isolate / reset / TTL expiry / atomic RMW), and
 *  2. with real strategies — decisions are bit-identical to the JS executor (the JSON-text state
 *     round-trips through Postgres as the exact IEEE-754 double), and N concurrent checks admit
 *     exactly K (the advisory-lock critical section is truly atomic).
 *
 * Gated on a real Postgres (THROTTLEKIT_TEST_POSTGRES=postgres://user:pass@localhost:5433/db);
 * each concern uses its own table so they cannot interfere.
 */

const url = process.env.THROTTLEKIT_TEST_POSTGRES;

/** Deterministic PRNG so failures reproduce exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CREATE = (table: string): string =>
  `CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, state TEXT NOT NULL, expires_at BIGINT NOT NULL)`;

if (!url) {
  describe.skip("PostgresStore (set THROTTLEKIT_TEST_POSTGRES to run)", () => {
    it("skipped — no Postgres reachable", () => {});
  });
} else {
  // One pool for the file; sized so the 200-way concurrency test can make progress.
  const pool = new Pool({ connectionString: url, max: 25 });

  afterAll(async () => {
    await pool.end();
  });

  // 1) The framework-agnostic store conformance suite. A ManualClock drives expiry, so unlike the
  //    Redis suite (which can't control the server clock) the TTL-expiry test actually runs here.
  runStoreConformance(
    "PostgresStore",
    async () => {
      const clock = new ManualClock(1_700_000_000_000);
      await pool.query(CREATE("tk_conf"));
      await pool.query("TRUNCATE tk_conf");
      const store = new PostgresStore({ pool, table: "tk_conf", clock, sweepIntervalMs: 0 });
      return {
        store,
        advance: (ms: number) => clock.advance(ms),
        supportsTimeTravel: true,
        teardown: () => store.close(),
      };
    },
    { describe, it, beforeEach, afterEach, expect },
  );

  // 2) Real strategies: atomicity and dual-path equivalence to the JS executor.
  describe("PostgresStore — real strategies on a live server", () => {
    it("admits exactly K under N concurrent checks (advisory-lock atomicity)", async () => {
      const clock = new ManualClock(1_700_000_000_000);
      await pool.query(CREATE("tk_atomic"));
      await pool.query("TRUNCATE tk_atomic");
      const store = new PostgresStore({ pool, table: "tk_atomic", clock, sweepIntervalMs: 0 });
      const limiter = rateLimit({
        strategy: fixedWindow({ limit: 50, windowMs: 60_000 }),
        clock,
        store,
      });

      const N = 200;
      const decisions = await Promise.all(
        Array.from({ length: N }, () => limiter.check("hot-key")),
      );
      const allowed = decisions.filter((d) => d.allowed).length;
      expect(allowed).toBe(50);
      await store.close();
    });

    const cases: { name: string; make: () => Strategy }[] = [
      { name: "gcra", make: () => gcra({ limit: 100, periodMs: 60_000, burst: 20 }) },
      { name: "tokenBucket", make: () => tokenBucket({ capacity: 50, refillPerSec: 10 }) },
      {
        name: "slidingWindow",
        make: () => slidingWindow({ limit: 50, windowMs: 1000, buckets: 10 }),
      },
    ];

    for (const [ci, c] of cases.entries()) {
      it(`${c.name}: Postgres decisions match the JS executor (state round-trips exactly)`, async () => {
        await pool.query(CREATE("tk_dual"));
        await pool.query("TRUNCATE tk_dual");

        const TIMELINES = 6;
        const STEPS = 8;
        for (let t = 0; t < TIMELINES; t++) {
          const rng = mulberry32(5000 + ci * 101 + t);
          const clock = new ManualClock(1_700_000_000_000 + t * 37);
          const js = rateLimit({
            strategy: c.make(),
            clock,
            store: new MemoryStore({ clock, sweepIntervalMs: 0 }),
          });
          const pg = rateLimit({
            strategy: c.make(),
            clock,
            store: new PostgresStore({ pool, table: "tk_dual", clock, sweepIntervalMs: 0 }),
          });
          const key = `pg:${c.name}:${t}`;

          for (let s = 0; s < STEPS; s++) {
            clock.advance(Math.floor(rng() * 900));
            const cost = 1 + Math.floor(rng() * 4);
            const dJs = await js.check(key, cost);
            const dPg = await pg.check(key, cost);
            expect(
              dPg,
              `${c.name} timeline=${t} step=${s} now=${clock.now()} cost=${cost}`,
            ).toEqual(dJs);
          }
        }
      }, 60_000);
    }
  });
}
