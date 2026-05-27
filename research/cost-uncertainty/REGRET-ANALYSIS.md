# TALE Layers 2 & 3 — regret and consistency/robustness, instantiated

*Scope & honesty (read first).* The two results below are **textbook online-learning machinery applied
to the token-reservation loss**, not new theory. Layer 2 is Zinkevich's projected online gradient
descent (OGD) on the newsvendor / pinball loss; Layer 3 is the Freund–Schapire **Hedge**
predictions-with-safety construction (consistency/robustness in the Lykouris–Vassilvitskii sense).
We write them out here with the **explicit constants and assumptions for our loss** so the proposal's
`O(√T)` and "consistency/robustness" claims are precise and auditable. The **load-bearing novelty of
TALE is Layer 1** (the streaming-meter overshoot bound, `≤ g−1`, independent of `max_tokens`) and the
fact that **safety is decoupled from the learning** — the meter enforces the budget for *any*
reservation, so robustness here is to an *unbounded, adversarial* predictor with a *hard* safety
guarantee. The regret/consistency results are the supporting cast; they are stated to be correct, not
to be claimed novel. Closest combined prior: An, Li, Moseley & Ravi, *The Nonstationary Newsvendor with
(and without) Predictions* (arXiv 2305.07993). Implementations: `test/cost/learned-reservation.ts`
(L2), `test/cost/predicted-reservation.ts` (L3). Empirical verification: `test/cost/*reservation.test.ts`
and the envelope check added to `learned-reservation.test.ts`.

## 1. Setup — the reservation game

Per request the limiter commits a **reservation** `r ∈ K = [r_min, r_max]` *before* the true cost `c ≥ 0`
(realised output tokens) is known; `c` is revealed when the stream finishes (**full information**). The
per-request cost is the asymmetric **pinball / newsvendor loss**

```
    ℓ(r, c) = h·(r − c)₊  +  p·(c − r)₊ ,     h, p > 0,
```

`h` = hold cost per token reserved-but-idle (over-reserving ⇒ false rejects / starved concurrency), `p`
= overrun cost per token of realised cost beyond the reservation (under-reserving ⇒ the meter aborts an
in-flight stream). Write `D = r_max − r_min` (domain diameter) and `G = max(h, p)`.

**Assumptions.**
- **(A1)** Full information: `c_t` is observed after round `t`. The regret bounds need **no**
  distributional assumption on `(c_t)` (an adaptive adversary is allowed); the *quantile*
  interpretation (§2, corollary) additionally assumes the `c_t` are i.i.d. from a fixed `F`.
- **(A2)** `K = [r_min, r_max]` is convex and compact, diameter `D`.
- **(A3)** `ℓ(·, c)` is convex in `r` (piecewise-linear, slopes `+h` and `−p`) with subgradient
  `∂_r ℓ ∈ [−p, +h]`, hence `|∂_r ℓ| ≤ G = max(h, p)` **for every `c`** — note this is independent of the
  magnitude of `c`, so the regret bound holds even for unbounded costs.

The streaming meter (Layer 1) is what enforces the *budget* `L`; the reservation only paces admission.
**Safety is therefore unconditional and orthogonal to everything below** (Layer-1 result): for any
reservation whatsoever — learned, maximal, zero, or adversarial — global overshoot is `≤ g − 1`
(`0` at per-token granularity `g = 1`). Nothing in §2–§3 can breach `L`.

## 2. Layer 2 — projected OGD on the pinball loss

**Algorithm.** Carry a continuous reservation `r_t`; play it, observe `c_t`, take a projected
subgradient step

```
    g_t = +h  if r_t > c_t  else  −p ;        r_{t+1} = Π_K( r_t − η_t · g_t ) ,   η_t = D / (G·√t).
```

(`Π_K` = clamp to `[r_min, r_max]`. `η_0 = D/G` is the Zinkevich-optimal scale; the implementation uses
exactly this with the canonical `η_t = η_0/√t`.)

**Theorem 1 (sublinear static regret).** Under (A1)–(A3), against the best *fixed* reservation in
hindsight,

```
    R_T  =  Σ_{t=1}^T ℓ(r_t, c_t)  −  min_{r ∈ K} Σ_{t=1}^T ℓ(r, c_t)   ≤   (3/2)·D·G·√T   =   O(√T),
```

so the per-round average regret `R_T / T = O(1/√T) → 0` (the no-regret property).

