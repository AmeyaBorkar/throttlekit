# GALE evaluation — measured results

*Reproducible (seeded) simulation comparing schemes on the trilemma axes. The engine is
`test/gale/evaluate.ts`; the headline claims are gated in `test/gale/evaluation.test.ts`. Numbers
below are exact for the committed seeds.*

## Metrics
- **C** — coordination: total L2 round trips (lease attempts; for `strict`, one per request).
- **Δ** — overshoot: worst-case per-window admissions above the limit.
- **util** — mean per-window utilisation, `admitted / min(demand, limit)` (1.0 = served all serveable).

## Workload A — skewed overload (the trilemma bites)

`N = 5`, limit `L = 100`, 500 windows; one hot node (~80 req/window) + four cold (~5). Total offered
≈ L, so the budget is contended. (`h` is GALE's strand penalty — the coordination↔utilisation dial;
under contention it is set higher so leases track demand.)

| scheme | C (round trips) | Δ overshoot | util | verdict |
|---|---:|---:|---:|---|
| strict (central per request) | 51 186 | 0 | 1.000 | exact, but **C = #requests** |
| static equal share (L/N) | 0 | 0 | **0.446** | no coordination, but **starves the hot node** |
| leased B=5, legacy carryover | 14 444 | **10** | 1.003 | **overshoots** |
| leased B=10, legacy carryover | 9 669 | **28** | 1.007 | **overshoots more** |
| leased B=20, legacy carryover | 7 310 | **38** | 1.007 | **overshoots most** |
| leased B=5, window-coupled | 17 178 | 0 | 0.955 | good — but needs the right B |
| leased B=10, window-coupled | 17 039 | 0 | 0.864 | wrong B → util drops |
| leased B=20, window-coupled | 33 702 | 0 | 0.446 | wrong B → **util collapses + C spikes** |
| **GALE (window-coupled + adaptive, h=10)** | **12 731** | **0** | **0.962** | **good on all three** |

**Reading.**
- **Every baseline fails an axis:** strict on coordination (a round trip per request), static on
  utilisation (the hot node is capped at its `1/N` share → 0.446), legacy leasing on overshoot
  (10–38 over the limit, worse with bigger batches).
- **Fixed-batch window-coupled is fragile:** zero overshoot, but the right batch must be guessed —
  `B=20` collapses utilisation to 0.446 *and* spikes coordination (stranding exhausts the budget, so
  nodes keep retrying). No single `B` is robust across heterogeneous nodes.
- **GALE Pareto-dominates** the best fixed-batch window-coupled scheme: equal/again-higher utilisation
  (0.962 vs 0.955) at **26% fewer round trips** (12 731 vs 17 178), because it sizes each node's lease
  to its own demand (big for the hot node, small for the cold ones) instead of one-size-fits-all.
- Versus the incumbents GALE keeps `Δ = 0`, runs at **4× less coordination than strict**, and **~2.2×
  the utilisation of static** — the only scheme good on all three axes at once.

## Workload B — overshoot vs fleet size

limit `L = 100`, batch `B = 10`, 200 windows, total demand ≈ 150 split across `N` nodes.

| N | legacy carryover Δ | window-coupled Δ |
|---:|---:|---:|
| 2 | 15 | **0** |
| 4 | 19 | **0** |
| 8 | 24 | **0** |
| 16 | 25 | **0** |

Legacy overshoot grows with the fleet (toward the proven `L + N·(B−1)` envelope); window-coupling
holds it at exactly **0 regardless of N** — the Pillar-1 result, measured.

## Workload C — weighted multi-tenant fairness (Pillar 4)

*Engine `test/gale/fair-escrow.ts`; gated in `test/gale/fair-escrow.test.ts`. Where Workloads A–B
exercise the **total** (overshoot/coordination/utilisation), this one exercises the **split**: who gets
the contended budget.* `N = 4` tenants, limit `L = 70`, 400 windows. One high-priority tenant **H**
(weight 4) is steady ~40/window but **idle every 5th window**; three low-priority flooders (weight 1
each) demand ~100/window. `W = 7`, so H's guaranteed share is 40 and each flooder's is 10.

| split policy | overshoot Δ | utilisation | share violations | norm. spread | verdict |
|---|---:|---:|---:|---:|---|
| static weighted share `⌊wᵢ/W·L⌋` | 0 | **0.876** | 0.000 | 0.00 | fair, **not work-conserving** |
| weight-blind leasing (GALE P1–2) | 0 | 1.000 | **0.211** | **13.50** | work-conserving, **unfair** |
| **WFE (Pillar 4)** | 0 | **1.000** | **0.000** | **1.00** | **good on every axis** |

- **share violations** — fraction of (window, backlogged-tenant) pairs served below their guaranteed
  share. **norm. spread** — worst-case gap in normalised service `aᵢ/wᵢ` among backlogged tenants
  (0 = perfectly fair; the lease quantum bounds it, Theorem T4).
- **Static is fair but strands capacity:** in H's idle windows its 40-credit share cannot be used by
  the flooders → utilisation falls to **0.876**.
- **Weight-blind leasing is work-conserving but ignores priority:** it splits the contended budget
  *equally* (unweighted max-min), so H — entitled to `4/7·L = 40` — is squeezed to ~18 and falls below
  its guaranteed share in **21%** of backlogged windows; the normalised-service spread is **13.5**
  (H gets 18/4 = 4.5 per weight-unit while a flooder gets 18/1 = 18).
- **WFE matches static on fairness (0 violations) and weight-blind on utilisation (1.000), beating each
  on the axis it fails** — at the **same coordination** as weight-blind leasing (28 000 round trips for
  both; the fair split is *free*). Its `Δ` stays 0 (the split never changes the total — Theorem T1) and
  its residual spread is exactly **1.00**, the single-credit DRR quantum (T4).

## Honest scope
- `h` is a knob: under tight contention set it high (leases ≈ demand, protecting utilisation); under
  light load set it low (big leases, minimal coordination). A fully **contention-adaptive `h`** (driven
  by an L2 fullness signal) is a clean refinement, noted not yet built; even a fixed well-chosen `h`
  already Pareto-dominates fixed batching here.
- This is a single-machine discrete-event simulation with seeded demand, not a distributed deployment;
  it measures the algorithmic quantities (round trips, overshoot, utilisation), not wall-clock latency.
  The latency/throughput characteristics of the shipped `lease.windowCoupled` path are covered by the
  library's existing Redis/Postgres benchmarks.
- WFE (Workload C) is **not strategy-proof** — under the share guarantee, FairRide's impossibility
  (NSDI'16) precludes also being strategy-proof and work-conserving; WFE takes the
  sharing-incentive + work-conserving corner. Window-coupling bounds the gain from over-declaring
  demand (inflated credits strand and expire). The simulator computes the split via the water-filling
  fixed point; it does not model an in-window request-reordering adversary. WFE is a research module,
  not yet shipped in `src/twotier`.
