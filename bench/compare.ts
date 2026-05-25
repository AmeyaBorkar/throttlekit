/**
 * ThrottleKit COMPARATIVE benchmark — ThrottleKit vs incumbent Node rate limiters.
 *
 *   npx tsx bench/compare.ts
 *   THROTTLEKIT_TEST_REDIS=redis://localhost:6380 npx tsx bench/compare.ts   # + Redis section
 *   node --expose-gc --import tsx bench/compare.ts                           # + allocation stats
 *
 * Fairness contract: every contender runs in the SAME process, on the SAME machine, with the
 * SAME warmup and the SAME iteration count, all measuring the ALLOW path (limits set high enough
 * that no request is ever denied). The algorithm each library actually implements is printed next
 * to its row so semantic differences are explicit — a counter and a GCRA cell are not the same
 * guarantee even when their ops/s are. Numbers are produced on YOUR hardware; nothing here is a
 * vendor claim, and no result is hidden or cherry-picked.
 *
 * Methodology mirrors bench/run.ts: warm up / JIT, then time `iters` calls with
 * process.hrtime.bigint(); report ops/s and ns/op; optional steady-state allocation under
 * --expose-gc; Redis reported as throughput plus p50/p99 latency.
 */
import { fixedWindow } from "../src/algorithms/fixed-window";
import { gcra } from "../src/algorithms/gcra";
import { rateLimit } from "../src/core/limiter";
import type { Store, Transform } from "../src/core/types";
import { MemoryStore } from "../src/stores/memory";
import { twoTier } from "../src/twotier";

import { MemoryStore as ExpressMemoryStore } from "express-rate-limit";
import { RateLimiterMemory } from "rate-limiter-flexible";

const gc = (globalThis as { gc?: () => void }).gc;

// Same iteration budgets for every contender within a tier, so the comparison is apples-to-apples.
const SYNC_ITERS = 5_000_000;
const ASYNC_ITERS = 1_000_000;
const ASYNC_WARMUP = 10_000;
const REDIS_ITERS = 3_000;
const REDIS_WARMUP = 200;
const REDIS_DB = 11;
const PG_ITERS = 1_500;
const PG_WARMUP = 100;

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(n < 10 ? 2 : 0);
}

interface ThroughputResult {
  opsPerSec: number;
  nsPerOp: number;
  bytesPerOp: number | null;
}

/** Measure a synchronous hot loop. Warms up, then times `iters` calls. Matches bench/run.ts. */
function throughput(fn: (i: number) => unknown, iters: number): ThroughputResult {
  for (let i = 0; i < Math.min(iters, 100_000); i++) fn(i); // warm up / JIT

  let bytesPerOp: number | null = null;
  if (gc) {
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < iters; i++) fn(i);
    const after = process.memoryUsage().heapUsed;
    bytesPerOp = Math.max(0, (after - before) / iters);
    gc();
  }

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn(i);
  const t1 = process.hrtime.bigint();
  const ns = Number(t1 - t0);
  return { opsPerSec: (iters / ns) * 1e9, nsPerOp: ns / iters, bytesPerOp };
}

/** Measure an async hot loop (awaited serially, like a single connection's request stream). */
async function throughputAsync(
  fn: (i: number) => Promise<unknown>,
  iters: number,
  warmup = ASYNC_WARMUP,
): Promise<ThroughputResult> {
  for (let i = 0; i < Math.min(iters, warmup); i++) await fn(i);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) await fn(i);
  const t1 = process.hrtime.bigint();
  const ns = Number(t1 - t0);
  return { opsPerSec: (iters / ns) * 1e9, nsPerOp: ns / iters, bytesPerOp: null };
}

function percentiles(samplesNs: number[]): { p50: number; p99: number; p999: number } {
  const s = samplesNs.slice().sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  return { p50: at(0.5), p99: at(0.99), p999: at(0.999) };
}

/** One row of a memory-tier table: library + algorithm + sync/async + measured throughput. */
interface Row {
  name: string;
  algo: string;
  kind: "sync" | "async";
  result: ThroughputResult;
}

function printTable(rows: Row[]): void {
  const nameW = Math.max(...rows.map((r) => r.name.length), 4);
  const algoW = Math.max(...rows.map((r) => r.algo.length), 9);
  const header = `  ${"contender".padEnd(nameW)}  ${"algorithm".padEnd(algoW)}  ${"kind".padEnd(5)}  ${"ops/s".padStart(8)}  ${"ns/op".padStart(7)}`;
  console.log(header);
  console.log(
    `  ${"-".repeat(nameW)}  ${"-".repeat(algoW)}  ${"-".repeat(5)}  ${"-".repeat(8)}  ${"-".repeat(7)}`,
  );
  for (const r of rows) {
    const alloc = r.result.bytesPerOp === null ? "" : `   ${r.result.bytesPerOp.toFixed(0)} B/op`;
    console.log(
      `  ${r.name.padEnd(nameW)}  ${r.algo.padEnd(algoW)}  ${r.kind.padEnd(5)}  ${fmt(r.result.opsPerSec).padStart(8)}  ${r.result.nsPerOp.toFixed(0).padStart(7)}${alloc}`,
    );
  }
}

