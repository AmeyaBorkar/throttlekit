/**
 * Continuous bench regression gate — machine-independent.
 *
 *   npm run bench:gate              # compare against bench/baseline.json
 *   npm run bench:baseline          # write bench/baseline.json from a fresh run
 *
 *   BENCH_REGRESSION_THRESHOLD=1.5   # fail when a row's RELATIVE cost grew > this × baseline (default 1.5)
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
 * Residual (honest, and measured): normalisation cancels clock-rate / scheduler bias, but the
 * reference's instruction MIX doesn't perfectly track each strategy's. Most of the gap is the clock
 * read — `Date.now()` is a larger fraction of the reference than of a `checkSync`, and its cost
 * differs sharply across OSes (~3× cheaper on Linux than Windows). So a win32-recorded baseline read
 * on an `ubuntu-latest` runner sees every relative cost rise a *systematic* residual — measured up to
 * ~50% on the checkSync rows (gcra +35%, tokenBucket +51%, fixedWindow +53% on one ubuntu-24 runner,
 * larger than an early 20–30% estimate). The threshold is therefore **2.0**: clear of that cross-OS
 * residual with margin for runner-generation variance, yet still well below the regressions this gate
 * exists to catch — a hot path deoptimising (a closure megamorphising `checkSync`) is ~3× = +200%.
 * For a *tighter* gate, record the baseline on the CI OS (then the residual is just same-OS generation
 * variance, a few percent), or compare the PR against its base commit measured on the same runner.
 *
 * The noise floor ({@link NOISE_FLOOR_NS}): the ratio trick only works once the measured op is slow
 * enough that the reference normalisation resolves it. An op whose *baseline* time is a handful of ns
 * — e.g. `lease spend` ≈ 22 ns, a pure credit decrement that, unlike `checkSync`, reads no clock at
 * all — is dominated by timer resolution and the reference's clock-mix mismatch, so its cross-machine
 * ratio is pure noise (it swung +130% on the same runner with no code change). Such rows are MEASURED
 * and shown but NOT gated *here*; their performance is pinned instead by their own absolute-time bench
 * (`bench/lease.ts`) and unit coverage, which need no cross-machine normalisation. The floor is keyed
 * on the BASELINE size, so a merely-slow runner can never tip a fast row into a false regression.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { fixedWindow } from "../src/algorithms/fixed-window";
import { gcra } from "../src/algorithms/gcra";
import { tokenBucket } from "../src/algorithms/token-bucket";
import { rateLimit } from "../src/core/limiter";
import { all, multiRateLimit } from "../src/multi/index";
import { MemoryStore } from "../src/stores/memory";
import { LeaseSpender } from "../src/twotier/lease-spender";
import { weightedFairEscrow } from "../src/twotier/weighted-fair-escrow";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolvePath(HERE, "baseline.json");

// Best-of-N timing converges as N grows; N=10 keeps run-to-run noise on the canonical hot loops
// under ~5% in practice — enough headroom under the threshold to distinguish real algorithmic
// regressions from sampling jitter. ITERS=2M makes the per-run jitter dominate the JIT warmup
// (which is ~100k iters), so the timed window is steady-state.
const RUNS = 10;
const ITERS = 2_000_000;
const DEFAULT_THRESHOLD = 2.0;
/**
 * Ratio-gate noise floor (ns). A row whose BASELINE absolute time is below this is too fast for the
 * reference normalisation to resolve across machines — its cross-OS ratio is noise (see the header).
 * Such rows are reported but never marked `regressed`. 30 ns sits comfortably under the gated
 * checkSync rows (≈170–200 ns on the baseline machine) and above the sub-credit ops (`lease spend`
 * ≈ 22 ns), so it excuses exactly the rows the ratio trick can't resolve, and no real strategy hot path.
 */
