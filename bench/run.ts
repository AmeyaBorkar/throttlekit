/**
 * ThrottleKit benchmark harness.
 *
 *   npm run bench                 # in-process micro-benchmarks
 *   npm run bench -- --redis      # also benchmark the Redis paths (needs THROTTLEKIT_TEST_REDIS)
 *   node --expose-gc --import tsx bench/run.ts   # include steady-state allocation measurement
 *
 * Numbers are produced on YOUR hardware — nothing here is a vendor claim.
 */
import { fixedWindow } from "../src/algorithms/fixed-window";
import { gcra } from "../src/algorithms/gcra";
import { tokenBucket } from "../src/algorithms/token-bucket";
import { adaptiveConcurrency } from "../src/concurrency/adaptive";
import { distributedAdaptiveConcurrency } from "../src/concurrency/distributed";
import { TestConcurrencyCoordinator } from "../src/concurrency/test-concurrency-coordinator";
import { rateLimit } from "../src/core/limiter";
import { MemoryStore } from "../src/stores/memory";

const gc = (globalThis as { gc?: () => void }).gc;

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

/** Measure a synchronous hot loop. Warms up, then times `iters` calls. */
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

async function throughputAsync(
  fn: (i: number) => Promise<unknown>,
  iters: number,
): Promise<ThroughputResult> {
  for (let i = 0; i < Math.min(iters, 10_000); i++) await fn(i);
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

function reportThroughput(name: string, r: ThroughputResult): void {
  const alloc =
    r.bytesPerOp === null ? "n/a (run with --expose-gc)" : `${r.bytesPerOp.toFixed(0)} B/op`;
  console.log(
    `  ${name.padEnd(34)} ${fmt(r.opsPerSec).padStart(8)} ops/s   ${r.nsPerOp.toFixed(0).padStart(6)} ns/op   ${alloc}`,
  );
}

function memorySection(): void {
  console.log("\nIn-process (MemoryStore) — single hot key:");
  const gcraLimiter = rateLimit({
    strategy: gcra({ limit: 1_000_000, periodMs: 60_000 }),
    store: new MemoryStore({ sweepIntervalMs: 0 }),
  });
  reportThroughput(
    "gcra checkSync",
    throughput((_) => gcraLimiter.checkSync("k"), 5_000_000),
  );

  const tb = rateLimit({
    strategy: tokenBucket({ capacity: 1_000_000, refillPerSec: 1_000_000 }),
    store: new MemoryStore({ sweepIntervalMs: 0 }),
  });
  reportThroughput(
    "tokenBucket checkSync",
    throughput((_) => tb.checkSync("k"), 5_000_000),
  );

  const fw = rateLimit({
    strategy: fixedWindow({ limit: 1_000_000_000, windowMs: 60_000 }),
    store: new MemoryStore({ sweepIntervalMs: 0 }),
  });
  reportThroughput(
    "fixedWindow checkSync",
    throughput((_) => fw.checkSync("k"), 5_000_000),
  );
}

async function asyncSection(): Promise<void> {
  console.log("\nIn-process (MemoryStore) — async check:");
  const limiter = rateLimit({
    strategy: gcra({ limit: 1_000_000, periodMs: 60_000 }),
    store: new MemoryStore({ sweepIntervalMs: 0 }),
  });
  reportThroughput(
    "gcra check (async)",
    await throughputAsync((_) => limiter.check("k"), 1_000_000),
  );
}

async function concurrencySection(): Promise<void> {
  console.log("\nConcurrency — acquire + release (per request, healthy):");
  // High limits so the inflight ceiling never binds in a tight acquire→release
  // loop (inflight goes 0→1→0); this isolates the per-request guard overhead.
  const ac = adaptiveConcurrency({ minLimit: 1_000_000, maxLimit: 1_000_000 });
  reportThroughput(
    "adaptiveConcurrency acq+release",
    throughput((_) => {
      const l = ac.acquire();
      l.release();
      return l.ok;
    }, 5_000_000),
  );

  const coord = new TestConcurrencyCoordinator();
  const dac = distributedAdaptiveConcurrency({
    coordinator: coord,
    nodeId: "bench",
    local: { minLimit: 1_000_000, maxLimit: 1_000_000 },
  });
  await dac.heartbeat(); // take a share so acquire admits (cold start is fail-closed)
  reportThroughput(
    "distributed acq+release",
    throughput((_) => {
      const l = dac.acquire();
      l.release();
      return l.ok;
    }, 5_000_000),
  );
  await dac.close();
}

async function redisSection(): Promise<void> {
  const url = process.env.THROTTLEKIT_TEST_REDIS;
  if (!url) {
    console.log("\nRedis: skipped (set THROTTLEKIT_TEST_REDIS=redis://host:port and pass --redis)");
    return;
  }
  const { default: Redis } = await import("ioredis");
  const { RedisStore } = await import("../src/redis/store");
  const { twoTier } = await import("../src/twotier");
  const client = new Redis(url, { maxRetriesPerRequest: 2, db: 9 });
  await client.flushdb();

  console.log(`\nRedis (${url}, db 9):`);
  const strict = rateLimit({
    strategy: gcra({ limit: 1_000_000_000, periodMs: 60_000 }),
    store: new RedisStore({ client }),
  });
  // warm up (loads the script)
  for (let i = 0; i < 200; i++) await strict.check("k");
  const N = 3000;
  const samples: number[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    await strict.check("k");
    samples.push(Number(process.hrtime.bigint() - t0));
  }
  const p = percentiles(samples);
  const total = samples.reduce((a, b) => a + b, 0);
  console.log(
    `  strict gcra (1 EVALSHA / req)      ${fmt((N / total) * 1e9).padStart(8)} ops/s   p50 ${(p.p50 / 1000).toFixed(1)}µs  p99 ${(p.p99 / 1000).toFixed(1)}µs  p999 ${(p.p999 / 1000).toFixed(1)}µs`,
  );

  // leased: count actual L2 round trips vs requests served.
  let l2Calls = 0;
  const counting = {
    apply<S, R>(
      key: string,
      t: (s: S | undefined) => { state: S | undefined; result: R; ttlMs: number; persist: boolean },
    ) {
      l2Calls++;
      return new RedisStore({ client }).apply(key, t as never);
    },
    async reset(key: string) {
      await client.del(key);
    },
  };
  const B = 100;
  const leased = twoTier({
    strategy: gcra({ limit: 1_000_000_000, periodMs: 60_000 }),
    l2: counting as never,
    mode: "leased",
    lease: { batch: B },
  });
  const reqs = 10_000;
  await client.flushdb();
  l2Calls = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < reqs; i++) await leased.check("k");
  const ns = Number(process.hrtime.bigint() - t0);
  console.log(
    `  leased gcra (batch ${B})            ${fmt((reqs / ns) * 1e9).padStart(8)} ops/s   ${(reqs / l2Calls).toFixed(1)} reqs / round trip (${l2Calls} trips for ${reqs} reqs)`,
  );

  await client.quit();
}

async function main(): Promise<void> {
  console.log("ThrottleKit benchmarks");
  console.log(
    `node ${process.version}  ${gc ? "(gc exposed — measuring allocations)" : "(no --expose-gc — allocations not measured)"}`,
  );
  memorySection();
  await asyncSection();
  await concurrencySection();
  if (process.argv.includes("--redis")) await redisSection();
  else console.log("\n(pass --redis to also benchmark the Redis paths)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