async function memorySection(): Promise<void> {
  console.log("\n== MEMORY (in-process, single hot key, ALLOW path) ==");
  console.log(
    "   High limits so every request passes; same warmup + iteration count for all rows.",
  );

  // --- ThrottleKit: GCRA, sync hot path ---
  const tkGcraSync = rateLimit({
    strategy: gcra({ limit: 1_000_000, periodMs: 60_000 }),
    store: new MemoryStore({ sweepIntervalMs: 0 }),
  });

  // --- ThrottleKit: GCRA, async check (MemoryStore) ---
  const tkGcraAsync = rateLimit({
    strategy: gcra({ limit: 1_000_000, periodMs: 60_000 }),
    store: new MemoryStore({ sweepIntervalMs: 0 }),
  });

  // --- ThrottleKit: fixed-window, async check (apples-to-apples vs counter libs) ---
  const tkFixed = rateLimit({
    strategy: fixedWindow({ limit: 1_000_000_000, windowMs: 60_000 }),
    store: new MemoryStore({ sweepIntervalMs: 0 }),
  });

  // --- rate-limiter-flexible: RateLimiterMemory (atomic counter), async consume ---
  // points high enough that .consume never rejects within the run (it throws on exhaustion).
  const rlfMem = new RateLimiterMemory({ points: 2_000_000_000, duration: 60 });

  // --- express-rate-limit: in-memory store hot path .increment(key), async ---
  // windowMs is supplied via init(); MemoryStore reads only options.windowMs there.
  const erlStore = new ExpressMemoryStore();
  erlStore.init({ windowMs: 60_000 } as never);

  const rows: Row[] = [];

  rows.push({
    name: "throttlekit checkSync",
    algo: "GCRA",
    kind: "sync",
    result: throughput((_) => tkGcraSync.checkSync("k"), SYNC_ITERS),
  });
  rows.push({
    name: "throttlekit check",
    algo: "GCRA",
    kind: "async",
    result: await throughputAsync((_) => tkGcraAsync.check("k"), ASYNC_ITERS),
  });
  rows.push({
    name: "throttlekit check",
    algo: "fixed-window",
    kind: "async",
    result: await throughputAsync((_) => tkFixed.check("k"), ASYNC_ITERS),
  });
  rows.push({
    name: "rate-limiter-flexible",
    algo: "fixed-window",
    kind: "async",
    result: await throughputAsync((_) => rlfMem.consume("k"), ASYNC_ITERS),
  });
  rows.push({
    name: "express-rate-limit",
    algo: "fixed-window",
    kind: "async",
    result: await throughputAsync((_) => erlStore.increment("k"), ASYNC_ITERS),
  });

  printTable(rows);
  console.log(
    "   Note: sync vs async is not directly comparable — ThrottleKit's checkSync has no Promise/microtask",
  );
  console.log(
    "   overhead; the incumbents expose only async APIs. The async GCRA / fixed-window rows are the fair head-to-head.",
  );
  await erlStore.shutdown?.();
}