const NOISE_FLOOR_NS = 30;
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
  /**
   * Per-case timed-iteration override (default {@link ITERS}). The 2M default is sized for the ~170 ns
   * `checkSync` rows, where many iters are needed to dominate timer + warmup noise. A microsecond-scale
   * row (the multi-dimensional combine is ~5–8 µs/op — `structuredClone` on the read path) is already
   * dead-stable at a fraction of that, and 2M iters would make the gate take minutes for no precision
   * gain — so those cases lower it. `relative` is a per-op ratio, independent of the iteration count, so
   * the machine-independent metric the gate compares is unaffected.
   */
  iters?: number;
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
  {
    // The Tier-2 client local-spend hot path (the released lease hero). A pre-credited spender coupled to a
    // far-future window so every call is the pure O(1) credit decrement + synthesized allow — never a
    // refresh — so this guards `LeaseSpender.spend` against a future deopt or per-spend allocation, the same
    // failure class the gate exists to catch for `checkSync`. Adapts to the BenchCase `checkSync(key)` shape.
    label: "lease spend",
    make: () => {
      const s = new LeaseSpender({ limit: 1_000_000 });
      s.applyLease({ capacity: Number.MAX_SAFE_INTEGER, expiresAt: Number.MAX_SAFE_INTEGER });
      return { checkSync: () => s.spend(0, 1) };
    },
  },
  {
    // Multi-dimensional `all()` over a sync store, 2 dimensions (per-ip ∧ per-user). Each dimension's
    // read phase peeks a `structuredClone` of its (primitive) gcra state before committing all-or-none —
    // the path the perf audit's strongest win (skipping that clone for primitive state) lands on, so this
    // guards it against a deopt the same way the `checkSync` rows guard the single-state algorithms. Each
    // dimension uses the SAME gcra params as `gcra checkSync` above, so this row's relative cost is the
    // combine-over-2-gcra-dimensions overhead. Adapts to the BenchCase `checkSync(key)` shape (ctx fixed).
    label: "multi all() 2-dim checkSync",
    iters: 200_000, // ~5 µs/op ⇒ 200k timed iters is already dead-stable; 2M would add minutes to the gate
    make: () => {
      const mkDim = () => gcra({ limit: 1_000_000, periodMs: 60_000 });
      const m = multiRateLimit<{ ip: string; user: string }>({
        strategy: all<{ ip: string; user: string }>({
          ip: { key: (c) => c.ip, strategy: mkDim() },
          user: { key: (c) => c.user, strategy: mkDim() },
        }),
        store: new MemoryStore({ sweepIntervalMs: 0 }),
      });
      const ctx = { ip: "203.0.113.7", user: "u-42" };
      return { checkSync: () => m.checkSync(ctx) };
    },
  },
  {
    // The 3-dimension sibling (per-ip ∧ per-user ∧ per-route) — one more cloned-state read + commit per
    // check, so the gap to the 2-dim row isolates the per-dimension cost the audit's clone-skip win cuts.
    label: "multi all() 3-dim checkSync",
    iters: 200_000, // ~8 µs/op ⇒ see the 2-dim note; keep the gate tractable
    make: () => {
      const mkDim = () => gcra({ limit: 1_000_000, periodMs: 60_000 });
      const m = multiRateLimit<{ ip: string; user: string; route: string }>({
        strategy: all<{ ip: string; user: string; route: string }>({
          ip: { key: (c) => c.ip, strategy: mkDim() },
          user: { key: (c) => c.user, strategy: mkDim() },
          route: { key: (c) => c.route, strategy: mkDim() },
        }),
        store: new MemoryStore({ sweepIntervalMs: 0 }),
      });
      const ctx = { ip: "203.0.113.7", user: "u-42", route: "/v1/chat/completions" };
      return { checkSync: () => m.checkSync(ctx) };
    },
  },
  {
    // Two-tier weighted-fair-escrow per-decision grant (L1-only ⇒ synchronous). Rotating 8 tenants keeps
    // them all in the active set so the O(active-tenants) `aggregate()` scan that runs on every decision is
    // exercised (not collapsed to N=1); `L` is large enough that every check stays on the within-guarantee
    // grant branch (the ALLOW path). Guards the fair-allocation hot path the same way the others guard theirs.
    label: "weightedFairEscrow grant (8 tenants)",
    make: () => {
      const wfe = weightedFairEscrow({ limit: 1_000_000_000, windowMs: 60_000 });
      const tenants = Array.from({ length: 8 }, (_, i) => `tenant-${i}`);
      let i = 0;
      return { checkSync: () => wfe.checkSync(tenants[i++ % tenants.length] as string) };
    },
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
    const nsPerOp = timeBestOf(() => limiter.checkSync("k"), c.iters ?? iters, runs);
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
  status: "ok" | "improved" | "regressed" | "new" | "fast";
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
    // Below the noise floor the cross-machine ratio is meaningless (see NOISE_FLOOR_NS) — measure and
    // show it, but never let it fail the gate. Keyed on the BASELINE size so a slow runner can't false-fail.
    const status: CompareRow["status"] =
      base.nsPerOp < NOISE_FLOOR_NS
        ? "fast"
        : ratio > threshold
          ? "regressed"
          : ratio < 0.9
            ? "improved"
            : "ok";
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

const MARK = { ok: "✓", improved: "↓", regressed: "✗", new: "?", fast: "·" } as const;

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
