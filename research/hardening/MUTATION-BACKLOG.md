# Mutation-testing backlog — core decision math

Stryker (`npm run mutation`, config in `stryker.config.mjs`, nightly `.github/workflows/mutation.yml`)
measures whether the test suite *kills* injected bugs in the core decision arithmetic — not merely that
it passes. This file records the first full sweep and the priority order for closing the gap. It is a
test-quality backlog, not a bug list: a surviving mutant means the suite does not pin that behaviour, not
that the shipped code is wrong.

## First full sweep (2026-06-30)

Aggregate **65.4% → 65.8%** after the calendar tests below (909→914 killed, 377→372 survived, 107 no-coverage,
7 timeout; ~24 min for the full 9-file sweep). The survivors are **not** noise: 275 of 377 (73%) are
`ConditionalExpression` (112) / `EqualityOperator` (95) / `ArithmeticOperator` (68) — decision-path boundary
flips, the off-by-one / `<` vs `<=` class that matters most for a limiter. Only 32 are string literals.
The 107 no-coverage mutants sit on paths **no** test executes (31 conditional, 19 equality, 17 array).

### Per-file score (worst first = priority order)

| File | Score | Survived | No-cov | Notes |
|------|------:|---------:|-------:|-------|
| `algorithms/sliding-window.ts`     | 52.5% | 106 | 26 | Largest gap; bucket-ring decay + window filtering under-pinned. |
| `algorithms/leaky-bucket.ts`       | 52.4% |  25 | 15 | Shaper departure recurrence + queue logic; 15 no-cov paths. |
| `algorithms/sliding-window-log.ts` | 53.7% |  68 | 19 | Exact-log append/filter boundaries. |
| `algorithms/token-bucket.ts`       | 61.7% |  33 | 16 | Fractional refill + capacity boundaries. |
| `algorithms/quota.ts`              | 65.5% |  45 | 16 | Calendar-reset + civil-date branches. |
| `algorithms/gcra.ts`               | 71.8% |  22 |  9 | 169ns hot path; TAT boundary emission. |
| `algorithms/fixed-window.ts`       | 74.8% |  22 |  3 | Epoch-window edges. |
| `twotier/weighted-fair-escrow.ts`  | 79.0% |  46 |  1 | Best of the big files; borrow/guarantee edges. |
| `algorithms/calendar.ts`           | ~94%  |   5 |  2 | Was 89% / 10 survived — see below. |

## Closed so far

- **`calendar.ts` (10 → 5 survived):** the fixed-UTC-offset path was exercised only for `calendar-month`,
  so the `- offsetMs` sign flip on `calendar-day` / `calendar-week` was unobservable (every test used
  offset 0), and the `mp < 10` month split survived because the round-trip test is self-consistent under
  it. Added a non-UTC-offset day/week boundary test and an independent `civilFromDays`-vs-`Date` month-field
  test (`test/algorithms/calendar.test.ts`). Killed 5 mutants.

## How to work it down

Per file, read the survivor list in `reports/mutation/index.html` (or the `[Survived]` lines in a
`--mutate <file>` run — ~36s for one small file), then add the **narrowest** test that pins each surviving
boundary. Prefer independent oracles over reference math that mirrors the implementation (a mirror kills the
mutant but re-encodes the same possible bug). Re-run `npx stryker run --mutate "<file>"` to confirm, and
raise `thresholds.break` in `stryker.config.mjs` as the aggregate climbs. The `break` floor (currently 63)
only guards against regression; it never forces this work.

## Out of scope (Phase 2)

The admission layer (`admission/fluid-lp.ts` LP solver, `admission/unified.ts` dual-axis combinator,
`admission/distributed-budget.ts`) is deliberately excluded from the current `mutate` glob — larger files
with slower solver tests. Add them once the algorithms + weighted-fair-escrow are worked down.