async function redisSection(): Promise<void> {
  const url = process.env.THROTTLEKIT_TEST_REDIS;
  if (!url) {
    console.log(
      "\n== REDIS == skipped (set THROTTLEKIT_TEST_REDIS=redis://localhost:6380 to enable)",
    );
    return;
  }

  const { default: Redis } = await import("ioredis");
  const { RedisStore } = await import("../src/redis/store");
  const { RateLimiterRedis } = await import("rate-limiter-flexible");

  // Identical client settings for both contenders, dedicated DB so we can flush only ours.
  const mkClient = () =>
    new Redis(url, { maxRetriesPerRequest: 2, db: REDIS_DB, lazyConnect: true });

  const probe = mkClient();
  try {
    await probe.connect();
    await probe.ping();
  } catch (err) {
    console.log(
      `\n== REDIS == skipped — could not reach ${url} (${(err as Error).message}). Start Redis on 6380 to enable.`,
    );
    probe.disconnect();
    return;
  }
  await probe.flushdb();
  probe.disconnect();

  console.log(`\n== REDIS (${url}, db ${REDIS_DB}) — single hot key, ALLOW path ==`);
  console.log(
    "   Same ioredis client settings, same server, same DB, same warmup + iteration count for both.",
  );

  const tkClient = mkClient();
  const rlfClient = mkClient();
  await Promise.all([tkClient.connect(), rlfClient.connect()]);

  // --- ThrottleKit RedisStore, GCRA (one EVALSHA per check) ---
  const tk = rateLimit({
    strategy: gcra({ limit: 1_000_000_000, periodMs: 60_000 }),
    store: new RedisStore({ client: tkClient }),
    prefix: "tk",
  });

  // --- rate-limiter-flexible RateLimiterRedis, fixed-window counter (one EVAL per consume) ---
  const rlf = new RateLimiterRedis({
    storeClient: rlfClient,
    points: 2_000_000_000,
    duration: 60,
    keyPrefix: "rlf",
  });

  interface RedisRow {
    name: string;
    algo: string;
    opsPerSec: number;
    p50: number;
    p99: number;
    p999: number;
  }

  async function measure(
    name: string,
    algo: string,
    once: () => Promise<unknown>,
  ): Promise<RedisRow> {
    for (let i = 0; i < REDIS_WARMUP; i++) await once(); // warm up + load the Lua script
    const samples: number[] = [];
    for (let i = 0; i < REDIS_ITERS; i++) {
      const t0 = process.hrtime.bigint();
      await once();
      samples.push(Number(process.hrtime.bigint() - t0));
    }
    const total = samples.reduce((a, b) => a + b, 0);
    const p = percentiles(samples);
    return { name, algo, opsPerSec: (REDIS_ITERS / total) * 1e9, ...p };
  }

  const redisRows: RedisRow[] = [];
  redisRows.push(await measure("throttlekit RedisStore", "GCRA", () => tk.check("k")));
  redisRows.push(await measure("rate-limiter-flexible", "fixed-window", () => rlf.consume("k")));

  const nameW = Math.max(...redisRows.map((r) => r.name.length), 9);
  const algoW = Math.max(...redisRows.map((r) => r.algo.length), 9);
  console.log(
    `  ${"contender".padEnd(nameW)}  ${"algorithm".padEnd(algoW)}  ${"ops/s".padStart(8)}  ${"p50".padStart(8)}  ${"p99".padStart(8)}  ${"p999".padStart(8)}`,
  );
  console.log(
    `  ${"-".repeat(nameW)}  ${"-".repeat(algoW)}  ${"-".repeat(8)}  ${"-".repeat(8)}  ${"-".repeat(8)}  ${"-".repeat(8)}`,
  );
  for (const r of redisRows) {
    console.log(
      `  ${r.name.padEnd(nameW)}  ${r.algo.padEnd(algoW)}  ${fmt(r.opsPerSec).padStart(8)}  ${`${(r.p50 / 1000).toFixed(1)}µs`.padStart(8)}  ${`${(r.p99 / 1000).toFixed(1)}µs`.padStart(8)}  ${`${(r.p999 / 1000).toFixed(1)}µs`.padStart(8)}`,
    );
  }
  console.log(
    "   Both do one atomic Lua round trip per request (EVALSHA/EVAL). Serial awaits ⇒ latency-bound, not pipelined.",
  );

  await tkClient.flushdb();
  await Promise.all([tkClient.quit(), rlfClient.quit()]);
}

