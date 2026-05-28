/**
 * Continuous bench regression gate.
 *
 *   npm run bench:gate              # compare against bench/baseline.json
 *   npm run bench:baseline          # write bench/baseline.json from a fresh run
 *
 *   BENCH_REGRESSION_THRESHOLD=1.10  # gate exits non-zero when current > baseline × this (default 1.10)
 *
 * Scope is deliberately narrow: the three sync single-state strategies' `checkSync` hot paths
 * (gcra / tokenBucket / fixedWindow). The Redis/Postgres paths are network-dominated and add
 * noise that drowns out algorithmic regressions — those have their own latency-tier monitoring
 * via bench/compare.ts. The numbers here are reproducible best-of-N micro-benchmarks; absolutes
 * differ across hardware, so the gate compares RATIOS (current / baseline) and a delta > the
 * configured threshold fails the run with a per-row table.
 *
 * On CI the gate runs with `continue-on-error: true` initially (informational), so noise on
 * shared runners can't block merges; the table still surfaces regressions for the reviewer.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { fixedWindow } from "../src/algorithms/fixed-window";
import { gcra } from "../src/algorithms/gcra";
import { tokenBucket } from "../src/algorithms/token-bucket";
import { rateLimit } from "../src/core/limiter";
import { MemoryStore } from "../src/stores/memory";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolvePath(HERE, "baseline.json");

// Best-of-N timing converges as N grows; N=10 keeps run-to-run noise on the canonical Windows /
// macOS hot loops under ~5% in practice — enough headroom under a 10% threshold to distinguish
// real algorithmic regressions from sampling jitter. ITERS=2M makes the per-run jitter dominate
// the JIT warmup (which is ~100k iters), so the timed window is steady-state.
const RUNS = 10;
const ITERS = 2_000_000;
const DEFAULT_THRESHOLD = 1.1;

interface Row {
  label: string;
  /** Best-of-RUNS ns/op (the minimum is the most stable estimator on noisy hardware). */
  nsPerOp: number;
}

interface Baseline {
  /** Schema version — bump on incompatible shape changes so old files fail loud. */
  schemaVersion: 1;
  /** Provenance — human-readable, not used by the gate. */
  recorded: { at: string; node: string; platform: string };
  /** Bench parameters that produced these numbers. */
  runs: number;
  iters: number;
  rows: Row[];
}

interface BenchCase {
  label: string;
  make: () => { checkSync: (key: string) => unknown };
}

const cases: BenchCase[] = [
  {
    label: "gcra checkSync",
    make: () =>
      rateLimit({
        strategy: gcra({ limit: 1_000_000, periodMs: 60_000 }),
        store: new MemoryStore({ sweepIntervalMs: 0 }),
      }),
  },
  {
    label: "tokenBucket checkSync",
    make: () =>
      rateLimit({
        strategy: tokenBucket({ capacity: 1_000_000, refillPerSec: 1_000_000 }),
        store: new MemoryStore({ sweepIntervalMs: 0 }),
      }),
  },
  {
    label: "fixedWindow checkSync",
    make: () =>
      rateLimit({
        strategy: fixedWindow({ limit: 1_000_000_000, windowMs: 60_000 }),
        store: new MemoryStore({ sweepIntervalMs: 0 }),
      }),
  },
];

/** Time `fn` for `iters` iterations after a warmup pass; returns ns/op. */
function timeOne(fn: () => unknown, iters: number): number {
  for (let i = 0; i < Math.min(iters, 100_000); i++) fn(); // warmup / JIT
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  return Number(process.hrtime.bigint() - t0) / iters;
}

/** Best-of-N timing — the min is more stable than the mean under noisy CPU scheduling. */
function timeBestOf(fn: () => unknown, iters: number, runs: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < runs; r++) {
    const ns = timeOne(fn, iters);
    if (ns < best) best = ns;
  }
  return best;
}

export function measureRows(runs = RUNS, iters = ITERS): Row[] {
  return cases.map((c) => {
    const limiter = c.make();
    const nsPerOp = timeBestOf(() => limiter.checkSync("k"), iters, runs);
    return { label: c.label, nsPerOp };
  });
}

export function makeBaseline(rows: Row[], runs = RUNS, iters = ITERS): Baseline {
  return {
    schemaVersion: 1,
    recorded: {
      at: new Date().toISOString().slice(0, 10),
      node: process.version,
      platform: process.platform,
    },
    runs,
    iters,
    rows,
  };
}

export function readBaseline(path: string = BASELINE_PATH): Baseline | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Baseline;
}

