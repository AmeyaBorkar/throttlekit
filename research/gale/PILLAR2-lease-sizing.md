# GALE Pillar 2 — adaptive lease sizing as online EOQ (algorithm spec)

*Design decision record for the per-node lease-sizing learner. Written before coding (the
implementation and its empirical regret/safety tests are Task 3). Bibliographic details marked
**[verify]** are to be confirmed against primary sources in the write-up phase; web validation was
unavailable at authoring time.*

## 1. What is being decided, and why a fixed `B` is wrong

Pillar 1 (window-coupled escrow, machine-checked) makes global overshoot **= L, independent of N**,
*for any lease sizes the nodes choose*. So lease size no longer affects **safety** — it now governs
only **efficiency**: how many L2 round trips a node makes, and how much budget it strands.

A node serving a key picks a lease size `b` (tokens fetched per refill, with `lowWater = 0` →
lease-on-demand). For a window in which this node sees demand `D` (its own arrivals):

- **Coordination cost.** It makes about `D / b` leases, each one L2 round trip of cost `c`.
- **Stranding cost.** Window-coupled credits expire at the boundary, so the last partial lease
  leaves up to `b − 1` (≈ `b/2` in expectation) credits unused — global budget no other node could
  spend this window. Charge this at `h` per stranded credit. (`h` is the *price of stranding*: the
  utilization axis of the trilemma. With `h = 0` the optimum is `b = ∞`, i.e. hoard everything;
  `h > 0` is what couples coordination to utilization.)

Per-window cost, continuous surrogate (convex in `b > 0`):

```
f_D(b) = c · D / b   +   h · b / 2
```

Any *fixed* `b` is wrong because the minimizer depends on `D`, which is unknown, **skewed across
nodes**, and **non-stationary**.

## 2. The stationary optimum is the EOQ formula

Minimizing `f_D`: `f_D'(b) = −cD/b² + h/2 = 0  ⇒  b* = sqrt(2 c D / h)`.

This is exactly the **Economic Order Quantity** (Harris–Wilson) with order cost `c`, holding cost
`h`, demand `D`. The bridge "distributed-rate-limit lease sizing = EOQ / newsvendor reorder
quantity" is, per our three surveys, **not previously drawn** — and EOQ alone is insufficient
because `D` is unknown and adversarial, which is what motivates the online treatment.

## 3. Online formulation — full-information OCO

Rounds = L2 windows `t = 1..T`. At the start of window `t` the node commits `b_t` (using only past
windows); during the window it observes its arrivals `D_t`; it incurs `f_{D_t}(b_t)`; then updates.

Crucially this is **full-information** online convex optimization, *not* a bandit: the node observes
`D_t` directly (its own arrival count), so it can compute the whole loss function `f_{D_t}(·)` and its
gradient — not merely the realized cost of the `b_t` it played. That is what unlocks gradient methods
with the strong (non-bandit) regret rates.

## 4. The algorithm — projected OGD in log-space

We optimize in `x = ln b` (multiplicative quantity, scale-free updates, better-conditioned gradient).
`g(x) = f_{D_t}(e^x)` is convex in `x` (sum of convex exponentials `cD e^{-x} + (h/2) e^{x}`), with

```
g'(x) = −c·D_t·e^{-x} + (h/2)·e^{x}  =  −c·D_t/b + (h/2)·b      (b = e^x)
```

```
LeaseSizer (per node, per key):
  state: x ← ln(b_init)            # b_init = sqrt(2 c D̂₀ / h) from a warm-up estimate, or b_min
  params: c, h, [b_min, b_max] (b_min ≥ 1), step schedule η_t
  on window-close(D_t):            # D_t = arrivals this node saw this window
    grad ← −c·D_t/b + (h/2)·b      # b = e^x  (current size)
    x    ← clamp( x − η_t · grad , ln b_min , ln b_max )
  size() → b = round(e^x), clamped to [b_min, b_max], and at least the triggering request's cost
```

`η_t = η₀ / sqrt(t)` (anytime) or `η = Dm/(G·sqrt(T))` for a fixed horizon, where `Dm = ln b_max −
ln b_min` and `G = max|g'|` over the domain.

**The implementation uses the AdaGrad step** (`x ← clamp(x − (η₀/√(ε + Σⱼ gⱼ²))·g)`), which is
scale-free — it self-tunes to the observed gradient magnitudes, so no manual learning-rate tuning is
needed — and retains the same `O(√T)` regret (Duchi–Hazan–Singer 2011 **[verify]**). This matters
because `g'(x) = −cD/b + (h/2)b` varies by orders of magnitude across the domain.

## 5. Guarantees

- **Static regret (PROVEN, textbook OGD).** Against the best *fixed* lease size in hindsight,
  `Regret_T = Σ_t f_{D_t}(b_t) − min_b Σ_t f_{D_t}(b) ≤ Dm·G·sqrt(T) = O(sqrt T)`. With demand
  bounded `D_t ∈ [0, D_max]` and `b ∈ [b_min, b_max]`, `G ≤ c·D_max/b_min + (h/2)·b_max` is finite.
  *(Zinkevich 2003 [verify]; Hazan, OCO monograph [verify].)*
