import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedWindow } from "../../../src/algorithms/fixed-window";
import { gcra } from "../../../src/algorithms/gcra";
import { quota } from "../../../src/algorithms/quota";
import { slidingWindow } from "../../../src/algorithms/sliding-window";
import { slidingWindowLog } from "../../../src/algorithms/sliding-window-log";
import { tokenBucket } from "../../../src/algorithms/token-bucket";
import { ManualClock } from "../../../src/core/clock";
import { rateLimit } from "../../../src/core/limiter";
import type { Decision, Strategy } from "../../../src/core/types";
import { RedisStore } from "../../../src/redis/store";
import { MemoryStore } from "../../../src/stores/memory";

/**
 * #281 What-If Replay — P0 PR0.1: the load-bearing cross-store determinism gate.
 *
 * Replay's bit-exactness rests on one claim (design §3.2): a strategy's transition is a pure function
 * of `(state, now, cost)`, so the JavaScript path (`MemoryStore`) and the Redis Lua path (`RedisStore`,
 * one `EVALSHA` per check) return **bit-identical** `Decision`s for the same inputs — including
 * `resetAt`, which we deliberately do NOT zero out, so the `%.17g` TAT round-trip (gcra), the
 * token-bucket refill, the windowed-counter math, and the civil-calendar quota arithmetic are all
 * cross-checked to the last integer. This is the only replay test that exercises Lua.
 *
 * HERMETICITY (the load-bearing subtlety). Redis keys expire via `PEXPIRE` in REAL wall-clock time,
 * but `MemoryStore` expires off the injected `ManualClock` (logical time). If a single key accumulated
 * state across a long real-time run, its Redis `PEXPIRE` could elapse between two same-window writes
 * while the logical clock stood still — Redis would recompute a cold window (ALLOW) while Memory still
 * held the live count (DENY): a spurious divergence with no bearing on the transition math. We avoid
 * that exactly as the repo's property-based sibling does (`test/conformance/lua-property.test.ts`,
 * which documents the same race): every scenario is a SHORT **episode** on a FRESH key with FRESH
 * stores, so each accumulating key's real-time lifetime (~tens of ms) stays far below any strategy's
 * TTL. Logical time still jumps across windows WITHIN an episode (deltas up to seconds/days) to
 * exercise the self-heal recompute — but Redis never physically expires mid-episode, so the gate
 * measures pure `(state, now, cost)` equivalence with wall-clock influence neutralized.
 *
 * Relationship to the existing suite: this is the replay-OWNED, deterministic-seeded instantiation of
 * the dual-path proof (re-run in P1.5 as replay's final gate, design §9), complementing the
 * fast-check sibling above. Its net-new coverage over that sibling: the `quota` **calendar-month**
 * civil-calendar Lua across a real month boundary AND the 2024-02-29 leap day (the sibling only does
 * `quota-fixed`), and the `slidingWindowLog` cost>1 multi-stamp append path.
 *
 * Gated on a real Redis (`THROTTLEKIT_TEST_REDIS`, port 6380 per project convention). All 16 logical
 * DBs are already allocated one-per-file, so this suite co-tenants logical DB 7 with the existing
 * sanctioned flush-free group (see test/redis/db-allocation.test.ts): it issues NO `FLUSHDB` and
 * isolates its keys under a per-run-unique {@link RUN} namespace, so it can neither wipe nor be wiped
 * by a co-tenant. This test must be green on `main` before any P1 replay surface ships.
 */

const url = process.env.THROTTLEKIT_TEST_REDIS;
const d = url ? describe : describe.skip;

/** Deterministic PRNG so any divergence is reproducible from the seed alone. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Per-run-unique Redis key namespace. ONLY a storage handle for the flush-free DB-7 co-tenancy — it
 * has ZERO effect on decisions (strategies key state by the opaque key string and never inspect its
 * content), so every Decision stays fully reproducible from the seeded arrival stream. It guarantees
 * our keys are cold at run start (no prior run's keys collide) without a DB-global `FLUSHDB`.
 */
const RUN = randomUUID().slice(0, 8);

const DAY_MS = 86_400_000;
/** A real instant (~2023-11-14) so calendar-quota math runs over genuine civil dates. */
const BASE = 1_700_000_000_000;
/** ~2024-02-09, so calendar-month episodes march across the 2024-02-29 leap day and month boundaries. */
const LEAP_BASE = 1_707_500_000_000;

