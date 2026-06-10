/**
 * Tier-2 client-spend micro-benchmark — the in-process cost of serving a leased credit.
 *
 * The Tier-2 lease's whole point is that 99% of requests never leave the process: the client leases a chunk
 * of the global budget once (a `Fleet.Reserve` round trip), then serves it locally with `LeaseSpender.spend`
 * at in-process speed. This harness measures that local spend — the hot path a leased client actually pays —
 * against a full in-process GCRA `checkSync` for scale. The spend is the core `LeaseSpender` the golden lease
 * vectors pin, so this is the cost of the conformance-locked path, not a stand-in.
 *
 *   npm run bench:lease
 *   node --expose-gc --import tsx bench/lease.ts   # + steady-state allocation (B/op)
 *
 * ALLOW path, single key, credits pre-loaded so the window never rolls and no request ever refreshes — this
 * isolates the spend cost from the (separately benchmarked) `Fleet.Reserve` round trip. Numbers are produced
 * on YOUR hardware; nothing here is a vendor claim.
 */
import { gcra } from "../src/algorithms/gcra";
import { tokenBucket } from "../src/algorithms/token-bucket";
import { rateLimit } from "../src/core/limiter";
import { MemoryStore } from "../src/stores/memory";
import { LeaseSpender } from "../src/twotier/lease-spender";
import { writeManifest } from "./manifest";

const gc = (globalThis as { gc?: () => void }).gc;

interface Row {
  label: string;
  note: string;
  opsPerSec: number;
  nsPerOp: number;
  bytesPerOp: number | null;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(n < 10 ? 2 : 0);
}

/** Measure a synchronous hot loop. Warms up / JITs, optionally measures steady-state allocation, then times. */
function measure(label: string, note: string, fn: (i: number) => unknown, iters: number): Row {
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
  const ns = Number(process.hrtime.bigint() - t0);
  return { label, note, opsPerSec: (iters / ns) * 1e9, nsPerOp: ns / iters, bytesPerOp };
}

function report(r: Row): void {
  const alloc = r.bytesPerOp === null ? "n/a (--expose-gc)" : `${r.bytesPerOp.toFixed(0)} B/op`;
  console.log(
    `  ${r.label.padEnd(30)} ${fmt(r.opsPerSec).padStart(8)} ops/s   ${r.nsPerOp.toFixed(0).padStart(5)} ns/op   ${alloc.padStart(16)}   ${r.note}`,
  );
}

function main(): void {
  console.log("ThrottleKit Tier-2 client-spend benchmark (in-process)");
  console.log(
    `node ${process.version}  ${gc ? "(gc exposed — measuring allocations)" : "(no --expose-gc — allocations not measured)"}`,
  );
  console.log("\nLocal spend vs. a full in-process decision — single hot key, ALLOW path:");

  const ITERS = 5_000_000;
  const rows: Row[] = [];

  // The Tier-2 client spend: one huge lease pre-loaded, coupled to a far-future window so nothing ever
  // discards or refreshes — every call is the pure local credit decrement + synthesized allow.
  const spender = new LeaseSpender({ limit: 1_000_000_000 });
  spender.applyLease({ capacity: Number.MAX_SAFE_INTEGER, expiresAt: Number.MAX_SAFE_INTEGER });
  const now = 1_000_000;
  rows.push(
    measure(
      "LeaseSpender.spend",
      "Tier-2 local credit + synth allow",
      () => spender.spend(now, 1),
      ITERS,
    ),
  );

  // For scale: a full in-process GCRA decision (the embedded fast path) and a tokenBucket decision.
  const gcraLimiter = rateLimit({
    strategy: gcra({ limit: 1_000_000, periodMs: 60_000 }),
    store: new MemoryStore({ sweepIntervalMs: 0 }),
  });
  rows.push(
    measure(
      "gcra checkSync",
      "full GCRA decision (for scale)",
      () => gcraLimiter.checkSync("k"),
      ITERS,
    ),
  );

  const tb = rateLimit({
    strategy: tokenBucket({ capacity: 1_000_000, refillPerSec: 1_000_000 }),
    store: new MemoryStore({ sweepIntervalMs: 0 }),
  });
  rows.push(
    measure(
      "tokenBucket checkSync",
      "full tokenBucket decision (for scale)",
      () => tb.checkSync("k"),
      ITERS,
    ),
  );

  for (const r of rows) report(r);

  const path = writeManifest("lease-inproc", {
    benchmark: "tier2-client-spend-in-process",
    iters: ITERS,
    rows,
  });
  console.log(`\nManifest: ${path}`);
}

main();