- **Dynamic regret (PROVEN, textbook).** Against a *drifting* comparator `b*_t`, OGD attains
  `O(sqrt(T(1 + P_T)))` where `P_T = Σ_t |x*_{t+1} − x*_t|` is the comparator path length; with a
  variation budget on demand this is sublinear, so the learner *tracks* non-stationary demand.
  *(Zinkevich 2003 dynamic bound; Zhang et al. NeurIPS 2018 adaptive/dynamic regret [verify].)*
- **Safety is decoupled from learning (the key composition).** By Pillar 1, per-window global
  admissions ≤ L for **any** sequence `{b_t}`. So the regret result governs *only* coordination /
  stranding; **no choice or misbehaviour of the learner can violate the cap.** This is the property
  the OCO-with-constraints literature (e.g. Yu–Neely: O(√T) regret with O(1) *long-run* violation)
  does not give — there the constraint is satisfied only cumulatively. Here it is a hard per-window
  bound enforced structurally by the escrow store, independent of the learner.

## 6. Why OGD — the decision, justified against alternatives

| Candidate | Verdict |
|---|---|
| **Projected log-space OGD on `f_D`** (chosen) | Loss is 1-D convex with bounded gradient on `[b_min,b_max]`, and feedback is full-information → OGD is the canonical, tightest fit: `O(√T)` static / `O(√(T(1+P_T)))` dynamic, `O(1)` state and per-update time, and it provably *converges to the EOQ optimum* under stationary demand (interpretable). |
| EWMA plug-in `b = sqrt(2c·EWMA(D)/h)` | The **baseline we beat**, and what AdapTBF (2026) effectively does ("next demand ≈ current"). Good on smooth demand, **no regret guarantee**, lags/overshoots on drift and is exploitable by adversarial demand. We implement it as a comparator and as the warm-start. |
| Hedge / MW over a discrete grid of sizes | Robust and also full-information here (we can score every grid size against `D_t`), but `O(√(T log K))` (grid-dependent) and ignores convexity. Strictly dominated by OGD for this loss; kept as a fallback note. |
| Bandit (EXP3 / bandit-convex) | Unnecessary and weaker (`Õ(T^{2/3})`-ish): we are *not* in the bandit setting because `D_t` is observed. Using a bandit would throw away information. Rejected. |

## 7. Assumptions and honest caveats

- **Surrogate vs. integer cost.** We optimize the smooth `f_D`; the realized within-window cost is
  `c·ceil(D/b) + h·(b·ceil(D/b) − D)`. The surrogate matches it up to an `O(1)` per-window rounding
  gap; **tests assert regret on the true integer cost**, not just the surrogate.
- **Demand observability.** `D_t` = arrivals the node saw (known regardless of allow/deny). Global
  denials (L2 exhausted) are a safety event, accounted separately, not part of `D_t`.
- **Per-key vs. aggregate.** A node runs one sizer per hot key it serves; cold keys fall back to
  `b = max(1, cost)` (lease-on-demand, no learning) to avoid per-key learner state blowup.
- **Choice of `h`.** `h` is an operator/protocol knob trading coordination vs. utilization. Sweeping
  `h` traces the **Pareto frontier** of the trilemma — the same frontier the Pillar-1 / capstone
  results bound. This is how Pillar 2 plugs into the trilemma story.

## 8. What Task 3 will verify empirically

1. **Sublinear regret**: on stationary, drifting, and adversarial demand traces, cumulative
   `cost(OGD) − cost(best-fixed-b-in-hindsight)` grows like `√T` (assert `regret_T / sqrt(T)`
   bounded, and `regret_T / T → 0`), and OGD beats the EWMA plug-in on the adversarial trace.
2. **Tracking**: under drift, `b_t` follows `sqrt(2c·D_t/h)`.
3. **Safety under learning**: wired to the Pillar-1 mechanism, per-window admitted ≤ L for *every*
   trace and *every* `{b_t}` the learner emits.

## References (to verify in write-up)
- F. W. Harris (1913) / R. H. Wilson — Economic Order Quantity. **[verify]**
- M. Zinkevich, "Online Convex Programming and Generalized Infinitesimal Gradient Ascent," ICML 2003 — OGD static & dynamic (path-length) regret. **[verify]**
- E. Hazan, "Introduction to Online Convex Optimization" (monograph) — OGD regret. **[verify]**
- L. Zhang, S. Lu, Z.-H. Zhou, "Adaptive Online Learning in Dynamic Environments," NeurIPS 2018 — dynamic regret. **[verify]**
- W. T. Huh & P. Rusmevichientong (2009); Besbes & Muharremoglu (2013) — data-driven / online newsvendor with regret. **[verify]**
- H. Yu & M. J. Neely, JMLR 2020 — the OCO-with-constraints contrast (long-run vs. our hard per-window cap).
