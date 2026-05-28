# Federation baselines — the numbers federation must beat

> Living doc. TK-903 commits the static-partition rows; TK-904 fills in the
> federated rows; TK-910 fills in the real-cluster rows. Edit in place when
> a measurement methodology changes; date-stamp each update.

This file holds the measurements that the federated scheme (TK-904) is
compared against. The static-partition policy is the trivial Δ = 0 baseline
that loses pooling under skew; federation must demonstrably recover that
lost capacity to be worth shipping.

## 1  Skew model

For `K` regions and a skew parameter `s ∈ [0, 1]`:

```
f_hot  = 1/K + s · (1 − 1/K)         (hot region's load fraction)
f_cold = (1 − f_hot) / (K − 1)        (each cold region's load fraction)
```

- `s = 0` → uniform load (every region gets `1/K` of offered traffic)
- `s = 1` → ALL load lands on the hot region

We offer exactly the global budget `L` worth of requests in one window
(`L = 300`, `K = 3`, fixedWindow strategy).

The analytical prediction under static partition (each region's slice is
`L/K = 100`):

```
U(s) = (1/L) · Σ_r min(L · f_r, L/K) = Σ_r min(f_r, 1/K)
```

## 2  Static partition (TK-903)

Measured 2026-05-28 by `test/federation/static-skew.test.ts`. Reproducible:

```sh
npx vitest run test/federation/static-skew.test.ts --reporter=verbose
```

| skew | offered | admitted | U_capacity | U_offered | predicted |
|---:|---:|---:|---:|---:|---:|
| 0.00 | 300 | 300 | 1.000 | 1.000 | 1.000 |
| 0.25 | 300 | 250 | 0.833 | 0.833 | 0.833 |
| 0.50 | 300 | 200 | 0.667 | 0.667 | 0.667 |
| 0.75 | 300 | 150 | 0.500 | 0.500 | 0.500 |
| 1.00 | 300 | 100 | 0.333 | 0.333 | 0.333 |

Observations:
- The measured `U_capacity` matches the closed-form prediction **byte-for-byte**
  across the skew sweep (the assertion in `static-skew.test.ts` enforces this).
- Under max skew (s = 1) static partition collapses to `1/K = 33.3%` utilization —
  the hot region's slice binds while two-thirds of the federation's capacity sits
  idle.
- The degradation is monotone in skew (each step of 0.25 in s costs ~17 points
  of utilization for K = 3).

**This is the capacity federation must recover.** Under TK-904's window-coupled
federated leasing, the same workload should approach `U = 1.0` for all `s` (the
budget pools dynamically, so the hot region draws from the unused cold-region
budget).

### 2.1 Why this is also the Δ = 0 baseline

Static partition trivially achieves Δ = 0 because each region operates
against an INDEPENDENT slice — there is no shared global counter to
over-admit against. The slice is the bound; the bound is independent of
fleet size by construction.

The cost is exactly the table above: when load is non-uniform, slices
unused in cold regions are *not* available to the hot region. Federation
buys us that.

### 2.2 K-scaling

At K = 5 with s = 1, the same model predicts `U_capacity = 1/K = 0.2`.
The `K=5 max-skew` test in `static-skew.test.ts` confirms this measurement:

```
K=5, L=500, all load to one region:
  admitted = 100 = L/K
  U_capacity = 0.200
```

Federation's K-independence means we expect the same headline number
(`U ≈ 1.0`) at K = 5 as at K = 3, with the gap to baseline only widening
as K grows.

## 3  Federated window-coupled leasing (TK-904)

> Filled in when TK-904 ships. Expected pattern: `U_capacity → 1.0` for all
> `s ∈ [0, 1]` at the cost of `Batch − 1` boundary tokens per region per
> window (negligible relative to L for typical deployments).

| skew | offered | admitted | U_capacity | U_offered | Δ_static→fed |
|---:|---:|---:|---:|---:|---:|
| 0.00 | TBD | TBD | TBD | TBD | TBD |
| 0.25 | TBD | TBD | TBD | TBD | TBD |
| 0.50 | TBD | TBD | TBD | TBD | TBD |
| 0.75 | TBD | TBD | TBD | TBD | TBD |
| 1.00 | TBD | TBD | TBD | TBD | TBD |

## 4  Real-cluster (TK-910)

> Filled in when the fly.io / GCP eval (TK-909, TK-910) runs. This is the
> systems-paper number — the static-vs-federated gap measured on actual
> cross-region latency (80–150 ms us-east ↔ eu-west). Expected: federation
> still recovers capacity, modulo the per-window boundary dip equal to
> roughly `(W − R) / W` ≈ 99.83% at W = 60s, R = 0.1s.

## 5  How to reproduce / regenerate

- **Static rows:** `npx vitest run test/federation/static-skew.test.ts
  --reporter=verbose` and paste the table; the verbose reporter prints the
  exact markdown.
- **Federated rows (TK-904):** the analogous skew test will live in
  `test/federation/federated-skew.test.ts` once TK-904 lands; it will use the
  same skew model so the rows are directly comparable.
- **Real-cluster rows (TK-910):** see `research/bigger-bets/federation/eval/`
  (created in TK-909).

All measurement scripts must commit deterministic numbers (no walltime, no
sampling) so re-runs hit the same table.
