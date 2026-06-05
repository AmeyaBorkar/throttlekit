# 05 · Cost axis & token-budget escrow (TALE)

> Enforcing a budget when a request's true cost is revealed only *after* it runs — the LLM-gateway
> problem. Internally this is **TALE** (*Temporally-Accounted Learned Escrow*) — token-budget escrow. Source: `src/admission/`.

## Purpose

Some budgets can't be priced at admission. An LLM completion's cost is its *output* tokens, known only as
it streams. The two obvious approaches both fail:

- **Reserve `max_tokens` up front** — never overshoots, but sterilizes most of every reservation on a
  heavy-tailed length distribution; utilization collapses as the cap grows.
- **Admit, then count** — fully utilized, but overshoots by up to `concurrency × max_tokens` (LiteLLM was
  measured at 6.6×).

TALE gives reserve-max's safety at admit-then-count's utilization, with an overshoot bound **independent
of `max_tokens`**, via a **reserve → meter → reconcile** escrow pattern — the cost-axis analog of GALE's
window-coupling. The pattern: don't reserve the cap; meter the budget per produced token and stop at the
boundary, so overshoot depends only on the metering granularity, not on the cap.

## Layer 1 — the streaming meter (`tokenBudget`)

Instead of reserving `max_tokens`, the meter **debits actual tokens as they are produced** and stops at
the boundary. The whole rule (`src/admission/index.ts:735`):

```
if (served >= L) return deny;     // stop-at-boundary
served += tokens;                 // count the real, post-hoc cost honestly
return allow(remaining = max(0, L - served));
```

A debit is admitted iff budget remained *before* it (`served < L`); the single debit that crosses `L` is
counted in full, then every later debit in the window is refused so the caller stops generating. This
bounds overshoot by the debit granularity `g`:

```
worst-case overshoot  Δ ≤ (largest single debit) − 1
```

So **per-token debiting (`g = 1`) overshoots by exactly 0** — the meter stops on the token that reaches
`L`. Two properties make this strong:

- **Independent of `max_tokens`** — the meter never reserves a cap; it counts only what's produced, so a
  heavy tail costs nothing and utilization stays ~1.
- **Independent of concurrency** — check-and-increment is one synchronous atomic step, so only the one
  crossing debit can exceed `L`, no matter how many streams meter at once.

This is the genuinely new result in TALE; Layers 2–3 are known machinery instantiated on top.

## Layer 2 — learned reservation (`learnedReservation`)

The meter bounds overshoot for *any* reservation, but admission still needs a reservation `r` committed
*before* the cost is known — it sets the 429 and paces concurrency. Reserve too much and you reject
admissible traffic; too little and the meter aborts in-flight streams (wasted half-finished work). The
per-request loss is the asymmetric **newsvendor / pinball** loss (`src/admission/index.ts:843`):

```
ℓ(r, c) = holdCost · (r − c)₊  +  overrunCost · (c − r)₊
```

whose minimizer is the **critical-fractile** quantile `τ = overrunCost / (holdCost + overrunCost)`.
`learnedReservation` learns it online with projected OGD (Zinkevich): each `observe(cost)` steps by the
pinball subgradient with `step = (D/G)/√t`, descending onto the τ-quantile and attaining `O(√T)` regret
(`R_T ≤ (3/2)·D·G·√T`, with `D` the reservation range and `G = max(holdCost, overrunCost)`).

*Why OGD here (vs AdaGrad on the placement axis, [04](04-two-tier-and-leasing.md)):* the pinball
subgradient is bounded and constant-magnitude (`∈ [−overrun, +hold]`, independent of the realized cost),
exactly where vanilla OGD with `η_t = D/(G√t)` is regret-optimal.

## Layer 3 — predictive reservation (`predictiveReservation`)

Predicting an LLM completion's exact length is infeasible, but its relative *rank* is learnable. Two
experts each request — "follow the prediction" and the robust `learnedReservation` — are arbitrated by a
Hedge meta-learner that plays their convex blend (`src/admission/index.ts:983`). Because the pinball loss
is convex, Jensen gives `loss(blend) ≤ weighted-average expert loss`, so:

- **Consistency** — accurate predictions ⇒ weight shifts to "follow" ⇒ near-clairvoyant cost.
- **Robustness** — adversarial predictions ⇒ weight shifts to "robust" ⇒ the no-regret quantile.

