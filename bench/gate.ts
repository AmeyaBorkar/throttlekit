/**
 * Continuous bench regression gate — machine-independent.
 *
 *   npm run bench:gate              # compare against bench/baseline.json
 *   npm run bench:baseline          # write bench/baseline.json from a fresh run
 *
 *   BENCH_REGRESSION_THRESHOLD=1.25  # fail when a row's RELATIVE cost grew > this × baseline (default 1.25)
 *
 * Scope is deliberately narrow: the three sync single-state strategies' `checkSync` hot paths
 * (gcra / tokenBucket / fixedWindow). The Redis/Postgres paths are network-dominated and add
 * noise that drowns out algorithmic regressions — those have their own latency-tier monitoring
 * via bench/compare.ts.
 *
 * ## Why ratios-of-ratios (the machine-independence trick)
 *
 * Absolute ns/op differ 1.5–2× across machines — a dev laptop vs a shared `ubuntu-latest` CI
 * runner, and even across CI runner *generations*. Comparing a CI run's absolute ns against a
 * baseline recorded on a different machine (this repo's was recorded on win32) conflates a real
 * regression with "this runner is simply slower", so such a gate can only ever be advisory. We
 * remove that bias by normalising every measurement to an in-run REFERENCE loop, timed on the
 * SAME machine in the SAME process:
 *
 *     relative = strategyNsPerOp / referenceNsPerOp
 *
 * The reference ({@link referenceOp}) is a frozen hot loop over the same primitive mix the
 * strategies pay for — a one-entry Map get/set, a clock read, a branch, integer math — but it
 * shares NO `src/` code, so (a) a regression anywhere in the library's hot path raises the
 * strategy's ns without moving the reference's, and (b) raw machine speed multiplies BOTH and
 * cancels in the ratio. The baseline stores `relative`; the gate compares `current.relative /
 * baseline.relative`, which is dimensionless and machine-portable — so it is safe to BLOCK CI.
 *
 * Residual (honest): normalisation cancels clock-rate / scheduler bias exactly, but not the
 * micro-architectural difference between the reference's mix and a given strategy's (cache,
 * branch prediction). The default threshold keeps a cushion for that. The regressions this gate
 * exists to catch — a hot path deoptimising, e.g. a closure megamorphising `checkSync` (~3×) —
 * sit far above it. Tighten `BENCH_REGRESSION_THRESHOLD` toward 1.15 once CI history confirms the
 * relative metric's run-to-run spread on the shared runner is small.
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

// Best-of-N timing converges as N grows; N=10 keeps run-to-run noise on the canonical hot loops
// under ~5% in practice — enough headroom under the threshold to distinguish real algorithmic
// regressions from sampling jitter. ITERS=2M makes the per-run jitter dominate the JIT warmup
// (which is ~100k iters), so the timed window is steady-state.
const RUNS = 10;
const ITERS = 2_000_000;
const DEFAULT_THRESHOLD = 1.25;
// Bump on incompatible shape changes so old files fail loud. v2 added machine-independent
// `relative` + the reference denominator (v1 stored only absolute `nsPerOp` and could not block).
const BASELINE_SCHEMA_VERSION = 2 as const;

interface Row {
  label: string;
  /** Best-of-RUNS ns/op (the min is the most stable estimator on noisy hardware). Human-facing. */
  nsPerOp: number;
  /** nsPerOp / referenceNsPerOp — the dimensionless, machine-independent metric the gate compares. */
  relative: number;
}