interface Config {
  name: string;
  make: () => Strategy;
  /** Independent episodes; each gets a fresh key + fresh stores (keeps real-time key lifetime short). */
  episodes: number;
  /** Steps (arrivals) per episode. episodes * steps = total arrivals exercised. */
  steps: number;
  /** Logical start of episode 0. */
  startAt: number;
  /** Logical start offset added per episode, so episodes probe different window phases. */
  episodeStepMs: number;
  /** Upper bound on the (uniform) forward logical step between steps within an episode, in ms. */
  maxDeltaMs: number;
  /** Upper bound on per-request cost (cost ∈ [1, maxCost]). */
  maxCost: number;
  seed: number;
  /** Whether this config is expected to exhaust capacity and produce denials (anti-trivial-pass guard). */
  expectDenials: boolean;
}

// Physical Redis GC is decoupled from the logical window via the store's `ttlFloorMs` (5 min, set above),
// so a slow box can no longer let a key's real-time PEXPIRE elapse between two same-window writes while the
// injected logical clock stands still. Episodes stay short (12 steps) only to keep the run quick; the gate's
// correctness no longer depends on real-time staying under any strategy's window.
const CONFIGS: Config[] = [
  {
    name: "gcra",
    make: () => gcra({ limit: 10, periodMs: 2000, burst: 5 }), // T=200ms ⇒ min per-write TTL ~200ms
    episodes: 60,
    steps: 12,
    startAt: BASE,
    episodeStepMs: 7,
    maxDeltaMs: 1500,
    maxCost: 4,
    seed: 101,
    expectDenials: true,
  },
  {
    name: "tokenBucket",
    make: () => tokenBucket({ capacity: 8, refillPerSec: 4 }), // refill-to-cap TTL ~2000ms
    episodes: 60,
    steps: 12,
    startAt: BASE,
    episodeStepMs: 11,
    maxDeltaMs: 1500,
    maxCost: 4,
    seed: 102,
    expectDenials: true,
  },
  {
    name: "fixedWindow",
    make: () => fixedWindow({ limit: 6, windowMs: 2000 }), // wide window ⇒ near-boundary tiny-TTL is rare
    episodes: 60,
    steps: 12,
    startAt: BASE,
    episodeStepMs: 13,
    maxDeltaMs: 800,
    maxCost: 4,
    seed: 103,
    expectDenials: true,
  },
  {
    name: "slidingWindow",
    make: () => slidingWindow({ limit: 8, windowMs: 1000, buckets: 4 }), // TTL ≈ ceil(windowMs+w), no clamp
    episodes: 60,
    steps: 12,
    startAt: BASE,
    episodeStepMs: 17,
    maxDeltaMs: 600,
    maxCost: 4,
    seed: 104,
    expectDenials: true,
  },
  {
    name: "slidingWindowLog",
    make: () => slidingWindowLog({ limit: 6, windowMs: 1000 }), // TTL ≈ window, no clamp
    episodes: 60,
    steps: 12,
    startAt: BASE,
    episodeStepMs: 19,
    maxDeltaMs: 600,
    maxCost: 4, // cost>1 exercises the ZADD multi-stamp append path vs the JS push loop
    seed: 105,
    expectDenials: true,
  },
  {
    name: "quota-fixed",
    make: () => quota({ limit: 8, resetCadence: "fixed", periodMs: 3000, anchor: 250 }), // wide period
    episodes: 60,
    steps: 12,
    startAt: BASE,
    episodeStepMs: 23,
    maxDeltaMs: 1200,
    maxCost: 4,
    seed: 106,
    expectDenials: true,
  },
  {
    name: "quota-rolling",
    make: () => quota({ limit: 8, resetCadence: "rolling", periodMs: 1000, buckets: 4 }), // ⇒ slidingWindow
    episodes: 60,
    steps: 12,
    startAt: BASE,
    episodeStepMs: 29,
    maxDeltaMs: 500,
    maxCost: 4,
    seed: 107,
    expectDenials: true,
  },
  {
    // Net-new vs the fast-check sibling: civil-calendar Lua across month boundaries + the 2024 leap
    // day. Calendar-month TTL is ~31 days, so real-time PEXPIRE never elapses during the test — the
    // self-heal here is the in-period `start != period_start` reset (quota.ts:124 Lua / :231 JS).
    name: "quota-month",
    make: () => quota({ limit: 12, resetCadence: "calendar-month" }),
    episodes: 60,
    steps: 12,
    startAt: LEAP_BASE,
    episodeStepMs: 2 * DAY_MS,
    maxDeltaMs: 6 * DAY_MS,
    maxCost: 5,
    seed: 108,
    expectDenials: true,
  },
];

