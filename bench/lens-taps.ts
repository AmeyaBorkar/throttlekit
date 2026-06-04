/**
 * Lens tap-overhead bench — proves the always-on telemetry taps don't wreck the control path.
 *
 *   npm run bench:lens
 *   LENS_TAP_MAX_RATIO=12 npm run bench:lens   # fail if the fully-tapped path exceeds N× a bare checkSync
 *
 * The Lens hub wraps every tracked limiter in `tapDecisions(withAnalytics(limiter))` (and every admitter in
 * the admission equivalents). Those run **synchronously on every decision**, so their cost is paid on the
 * hot path. This bench measures that cost as a SAME-PROCESS RATIO to a bare `checkSync` — raw CPU speed
 * cancels in the ratio, so the number is machine-independent (the same trick bench/gate.ts uses, here
 * "tapped ÷ bare" instead of "strategy ÷ reference"). It PRINTS the ratio and FAILS only on a catastrophic
 * regression (a megamorphic deopt of the hot path would be 50×+); the precise per-strategy cost policing
 * stays in bench/gate.ts. Per-denial recording into the hub's ring buffers is O(1) by construction
 * (lens/src/ring.ts — no per-append `shift`), so it doesn't change the steady-state per-decision cost.
 */
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { gcra } from "../src/algorithms/gcra";
import { withAnalytics } from "../src/analytics/index";
import { rateLimit } from "../src/core/limiter";
import { tapDecisions } from "../src/observability/tap";
import { MemoryStore } from "../src/stores/memory";

const RUNS = 8;
const ITERS = 1_000_000;
const DEFAULT_MAX_RATIO = 12;

/** Time `fn` for `iters` iterations after a warmup pass; returns ns/op. */
function timeOne(fn: () => unknown, iters: number): number {
  for (let i = 0; i < Math.min(iters, 100_000); i++) fn(); // warmup / JIT
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  return Number(process.hrtime.bigint() - t0) / iters;
}

/** Best-of-N timing — the min is more stable than the mean under noisy CPU scheduling. */
function bestOf(fn: () => unknown, iters = ITERS, runs = RUNS): number {
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < runs; r++) best = Math.min(best, timeOne(fn, iters));
  return best;
}

/** A never-denying gcra limiter over a fresh in-process store (so checkSync is the pure hot path). */
function freshLimiter() {
  return rateLimit({
    strategy: gcra({ limit: 1_000_000_000, periodMs: 60_000 }),
    store: new MemoryStore({ sweepIntervalMs: 0 }),
  });
}

interface Row {
  label: string;
  nsPerOp: number;
  ratio: number;
}

export function measure(): { rows: Row[]; bareNsPerOp: number } {
  const bare = freshLimiter();
  const analytics = withAnalytics(freshLimiter());
  const tapped = tapDecisions(withAnalytics(freshLimiter()), () => {});

  const bareNsPerOp = bestOf(() => bare.checkSync("k"));
  const rows: Row[] = [
    { label: "bare checkSync", nsPerOp: bareNsPerOp, ratio: 1 },
    {
      label: "+ withAnalytics",
      nsPerOp: bestOf(() => analytics.checkSync("k")),
      ratio: 0,
    },
    {
      label: "+ withAnalytics + tapDecisions",
      nsPerOp: bestOf(() => tapped.checkSync("k")),
      ratio: 0,
    },
  ];
  for (const row of rows) row.ratio = row.nsPerOp / bareNsPerOp;
  return { rows, bareNsPerOp };
}

export function main(): number {
  const maxRatioEnv = process.env.LENS_TAP_MAX_RATIO;
  const maxRatio = maxRatioEnv ? Number(maxRatioEnv) : DEFAULT_MAX_RATIO;
  const limit = Number.isFinite(maxRatio) && maxRatio > 1 ? maxRatio : DEFAULT_MAX_RATIO;

  console.log(
    `bench:lens — node ${process.version}, ${RUNS} runs × ${ITERS.toLocaleString()} iters, ` +
      `max ratio ${limit.toFixed(1)}× (tapped ÷ bare; same-process, machine-independent)`,
  );
  const { rows } = measure();
  for (const row of rows) {
    console.log(
      `  ${row.label.padEnd(32)} ${row.nsPerOp.toFixed(1).padStart(7)} ns/op  ×${row.ratio.toFixed(2)}`,
    );
  }

  const full = rows[rows.length - 1];
  if (full === undefined) {
    console.error("bench:lens: no rows measured");
    return 2;
  }
  if (full.ratio > limit) {
    console.error(
      `\n✗ the fully-tapped control path is ${full.ratio.toFixed(2)}× a bare checkSync — above the ${limit.toFixed(1)}× ceiling. A tap regressed the hot path (megamorphism / an allocation per decision?). Investigate before release.`,
    );
    return 1;
  }
  console.log(
    `\n✓ tapped control path is ${full.ratio.toFixed(2)}× bare (≤ ${limit.toFixed(1)}×) — the always-on Lens taps stay cheap.`,
  );
  return 0;
}

// Run-as-script entry: only fire when this file is the program, not when imported by a test.
const invokedAsScript =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);
if (invokedAsScript) {
  process.exit(main());
}