## Distributed token budget (`distributedTokenBudget`)

The fleet-shared form. `debit` runs one **atomic** read-modify-write against a shared counter, applying
the same stop-at-boundary rule (`src/admission/distributed-budget.ts`). Because the check-and-increment is
atomic in the store, only the one crossing debit per window can exceed `L`, no matter how many gateways
meter concurrently:

```
worst-case overshoot  Δ ≤ (largest single debit) − 1     — independent of the gateway count C
```

The Lua form mirrors the JS transform bit-identically, and the **server clock rolls the window from a
single shared key** (like `fixedWindow`), so gateway clock skew can never split one logical window into
two counters. This is explicitly the **`B = 1` instantiation of GALE window-coupled leasing with the token
as the unit** — and the distributed-budget test proves the window-coupled `produced` series is
*byte-identical* to GALE's `simulateWindowCoupled` admissions.

## Design decisions & rationale

- **Reserve → meter → reconcile is the cost-axis window-coupling.** GALE bounds distributed overshoot by
  not pre-committing the max and metering actuals across nodes; the identical move on the cost axis is to
  not reserve `max_tokens` and meter per produced token, so overshoot depends only on `g`, not the cap.
- **The meter (Layer 1), not the learner, holds safety.** The reservation only governs the false-reject ⇄
  abort trade-off; the *meter* caps production at `L` for **any** reservation whatsoever — learned,
  maximal, zero, or adversarial (`src/admission/index.ts:858`). This decouples safety from learning the
  same way GALE Pillar 1 decouples it from lease sizing, and it is exactly what makes the predictions-with-
  safety result strong: robustness holds against an *unbounded adversarial predictor* with a *hard* (not
  competitive) safety guarantee.
- **The newsvendor critical fractile**, because the asymmetric cost of over- vs under-reserving is exactly
  the newsvendor problem and its critical ratio is the loss-minimizing quantile.
- **Distributed token budget reduces to GALE leasing** — a fleet-shared token budget *is* GALE leased mode
  at `B = 1` with the token unit and window-coupled credits, so it inherits the window-coupled, fleet-size-
  independent bound and runs on the same atomic-store machinery that backs `fixedWindow`.

## Caveats

- Per-token debiting gives `Δ = 0`; chunking by `g` tokens to amortize meter calls gives `Δ ≤ g − 1` — a
  deliberate tunable trading meter overhead for a small bounded overshoot.
- `tokenBudget`'s synchronous check-then-increment is atomic only within one process; a fleet needs
  `distributedTokenBudget`, whose bound holds *because* the store makes the debit atomic.
- Layers 2–3 are efficiency, not safety: the learner can pay positive regret on a stationary stream and
  integer rounding adds a bounded per-round residual; neither touches `L`. The reservation primitives are
  pure and deterministic (no clock, no RNG) and **must** be paired with a meter that holds the hard bound —
  a reservation alone guarantees nothing about `L`.

## What proves it

- `test/cost/token-budget.test.ts` — streaming `g = 1` gives overshoot 0 and utilization 1 for *every*
  `max_tokens`; chunked `g = 8` gives `Δ ≤ 7` independent of the cap; reserve-max utilization collapses and
  admit-then-count overshoot grows with the cap — streaming dominates both corners.
- `test/cost/learned-reservation.test.ts` — the critical-fractile identity (best-fixed-in-hindsight = the
  empirical τ-quantile, machine-checked), sublinear regret, the explicit `(3/2)·D·G·√T` envelope, and
  **unconditional safety** (overshoot 0 for *every* reservation policy).
- `test/cost/predicted-reservation.test.ts` — consistency, robustness, and overshoot 0 even when blindly
  following an anti-correlated predictor (the predictions-with-safety result).
- `test/cost/distributed-budget.test.ts` — windowCoupled overshoot 0 for every gateway count C ∈
  {1,…,32}; carryover overshoot grows with C; and the reduction proof — windowCoupled `produced` is
  byte-identical to GALE's `simulateWindowCoupled`.

## Source map

`src/admission/index.ts` (`tokenBudget`, `learnedReservation`, `predictiveReservation`) ·
`src/admission/distributed-budget.ts` (`distributedTokenBudget`) · the shared spine with
[GALE](04-two-tier-and-leasing.md) (`spec/GaleWindowCoupledLeasing.tla`, `docs/FORMAL-MODEL.md`).
