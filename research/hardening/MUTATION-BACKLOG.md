# Mutation-testing backlog — core decision math

Stryker (`npm run mutation`, config in `stryker.config.mjs`, nightly `.github/workflows/mutation.yml`)
measures whether the test suite *kills* injected bugs in the core decision arithmetic — not merely that
it passes. This file records the sweeps and the priority order for closing the gap. It is a test-quality
backlog, not a bug list: a surviving mutant means the suite does not pin that behaviour, not that the
shipped code is wrong.

## Aggregate: 77.5% (was 65.4% at the first sweep)

The first full sweep (2026-06-30) scored **65.4%** — the suite passed but killed only ~2/3 of injected
decision-path mutants. A survivor campaign on the three weakest files then lifted the aggregate to
**77.5%** (1077 killed / 261 survived / 54 no-coverage / 8 timeout; ~24 min for the full 9-file sweep).
Survivors remain predominantly `ConditionalExpression` / `EqualityOperator` / `ArithmeticOperator`
boundary flips, plus the no-coverage paths.

### Per-file score (worst first = remaining priority)

| File | Score | Survived | No-cov | Notes |
|------|------:|---------:|-------:|-------|
| `algorithms/token-bucket.ts`       | 61.7% | 33 | 16 | **Next target.** Fractional refill + capacity boundaries; 16 no-cov paths. |
| `algorithms/quota.ts`              | 65.5% | 46 | 15 | Calendar-reset + civil-date branches. |
| `algorithms/gcra.ts`               | 71.8% | 22 |  9 | 169ns hot path; TAT boundary emission. |
| `algorithms/fixed-window.ts`       | 74.8% | 22 |  3 | Epoch-window edges. |
| `algorithms/leaky-bucket.ts`       | 76.2% | 13 |  7 | ✅ campaign (was 52.4%); residue = equivalents + Redis-only Lua path. |
| `twotier/weighted-fair-escrow.ts`  | 79.0% | 46 |  1 | Borrow/guarantee edges. |
| `algorithms/sliding-window.ts`     | 83.5% | 46 |  0 | ✅ campaign (was 52.5%); residue = unreachable clamps + boundary-equivalents. |
| `algorithms/sliding-window-log.ts` | 84.6% | 28 |  1 | ✅ campaign (was 53.7%). |
| `algorithms/calendar.ts`           | 93.8% |  5 |  2 | ✅ offset + month-split tests (was 89%). |

## Closed so far

- **calendar 89% → 94%**: a non-UTC-offset day/week boundary test + an independent `civilFromDays`-vs-`Date` month-field test.
- **leaky-bucket 52% → 76%** (91% with the gated Redis dual-path conformance): 13 tests pinning the async pacing/reject/clamp path, validation names, default-store construction, and the QueueFullError shape. Residual proven equivalent (dead defensive clamps, black-box default-store clock) or gated-conformance-only.
- **sliding-window 52% → 83%**: 21 tests over peek/forecast/decode + the retry-branch arithmetic. No product bug (retry formulas continuous at the switch point). Residual ~46 = unreachable clamps + boundary-equivalents.
- **sliding-window-log 54% → 85%**: recovered + type-fixed peek/forecast/readState tests (independent brute-force oracles).

## How to work it down

Per file, read the survivor list in `reports/mutation/index.html` (or the `[Survived]` lines in a
`--mutate <file>` run, ~1–5 min per file), then add the **narrowest** test that pins each surviving
boundary. Prefer independent oracles over reference math that mirrors the implementation. Re-run
`npx stryker run --mutate "<file>"` to confirm, and raise `thresholds.break` as the aggregate climbs
(currently 75, a regression floor under the measured 77.5%). **Next targets: token-bucket (62%),
quota (66%).**

Note: the store-less nightly score UNDERSTATES real coverage — some mutants are only killed by the
Redis Lua-path conformance tests (gated off without `THROTTLEKIT_TEST_REDIS`); e.g. leaky-bucket is
76% store-less but 92% with Redis.

## Out of scope (Phase 2)

The admission layer (`admission/fluid-lp.ts` LP solver, `admission/unified.ts` dual-axis combinator,
`admission/distributed-budget.ts`) is deliberately excluded from the current `mutate` glob — larger
files with slower solver tests. Add them once the algorithms + weighted-fair-escrow are worked down.