interface Baseline {
  /** Schema version — bump on incompatible shape changes so old files fail loud. */
  schemaVersion: typeof BASELINE_SCHEMA_VERSION;
  /** Provenance — human-readable, not used by the gate (the whole point is it need not match CI). */
  recorded: { at: string; node: string; platform: string };
  /** Bench parameters that produced these numbers. */
  runs: number;
  iters: number;
  /** The reference loop's best-of-N ns/op on the recording machine. Provenance; not compared. */
  referenceNsPerOp: number;
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

/**
 * The cross-machine normaliser. A frozen workload that mirrors the strategies' primitive mix
 * (a one-entry Map get/set, a clock read, a data-dependent branch, integer math) so it scales
 * with the same machine factors a `checkSync` does — but it deliberately touches NO `src/` code,
 * so a library regression can never move it. The Map write + the returned value (consumed by the
 * timer) keep V8 from eliminating the loop, exactly as a real `checkSync`'s side effects do.
 *
 * Denominating strategy cost in "reference ops" is what makes a win32-recorded baseline valid on
 * an ubuntu CI runner: both numerator and denominator are measured on whatever machine is running.
 */
export function referenceOp(): () => number {
  const state = new Map<string, number>([["k", 0]]);
  return () => {
    const now = Date.now();
    const prev = state.get("k") ?? 0;
    const next = (prev + 1) & 0x3fff_ffff;
    // Branch on a runtime value so it isn't constant-folded; always write back so it isn't DCE'd.
    state.set("k", (now & 1) === 0 ? next : prev);
    return next;
  };
}

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

export function measureRows(runs = RUNS, iters = ITERS): { rows: Row[]; referenceNsPerOp: number } {
  const referenceNsPerOp = timeBestOf(referenceOp(), iters, runs);
  const rows = cases.map((c) => {
    const limiter = c.make();
    const nsPerOp = timeBestOf(() => limiter.checkSync("k"), iters, runs);
    return { label: c.label, nsPerOp, relative: nsPerOp / referenceNsPerOp };
  });
  return { rows, referenceNsPerOp };
}

export function makeBaseline(
  rows: Row[],
  referenceNsPerOp: number,
  runs = RUNS,
  iters = ITERS,
): Baseline {
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    recorded: {
      at: new Date().toISOString().slice(0, 10),
      node: process.version,
      platform: process.platform,
    },
    runs,
    iters,
    referenceNsPerOp,
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
  /** Absolute ns on THIS run/machine — human context only; not comparable across machines. */
  currentNs: number;
  /** The gated metric on this run. */
  currentRel: number;
  /** The gated metric in the baseline (undefined for a row the baseline doesn't have). */
  baselineRel: number | undefined;
  /** currentRel / baselineRel — dimensionless, machine-independent. */
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
        currentRel: cur.relative,
        baselineRel: undefined,
        ratio: undefined,
        status: "new",
      };
    }
    const ratio = cur.relative / base.relative;
    const status: CompareRow["status"] =
      ratio > threshold ? "regressed" : ratio < 0.9 ? "improved" : "ok";
    return {
      label: cur.label,
      currentNs: cur.nsPerOp,
      currentRel: cur.relative,
      baselineRel: base.relative,
      ratio,
      status,
    };
  });
}

const MARK = { ok: "✓", improved: "↓", regressed: "✗", new: "?" } as const;

function fmtNs(ns: number): string {
  return ns.toFixed(0).padStart(6);
}

function fmtRel(rel: number | undefined): string {
  return rel === undefined ? "   n/a" : `×${rel.toFixed(2)}`.padStart(6);
}

export function formatTable(rows: CompareRow[]): string {
  const w = Math.max(...rows.map((r) => r.label.length), 5);
  const out: string[] = [];
  out.push(
    `  ${" ".padEnd(2)} ${"row".padEnd(w)}  ${"this run".padStart(9)}  ${"rel".padStart(6)}  ${"baseline".padStart(8)}  ${"delta".padStart(8)}`,
  );
  out.push(
    `  ${"-".repeat(2)} ${"-".repeat(w)}  ${"-".repeat(9)}  ${"-".repeat(6)}  ${"-".repeat(8)}  ${"-".repeat(8)}`,
  );
  for (const r of rows) {
    const deltaStr =
      r.ratio === undefined
        ? "     n/a"
        : `${r.ratio >= 1 ? "+" : ""}${((r.ratio - 1) * 100).toFixed(1)}%`.padStart(8);
    out.push(
      `  ${MARK[r.status]}  ${r.label.padEnd(w)}  ${fmtNs(r.currentNs)} ns  ${fmtRel(r.currentRel)}  ${fmtRel(r.baselineRel).padStart(8)}  ${deltaStr}`,
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
    `bench:gate — node ${process.version}, ${RUNS} runs × ${ITERS.toLocaleString()} iters, threshold ${threshold.toFixed(2)} (relative)`,
  );
  const { rows: current, referenceNsPerOp } = measureRows();
  console.log(`reference op: ${fmtNs(referenceNsPerOp).trim()} ns/op (this machine)`);

  if (update) {
    const b = makeBaseline(current, referenceNsPerOp);
    writeBaseline(b);
    console.log(`\nWrote ${BASELINE_PATH}:`);
    for (const r of current) {
      console.log(`  ${r.label.padEnd(24)} ${fmtNs(r.nsPerOp)} ns/op  ×${r.relative.toFixed(2)}`);
    }
    return 0;
  }

  const baseline = readBaseline();
  if (baseline === undefined) {
    console.error(
      `\nNo baseline at ${BASELINE_PATH}. Run \`npm run bench:baseline\` to create one.`,
    );
    return 2;
  }
  if (baseline.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    console.error(
      `\nbaseline.json is schema v${baseline.schemaVersion}, this gate needs v${BASELINE_SCHEMA_VERSION} (machine-independent relative metric). Re-baseline with \`npm run bench:baseline\` and commit it.`,
    );
    return 2;
  }
  const comparison = compareRows(current, baseline, threshold);
  console.log(
    `\nBaseline recorded ${baseline.recorded.at} on ${baseline.recorded.platform} / ${baseline.recorded.node} ` +
      `(ref ${baseline.referenceNsPerOp.toFixed(0)} ns there); comparing machine-independent ratios:`,
  );
  console.log(formatTable(comparison));
  const regressed = comparison.filter((r) => r.status === "regressed");
  if (regressed.length > 0) {
    console.error(
      `\n✗ ${regressed.length} row(s) regressed > ${((threshold - 1) * 100).toFixed(0)}% (relative): ${regressed.map((r) => r.label).join(", ")}`,
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
