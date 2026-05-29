/**
 * TK-1321 — joint-LP dual-path conformance (Redis-gated, D-JLP-6).
 *
 * The bid-price filter is pure JS applied AFTER the rate/cost step, so it must
 * compose identically over `backend: "sequential"` and `backend: "lua-fused"`.
 * Two checks:
 *  1. Generous axes (never bind) ⇒ the filter is the ONLY thing that can deny ⇒
 *     the `(allowed, policyDenied)` stream is bit-identical across backends.
 *  2. Binding axes ⇒ filter + budget interaction ⇒ the admit/deny pattern agrees
 *     (mirrors the TK-1006 sequential≡fused conformance, robust to ms clock-skew).
 *
 * Gated on `THROTTLEKIT_TEST_REDIS` (e.g. redis://localhost:6380). DB 12 (8/9/10/11
 * are used by other gated suites).
 */

import { createClient } from "redis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { unifiedAdmission } from "../../src/admission/unified";
import { gcra } from "../../src/algorithms/gcra";
import { tokenBucket } from "../../src/algorithms/token-bucket";
import { rateLimit } from "../../src/core/limiter";
import { fromNodeRedis } from "../../src/redis/clients";
import { RedisStore } from "../../src/redis/store";

const url = process.env.THROTTLEKIT_TEST_REDIS;
const d = url ? describe : describe.skip;

const DUALS = { rate: 0, cost: 0.5 }; // bid = 0.5·cost

d("joint-LP dual-path conformance (D-JLP-6)", () => {
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    client = createClient({ url: url as string, database: 12 });
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

  // A varied (cost, value) stream: some clear the bid (value ≥ 0.5·cost), some don't.
  const stream = Array.from({ length: 24 }, (_, i) => ({
    key: "k",
    cost: i % 3 === 0 ? 80 : 30,
    value: i % 2 === 0 ? 100 : 5, // 5 < 0.5·30=15 and < 0.5·80=40 ⇒ filtered; 100 clears both
  }));

  it("generous axes: filter is the only denier ⇒ (allowed, policyDenied) is bit-identical", async () => {
    const seqStore = new RedisStore({ client: fromNodeRedis(client), prefix: "seqA" });
    const seq = unifiedAdmission({
      rate: rateLimit({
        strategy: gcra({ limit: 1e6, periodMs: 60_000 }),
        store: seqStore,
        prefix: "rate",
      }),
      cost: rateLimit({
        strategy: tokenBucket({ capacity: 1e9, refillPerSec: 1e6 }),
        store: seqStore,
        prefix: "cost",
      }),
      policy: "joint-lp",
      jointLp: { duals: DUALS },
    });
    const fused = unifiedAdmission({
      backend: "lua-fused",
      fused: {
        client: fromNodeRedis(client),
        rate: { strategy: "gcra", limit: 1e6, periodMs: 60_000, prefix: "fusedA:rate" },
        cost: { strategy: "tokenBucket", capacity: 1e9, refillPerSec: 1e6, prefix: "fusedA:cost" },
        useServerTime: true,
      },
      policy: "joint-lp",
      jointLp: { duals: DUALS },
    });

    const seqOut: Array<[boolean, boolean]> = [];
    const fusedOut: Array<[boolean, boolean]> = [];
    for (const s of stream) {
      const r = await seq.admit(s);
      seqOut.push([r.decision.allowed, r.policyDenied === true]);
      r.release();
      const f = await fused.admit(s);
      fusedOut.push([f.decision.allowed, f.policyDenied === true]);
      f.release();
    }
    expect(fusedOut).toEqual(seqOut);
    // Sanity: the stream actually exercised both filter-deny and clear.
    expect(seqOut.some(([, pd]) => pd)).toBe(true);
    expect(seqOut.some(([allowed]) => allowed)).toBe(true);
  });

  it("binding axes: filter + budget interaction ⇒ admit/deny pattern agrees", async () => {
    const seqStore = new RedisStore({ client: fromNodeRedis(client), prefix: "seqB" });
    const seq = unifiedAdmission({
      rate: rateLimit({
        strategy: gcra({ limit: 10, periodMs: 60_000 }),
        store: seqStore,
        prefix: "rate",
      }),
      cost: rateLimit({
        strategy: tokenBucket({ capacity: 1_000, refillPerSec: 100 }),
        store: seqStore,
        prefix: "cost",
      }),
      policy: "joint-lp",
      jointLp: { duals: DUALS },
    });
    const fused = unifiedAdmission({
      backend: "lua-fused",
      fused: {
        client: fromNodeRedis(client),
        rate: { strategy: "gcra", limit: 10, periodMs: 60_000, prefix: "fusedB:rate" },
        cost: {
          strategy: "tokenBucket",
          capacity: 1_000,
          refillPerSec: 100,
          prefix: "fusedB:cost",
        },
        useServerTime: true,
      },
      policy: "joint-lp",
      jointLp: { duals: DUALS },
    });

    const seqAllowed: boolean[] = [];
    const fusedAllowed: boolean[] = [];
    let seqPolicyDenials = 0;
    for (const s of stream) {
      const r = await seq.admit(s);
      seqAllowed.push(r.decision.allowed);
      if (r.policyDenied) seqPolicyDenials++;
      r.release();
      const f = await fused.admit(s);
      fusedAllowed.push(f.decision.allowed);
      f.release();
    }
    expect(fusedAllowed).toEqual(seqAllowed);
    // Sanity: the filter actually fired (else this comparison would be trivially
    // satisfiable by a no-op gate).
    expect(seqPolicyDenials).toBeGreaterThan(0);
  });
});