async function postgresSection(): Promise<void> {
  const url = process.env.THROTTLEKIT_TEST_POSTGRES;
  if (!url) {
    console.log(
      "\n== POSTGRES == skipped (set THROTTLEKIT_TEST_POSTGRES=postgres://user:pass@localhost:5433/db to enable)",
    );
    return;
  }

  const { Pool } = await import("pg");
  const { PostgresStore } = await import("../src/postgres/store");
  const { RateLimiterPostgres } = await import("rate-limiter-flexible");

  const pool = new Pool({ connectionString: url, max: 10 });
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    console.log(`\n== POSTGRES == skipped — could not reach ${url} (${(err as Error).message}).`);
    await pool.end();
    return;
  }

  console.log(`\n== POSTGRES (${url}) — single hot key, ALLOW path ==`);
  console.log("   Same pg.Pool, same server/DB, same warmup + iteration count for both.");

  // ThrottleKit: GCRA over a generic transactional read-modify-write (advisory lock + read + write).
  const tk = rateLimit({
    strategy: gcra({ limit: 2_000_000_000, periodMs: 60_000 }),
    store: new PostgresStore({ pool, table: "tk_bench", sweepIntervalMs: 0 }),
    prefix: "tk",
  });

  // rate-limiter-flexible: a fixed-window counter expressed as one atomic UPSERT. Its table is
  // created asynchronously; the constructor callback fires when it is ready.
  let rlf!: InstanceType<typeof RateLimiterPostgres>;
  await new Promise<void>((resolve, reject) => {
    rlf = new RateLimiterPostgres(
      { storeClient: pool, points: 2_000_000_000, duration: 60, tableName: "rlflx_bench" },
      (err?: Error) => (err ? reject(err) : resolve()),
    );
  });

  interface PgRow {
    name: string;
    algo: string;
    rt: string;
    opsPerSec: number;
    p50: number;
    p99: number;
    p999: number;
  }

  async function measure(
    name: string,
    algo: string,
    rt: string,
    once: () => Promise<unknown>,
  ): Promise<PgRow> {
    for (let i = 0; i < PG_WARMUP; i++) await once(); // warm up + create tables
    const samples: number[] = [];
    for (let i = 0; i < PG_ITERS; i++) {
      const t0 = process.hrtime.bigint();
      await once();
      samples.push(Number(process.hrtime.bigint() - t0));
    }
    const total = samples.reduce((a, b) => a + b, 0);
    return { name, algo, rt, opsPerSec: (PG_ITERS / total) * 1e9, ...percentiles(samples) };
  }

  const rows: PgRow[] = [];
  rows.push(await measure("throttlekit PostgresStore", "GCRA", "~5 (txn)", () => tk.check("k")));
  rows.push(
    await measure("rate-limiter-flexible", "fixed-window", "1 (upsert)", () => rlf.consume("k")),
  );

  const nameW = Math.max(...rows.map((r) => r.name.length), 9);
  console.log(
    `  ${"contender".padEnd(nameW)}  ${"algorithm".padEnd(12)}  ${"round trips".padStart(11)}  ${"ops/s".padStart(7)}  ${"p50".padStart(8)}  ${"p99".padStart(8)}`,
  );
  console.log(
    `  ${"-".repeat(nameW)}  ${"-".repeat(12)}  ${"-".repeat(11)}  ${"-".repeat(7)}  ${"-".repeat(8)}  ${"-".repeat(8)}`,
  );
  for (const r of rows) {
    console.log(
      `  ${r.name.padEnd(nameW)}  ${r.algo.padEnd(12)}  ${r.rt.padStart(11)}  ${fmt(r.opsPerSec).padStart(7)}  ${`${(r.p50 / 1000).toFixed(1)}µs`.padStart(8)}  ${`${(r.p99 / 1000).toFixed(1)}µs`.padStart(8)}`,
    );
  }
  console.log(
    "   ThrottleKit runs a generic RMW transaction (advisory lock + read + write + commit) to reuse the same",
  );
  console.log(
    "   proven transform across every strategy; rate-limiter-flexible specializes the counter into one atomic",
  );
  console.log(
    "   UPSERT. Fewer round trips ⇒ lower per-op latency there — but the throughput lever below has no",
  );
  console.log("   rate-limiter-flexible equivalent:");

  // The win: front PostgresStore with twoTier(leased) — one transaction per `batch` requests.
  await pool.query("TRUNCATE tk_bench").catch(() => {});
  const leasedBase = new PostgresStore({ pool, table: "tk_bench", sweepIntervalMs: 0 });
  let txns = 0;
  const counting: Store = {
    apply<S, R>(k: string, t: Transform<S, R>): Promise<R> {
      txns++;
      return leasedBase.apply(k, t);
    },
    reset: (k: string) => leasedBase.reset(k),
  };
  const leased = twoTier({
    strategy: gcra({ limit: 2_000_000_000, periodMs: 60_000 }),
    l2: counting,
    mode: "leased",
    lease: { batch: 100 },
  });
  for (let i = 0; i < 100; i++) await leased.check("lk"); // warm
  txns = 0;
  const lt0 = process.hrtime.bigint();
  for (let i = 0; i < PG_ITERS; i++) await leased.check("lk");
  const lns = Number(process.hrtime.bigint() - lt0);
  console.log(
    `  throttlekit twoTier(leased)  GCRA          batch 100  ${fmt((PG_ITERS / lns) * 1e9).padStart(7)}  ${`${(lns / PG_ITERS / 1000).toFixed(1)}µs/op`.padStart(10)}  (${(PG_ITERS / txns).toFixed(0)} reqs / transaction)`,
  );
  await leasedBase.close();

  await pool.query("TRUNCATE tk_bench").catch(() => {});
  await pool.query('TRUNCATE "rlflx_bench"').catch(() => {});
  await pool.end();
}

async function main(): Promise<void> {
  console.log("ThrottleKit comparative benchmarks (vs rate-limiter-flexible, express-rate-limit)");
  console.log(
    `node ${process.version}  ${gc ? "(gc exposed — measuring allocations)" : "(no --expose-gc — allocations not measured)"}`,
  );
  console.log(
    "Excluded: @upstash/ratelimit — requires the Upstash cloud REST endpoint and cannot be benchmarked locally on equal footing.",
  );

  await memorySection();
  await redisSection();
  await postgresSection();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