*Proof (instantiation of Zinkevich '03 / Hazan, OCO Thm 3.1).* `ℓ(·,c_t)` is convex (A3), so for the
hindsight optimum `r*`, convexity gives `ℓ(r_t,c_t) − ℓ(r*,c_t) ≤ g_t·(r_t − r*)`. Projection is
non-expansive, so `(r_{t+1}−r*)² ≤ (r_t − r* − η_t g_t)² = (r_t−r*)² − 2η_t g_t(r_t−r*) + η_t² g_t²`.
Rearranging, `g_t(r_t−r*) ≤ [(r_t−r*)² − (r_{t+1}−r*)²]/(2η_t) + (η_t/2)G²` (using `|g_t| ≤ G`). Sum
over `t`, telescope the first part with `η_t = D/(G√t)` (and `(r_t−r*)² ≤ D²`), and use `Σ_{t≤T} 1/√t ≤
2√T`; the two pieces combine to `(3/2)·G·D·√T`. ∎

**Corollary (the comparator is the critical-fractile quantile).** If additionally the `c_t` are i.i.d.
`∼ F`, then `d/dr E[ℓ(r,c)] = h·F(r) − p·(1 − F(r))`, which vanishes at `F(r*) = p/(h+p) =: τ`. So the
best fixed reservation is the **`τ`-quantile** `r* = F^{-1}(τ)` — the textbook newsvendor critical
ratio — and Theorem 1 says OGD's average loss approaches that of the best `τ`-quantile at rate
`O(1/√T)`. (The identity "best fixed reservation in hindsight = empirical `τ`-quantile" is
machine-checked in `learned-reservation.test.ts`.)

**Remark (integer rounding — an honest accounting).** Admission needs an *integer* reservation, so the
*played* value is `round(r_t)`; the OGD **update is on the continuous `r_t`** (no rounding feeds back),
so Theorem 1 governs the learning trajectory exactly. Rounding perturbs the played reservation by
`≤ 1/2`, and since `ℓ(·,c)` is `G`-Lipschitz, it perturbs the *played* loss by `≤ G/2` per round —
a worst-case additive `≤ (G/2)·T` term on top of `R_T`. On a smooth cost distribution these
half-token errors are mean-cancelling, so the realised residual is small (the measured asymptotic
per-round regret `≈ 2.77` sits at the discretisation scale `≈ G/2 = 2`, not growing with `T`). The clean
`O(√T)` is a statement about the continuous trajectory; the discretisation residual is `O(1)` per round
in practice and **never affects safety** (Layer 1). For a strictly `O(√T)` *played* bound, carry the
fractional reservation (the code already does) and let the meter handle the integer boundary.

## 3. Layer 3 — Hedge over {follow-prediction, robust-quantile}

**Algorithm.** Two experts: `E_follow` plays the (clamped) predicted output length `ĉ_t`; `E_robust` is
the Layer-2 OGD learner. A Hedge meta-learner keeps weights `w_t ∝ exp(−η · cumulative-expert-loss)`,
and the limiter plays the **convex blend** `r_t = w_{f,t}·ĉ_t + w_{r,t}·r^{robust}_t` (then rounds).

**Theorem 2 (best-of-both / consistency–robustness).** Let per-round losses be bounded by
`ρ = max_{r∈K, c∈[0,m]} ℓ(r,c) ≤ m·max(h,p)` (uses the admission clamp `c ≤ m = max_tokens`, A4). With
`N = 2` experts and the tuned rate `η = √(8 ln 2 / (ρ²T))`,

```
    Σ_t ℓ(r_t, c_t)   ≤   min( L_follow , L_robust )  +  ρ·√( (T·ln 2) / 2 ) ,
```

where `L_follow = Σ_t ℓ(ĉ_t, c_t)` and `L_robust = Σ_t ℓ(r^robust_t, c_t) ≤ (Layer-2 optimum) +
(3/2)DG√T`.

*Proof.* Standard Hedge (Freund–Schapire '97; Cesa-Bianchi & Lugosi '06, Thm 2.2): the weighted-average
**expected** loss obeys `Σ_t ⟨w_t, ℓ_t⟩ − min_i L_{i,T} ≤ (ln N)/η + (η/8)ρ²T`, minimised at the stated
`η` to `ρ√((T ln N)/2)`. Because `ℓ(·,c)` is convex (A3), **Jensen** gives `ℓ(Σ_i w_{i,t} r_{i,t}, c_t)
≤ Σ_i w_{i,t} ℓ(r_{i,t}, c_t)` — the *played* blend loss is at most the expected loss — so the blend
inherits the Hedge bound against the best single expert. With `N = 2`, `ln N = ln 2`. ∎

**Corollaries.**
- **Consistency.** Perfect advice `ĉ_t = c_t` ⇒ `L_follow = 0` ⇒ `Σ_t ℓ(r_t,c_t) ≤ ρ√((T ln2)/2) =
  O(√T)`: the blend approaches the **clairvoyant optimum**. (Measured: perfect advice ⇒ `≈ 0.0003×`
  the robust cost.)
- **Robustness.** For *any* advice, `Σ_t ℓ(r_t,c_t) ≤ L_robust + O(√T)`: the prediction can never make
  you more than `O(√T)` worse than the no-prediction Layer-2 learner. (Measured: adversarial
  anti-correlated advice ⇒ `≈ 1.00×` the robust cost, vs `2.14×` for blindly obeying it.)
- **Safety (unconditional, the TALE point).** Independent of advice quality *and* of the learning, the
  Layer-1 meter caps overshoot at `≤ g−1`. So robustness is to an **unbounded adversarial predictor**
  with a **hard** budget guarantee — unlike the soft/competitive guarantees of the
  predictions-with-safety literature, here safety is a structural cap *decoupled* from the predictor.

**Remark (the learning rate — an honest accounting).** The `O(√T)` rate needs an annealed or
horizon-tuned `η` (the stated `η = Θ(1/√T)`, or the anytime `η_t = √(8 ln 2 / t)/ρ`). The
implementation defaults to a **fixed** `η` (`0.01`): with fixed `η` the Hedge bound is
`(ln 2)/η + (η/8)ρ²T`, whose second term is linear in `T`, so the *worst-case rate* is not `√T`.
However the **consistency/robustness *dichotomy* holds for any `η > 0`** — Hedge always shifts weight
toward the lower-cumulative-loss expert, so the blend tracks whichever expert is better — which is why
the *measured* behaviour (`0.0003×` consistent, `1.00×` robust) is far better than the loose worst-case
envelope on the near-stationary token-cost stream. Anneal `η` for the worst-case `√T`; keep it fixed
for stability under near-stationary costs. Either way, safety is untouched.

## 4. What is verified

- **L2 newsvendor identity** (best fixed reservation = empirical `τ`-quantile) and **sublinear regret**
  (avg regret `8.49 → 2.77` as `T: 100 → 6400`, strictly decreasing): `learned-reservation.test.ts`.
- **L2 explicit envelope** `R_T(continuous) ≤ (3/2)·D·G·√T` at `T ∈ {100,400,1600,6400}`, plus the
  discretisation residual `R_T(rounded) − R_T(continuous) ≤ (G/2)·T`: added to
  `learned-reservation.test.ts`.
- **L3 consistency** (perfect ⇒ `≈0.0003×`; good rank-predictor cuts cost `62%`), **robustness**
  (adversarial ⇒ `≈1.00×`, weight → robust), and **unconditional safety** (overshoot `0` at `g=1`,
  `≤ g−1` chunked, under good *and* adversarial advice): `predicted-reservation.test.ts`.

## 5. Positioning & citations

- **OGD / online convex optimisation:** Zinkevich, *Online Convex Programming and Generalized
  Infinitesimal Gradient Ascent*, ICML'03; Hazan, *Introduction to Online Convex Optimization* (Thm 3.1).
- **Newsvendor critical fractile:** the textbook critical ratio `τ = p/(h+p)`; data-driven /
  nonstationary newsvendor with predictions — An, Li, Moseley & Ravi, arXiv 2305.07993 (the closest
  combined L2+L3 prior; "matches the best achievable regret had the accuracy of the predictions been
  known").
- **Hedge / experts:** Freund & Schapire, *A Decision-Theoretic Generalization of On-Line Learning*,
  JCSS'97; Cesa-Bianchi & Lugosi, *Prediction, Learning, and Games*, 2006.
- **Predictions-with-safety (consistency/robustness):** Lykouris & Vassilvitskii, ICML'18; Purohit,
  Svitkina & Kumar, NeurIPS'18; best-of-many-worlds online allocation with predictions, arXiv 2402.13530.
- **Output-length rank predictor (why `ĉ` exists):** Fu et al., *Efficient LLM Scheduling by Learning to
  Rank*, NeurIPS'24 (vLLM); the relative *rank* of output lengths is predictable even when the exact
  length is not.

The contribution is the **cost-axis instantiation** of this machinery plus the **unconditional,
predictor-decoupled safety** from the Layer-1 meter — not the regret/consistency bounds, which are the
established results cited above.
