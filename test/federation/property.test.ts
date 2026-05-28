/**
 * TK-908 — property-based dual-path proof for federation.
 *
 * Fast-check generates adversarial (regionIdx, cost) timelines, drives
 * them through BOTH coordinator backends (TestCoordinator in-memory + the
 * Lua-backed RedisCoordinator), and asserts the admit-decision streams
 * agree. Any divergence shrinks to a minimal counterexample.
 *
 * Scope: single-window timelines (no clock advance across boundary). The
 * federation engine's lazy reconcile is fire-and-forget — the Redis path
 * has unbounded scheduling vs the synchronous TestCoordinator path, which
 * makes cross-window comparisons inherently noisy. Per-strategy multi-
 * window correctness is covered by federated-skew.test.ts; this file
 * isolates the dual-path JS↔Lua atomicity.
 *
 * Gated on THROTTLEKIT_TEST_REDIS — skip when no Redis available.
 */

import fc from "fast-check";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fixedWindow } from "../../src/algorithms/fixed-window";
import { ManualClock } from "../../src/core/clock";
import { RedisCoordinator, TestCoordinator, federate } from "../../src/federation";
import { fromNodeRedis } from "../../src/redis/clients";

const url = process.env.THROTTLEKIT_TEST_REDIS;
const d = url ? describe : describe.skip;

/** One step of the adversarial timeline. */
interface Step {
  /** Which region issues this request (index into the K-region array). */
  regionIdx: number;
  /** Per-request cost. */
  cost: number;
}

const makeTimeline = (K: number): fc.Arbitrary<Step[]> =>
  fc.array(
    fc.record({
      regionIdx: fc.integer({ min: 0, max: K - 1 }),
      cost: fc.integer({ min: 1, max: 4 }),
    }),
    { minLength: 1, maxLength: 50 },
  );

interface RunResult {
  admittedTotal: number;
  /** Decision sequence — admitted booleans in step order. */
  admits: boolean[];
}

async function runTimeline(
  K: number,
  L: number,
  batch: number,
  steps: Step[],
  makeCoord: () => Promise<{
    coord: {
      lease: (...a: never[]) => Promise<number>;
      reconcile: (...a: never[]) => Promise<void>;
    };
    teardown: () => Promise<void>;
  }>,
): Promise<RunResult> {
  const windowMs = 60_000;
  const clock = new ManualClock(0);
  const { coord, teardown } = await makeCoord();

  const limiters = Array.from({ length: K }, (_, r) =>
    federate({
      strategy: fixedWindow({ limit: L, windowMs }),
      // biome-ignore lint/suspicious/noExplicitAny: cross-test coordinator types are equivalent at the GlobalCoordinator interface
      coordinator: coord as any,
      region: `r${r}`,
      batch,
      clock,
    }),
  );

  const admits: boolean[] = [];
  let admittedTotal = 0;
  for (const step of steps) {
    const limiter = limiters[step.regionIdx];
    if (limiter === undefined) {
      throw new Error(`invalid regionIdx ${step.regionIdx} (K=${K})`);
    }
    const decision = await limiter.check("hot", step.cost);
    admits.push(decision.allowed);
    if (decision.allowed) admittedTotal += step.cost;
  }

  await teardown();
  return { admittedTotal, admits };
}

d("federation/property (TK-908) — dual-path bit-identity", () => {
  let client: ReturnType<typeof createClient>;
  let keyCounter = 0;

  beforeAll(async () => {
    client = createClient({ url: url as string, database: 9 });
    await client.connect();
    await client.flushDb();
  });

  afterAll(async () => {
    if (client?.isOpen) {
      await client.flushDb();
      await client.quit();
    }
  });

  for (const K of [2, 3, 4]) {
    for (const L of [12, 30]) {
      it(`K=${K}, L=${L}: TestCoordinator and RedisCoordinator agree on admit streams`, async () => {
        await fc.assert(
          fc.asyncProperty(makeTimeline(K), async (steps) => {
            // Unique prefix per fast-check shrink iteration so prior state can't leak.
            keyCounter++;
            const prefix = `prop-tk908-${keyCounter}`;
            const batch = 4;

            const jsResult = await runTimeline(K, L, batch, steps, async () => ({
              coord: new TestCoordinator({ budgetPerWindow: L }),
              teardown: async () => undefined,
            }));

            const redisResult = await runTimeline(K, L, batch, steps, async () => ({
              coord: new RedisCoordinator({
                client: fromNodeRedis(client),
                windowMs: 60_000,
                budgetPerWindow: L,
                prefix,
              }),
              teardown: async () => undefined,
            }));

            // BIT-IDENTICAL admit streams: the federation engine state is
            // in-process for both; the only difference is the coordinator
            // backend's storage. Since the engine's lease-then-await pattern
            // serializes calls (no per-region parallelism in this test), the
            // sequence of (lease grants, decisions) is determined by the
            // engine's algorithm — same for both coordinator backends.
            expect(redisResult.admits).toEqual(jsResult.admits);

            // Δ = 0 holds across both paths.
            expect(redisResult.admittedTotal).toBeLessThanOrEqual(L);
            expect(jsResult.admittedTotal).toBeLessThanOrEqual(L);
          }),
          {
            numRuns: 50,
            // Standard property-test budgets: enough breadth without ballooning
            // CI time. fast-check shrinks to a minimal (steps) counterexample
            // automatically; the failure message exposes the exact timeline.
          },
        );
      });
    }
  }
});