export function writeBaseline(b: Baseline, path: string = BASELINE_PATH): void {
  writeFileSync(path, `${JSON.stringify(b, null, 2)}\n`, "utf8");
}

interface CompareRow {
  label: string;
  currentNs: number;
  baselineNs: number | undefined;
  ratio: number | undefined;
  status: "ok" | "improved" | "regressed" | "new";
}

export function compareRows(current: Row[], baseline: Baseline, threshold: number): CompareRow[] {
  return current.map((cur) => {
    const base = baseline.rows.find((r) => r.label === cur.label);
    if (!base) {
      return {
        label: cur.label,
        currentNs: cur.nsPerOp,
        baselineNs: undefined,
        ratio: undefined,
        status: "new",
      };
    }
    const ratio = cur.nsPerOp / base.nsPerOp;
    const status: CompareRow["status"] =
      ratio > threshold ? "regressed" : ratio < 0.9 ? "improved" : "ok";
    return {
      label: cur.label,
      currentNs: cur.nsPerOp,
      baselineNs: base.nsPerOp,
      ratio,
      status,
    };
  });
}

const MARK = { ok: "✓", improved: "↓", regressed: "✗", new: "?" } as const;

function fmtNs(ns: number): string {
  return ns.toFixed(0).padStart(6);
}

export function formatTable(rows: CompareRow[]): string {
  const w = Math.max(...rows.map((r) => r.label.length), 5);
  const out: string[] = [];
  out.push(
    `  ${" ".padEnd(2)} ${"row".padEnd(w)}  ${"current".padStart(9)}  ${"baseline".padStart(9)}  ${"delta".padStart(8)}`,
  );
  out.push(
    `  ${"-".repeat(2)} ${"-".repeat(w)}  ${"-".repeat(9)}  ${"-".repeat(9)}  ${"-".repeat(8)}`,
  );
  for (const r of rows) {
    const baseStr = r.baselineNs === undefined ? "    n/a  " : `${fmtNs(r.baselineNs)} ns`;
    const deltaStr =
      r.ratio === undefined
        ? "     n/a"
        : `${r.ratio >= 1 ? "+" : ""}${((r.ratio - 1) * 100).toFixed(1)}%`.padStart(8);
    out.push(
      `  ${MARK[r.status]}  ${r.label.padEnd(w)}  ${fmtNs(r.currentNs)} ns  ${baseStr}  ${deltaStr}`,
    );
  }
  return out.join("\n");
}

/** Top-level CLI: `--update` writes baseline; otherwise compare. Returns exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const update = argv.includes("--update") || argv.includes("--baseline");
  const thresholdEnv = process.env.BENCH_REGRESSION_THRESHOLD;
  const threshold = thresholdEnv ? Number(thresholdEnv) : DEFAULT_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold <= 1) {
    console.error(
      `bench:gate: BENCH_REGRESSION_THRESHOLD must be > 1 (got ${process.env.BENCH_REGRESSION_THRESHOLD}); using ${DEFAULT_THRESHOLD}`,
    );
  }

  console.log(
    `bench:gate — node ${process.version}, ${RUNS} runs × ${ITERS.toLocaleString()} iters, threshold ${threshold.toFixed(2)}`,
  );
  const current = measureRows();

  if (update) {
    const b = makeBaseline(current);
    writeBaseline(b);
    console.log(`\nWrote ${BASELINE_PATH}:`);
    for (const r of current) console.log(`  ${r.label.padEnd(24)} ${fmtNs(r.nsPerOp)} ns/op`);
    return 0;
  }

  const baseline = readBaseline();
  if (baseline === undefined) {
    console.error(
      `\nNo baseline at ${BASELINE_PATH}. Run \`npm run bench:baseline\` to create one.`,
    );
    return 2;
  }
  const comparison = compareRows(current, baseline, threshold);
  console.log(
    `\nBaseline recorded ${baseline.recorded.at} on ${baseline.recorded.platform} / ${baseline.recorded.node}:`,
  );
  console.log(formatTable(comparison));
  const regressed = comparison.filter((r) => r.status === "regressed");
  if (regressed.length > 0) {
    console.error(
      `\n✗ ${regressed.length} row(s) regressed > ${((threshold - 1) * 100).toFixed(0)}%: ${regressed.map((r) => r.label).join(", ")}`,
    );
    console.error(
      "  If this is an intentional change, re-baseline with `npm run bench:baseline` and commit bench/baseline.json.",
    );
    return 1;
  }
  console.log("\n✓ no regressions above threshold");
  return 0;
}

// Run-as-script entry: only fire when this file is the program, not when imported by a test.
const invokedAsScript =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);
if (invokedAsScript) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(2);
    });
}
