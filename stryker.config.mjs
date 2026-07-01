// Stryker mutation testing — measures whether the test suite actually KILLS bugs, not merely that it
// passes. Scoped to the core decision/grant arithmetic (the math), where a surviving mutant is a real gap
// in the suite's bug-catching power. I/O, adapters, stores, orchestration, and telemetry are out of scope:
// their correctness is covered by conformance + live-store e2e, not by unit-level arithmetic mutation.
//
// Runner: vitest (the project executes TS directly through it, so no separate build step). Run the scoped
// sweep locally with `npm run mutation`. CI runs it nightly (.github/workflows/mutation.yml), never on the
// PR critical path — a full mutation sweep is far too slow to gate every push.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  vitest: { configFile: "vitest.config.ts" },
  // The math only. Phase 1 = the atomic strategies + the streaming weighted-fair-escrow kernel. The
  // admission layer (fluid-LP solver, unified dual-axis combinator, distributed-budget) is a deliberate
  // Phase-2 expansion: those files are large and their solver tests are slower, so they earn their own
  // sweep once Phase 1 is green and thresholded.
  mutate: [
    "src/algorithms/gcra.ts",
    "src/algorithms/fixed-window.ts",
    "src/algorithms/token-bucket.ts",
    "src/algorithms/sliding-window.ts",
    "src/algorithms/sliding-window-log.ts",
    "src/algorithms/quota.ts",
    "src/algorithms/calendar.ts",
    "src/algorithms/leaky-bucket.ts",
    "src/twotier/weighted-fair-escrow.ts",
  ],
  reporters: ["html", "clear-text", "progress"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  // Phase-1 aggregate measured at ~66% — the suite PASSES but kills only ~2/3 of injected decision-path
  // mutants (the survivor backlog + priority order live in research/hardening/MUTATION-BACKLOG.md). `break`
  // is a REGRESSION floor set a few points under the measured score: the nightly fails only if the suite's
  // killing power DROPS, it never demands improvement here. Raise it as the backlog is worked down. high/low
  // only colour the report.
  thresholds: { high: 85, low: 60, break: 63 },
  concurrency: 4,
  timeoutMS: 20000,
  incremental: true,
  incrementalFile: "reports/mutation/stryker-incremental.json",
};
