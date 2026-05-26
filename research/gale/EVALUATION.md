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

## Honest scope
- `h` is a knob: under tight contention set it high (leases ≈ demand, protecting utilisation); under
  light load set it low (big leases, minimal coordination). A fully **contention-adaptive `h`** (driven
  by an L2 fullness signal) is a clean refinement, noted not yet built; even a fixed well-chosen `h`
  already Pareto-dominates fixed batching here.
- This is a single-machine discrete-event simulation with seeded demand, not a distributed deployment;
  it measures the algorithmic quantities (round trips, overshoot, utilisation), not wall-clock latency.
  The latency/throughput characteristics of the shipped `lease.windowCoupled` path are covered by the
  library's existing Redis/Postgres benchmarks.