interface Mismatch {
  episode: number;
  step: number;
  at: number;
  cost: number;
  mem: Decision;
  red: Decision;
}

function differs(a: Decision, b: Decision): boolean {
  return (
    a.allowed !== b.allowed ||
    a.limit !== b.limit ||
    a.remaining !== b.remaining ||
    a.resetAt !== b.resetAt ||
    a.retryAfterMs !== b.retryAfterMs
  );
}

async function compare(
  client: Redis,
  cfg: Config,
): Promise<{ mism: Mismatch[]; allowed: number; denied: number; total: number }> {
  const rand = mulberry32(cfg.seed);
  const mism: Mismatch[] = [];
  let allowed = 0;
  let denied = 0;
  let total = 0;

  for (let e = 0; e < cfg.episodes; e++) {
    // Fresh key + fresh stores per episode: each accumulating key lives only ~steps round trips of
    // real time (far under any strategy TTL), so Redis never physically expires mid-episode.
    const clock = new ManualClock(cfg.startAt + e * cfg.episodeStepMs);
    const memStore = new MemoryStore({ clock, sweepIntervalMs: 0 });
    const prefix = `xs:${RUN}:${cfg.name}:${e}`;
    // Both limiters read the SAME clock; Redis is told to use the client-supplied `now` (no server TIME).
    const mem = rateLimit({ strategy: cfg.make(), clock, store: memStore, prefix });
    const red = rateLimit({
      strategy: cfg.make(),
      clock,
      // ttlFloorMs decouples Redis's real-time GC from the logical window: with useServerTime:false the
      // logical clock is the injected ManualClock, so a slow real interval between two same-window writes
      // could otherwise let the physical key expire while the logical clock stood still (Redis reads a cold
      // window → divergence). A 5-min floor means real-time GC never fires during the run; lazy logical
      // expiry (the strategy's stale-window reset) still drives every decision — identically to MemoryStore.
      store: new RedisStore({ client, useServerTime: false, ttlFloorMs: 300_000 }),
      prefix,
    });

    for (let s = 0; s < cfg.steps; s++) {
      clock.advance(Math.floor(rand() * cfg.maxDeltaMs)); // forward; a 0-step (same instant) is allowed
      const cost = 1 + Math.floor(rand() * cfg.maxCost);
      const m = await mem.check("k", cost);
      const r = await red.check("k", cost);
      total++;
      if (m.allowed) allowed++;
      else denied++;
      if (differs(m, r) && mism.length < 25) {
        mism.push({ episode: e, step: s, at: clock.now(), cost, mem: m, red: r });
      }
    }
    await memStore.close();
  }
  return { mism, allowed, denied, total };
}

d("cross-store Memory<->Redis decision equivalence (the determinism gate)", () => {
  let client: Redis;

  beforeAll(async () => {
    // db: 7 is a SANCTIONED flush-free co-tenancy (see test/redis/db-allocation.test.ts). We must
    // NOT FLUSHDB here — the per-run RUN namespace gives us cold keys without disturbing co-tenants.
    client = new Redis(url as string, { db: 7, maxRetriesPerRequest: 2 });
  });

  afterAll(async () => {
    await client?.quit();
  });

  for (const cfg of CONFIGS) {
    it(`${cfg.name}: bit-identical Decisions over ${cfg.episodes}×${cfg.steps} arrivals across epochs`, async () => {
      const { mism, allowed, denied, total } = await compare(client, cfg);
      if (mism.length > 0) {
        const f = mism[0] as Mismatch;
        throw new Error(
          `${cfg.name}: ${mism.length} cross-store divergence(s). First at episode ${f.episode} step ${f.step} ` +
            `(now=${f.at}, cost=${f.cost}):\n` +
            `  memory=${JSON.stringify(f.mem)}\n  redis =${JSON.stringify(f.red)}`,
        );
      }
      // Anti-trivial-pass: the seeded stream must actually exercise admit (and, where expected, denial)
      // decisions — otherwise "all identical" would be vacuous.
      expect(total).toBe(cfg.episodes * cfg.steps);
      expect(allowed).toBeGreaterThan(0);
      if (cfg.expectDenials) expect(denied).toBeGreaterThan(0);
    });
  }
});
