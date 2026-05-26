# GALE Pillar 3 — learning-augmented lease sizing (algorithm spec)

*Design record for prediction-augmented sizing. Validated empirically in
`test/gale/predictive-sizer.test.ts`; thresholds calibrated offline.*

## Goal

Given an external **prediction** of a node's upcoming demand (an EWMA forecaster, an ML model, a
schedule — possibly wrong), do better than the prediction-free learner *when the prediction is
good*, without doing worse than it *when the prediction is bad* — and never let any prediction,
however adversarial, compromise the hard safety cap.

This is the "algorithms with predictions" **consistency / robustness** frame (Lykouris–Vassilvitskii
ICML'18; Purohit–Svitkina–Kumar NeurIPS'18), applied — for the first time, per our surveys — to
distributed-rate-limit leasing, and crucially **with a hard safety guarantee** layered under it.

## Construction — Hedge over two experts

Each window, two experts each propose a lease size:
- **follow**: the EOQ size for the *predicted* demand, `b_follow = sqrt(2c·D̂/h)`.
- **robust**: the Pillar-2 AdaGrad learner's size, `b_robust` (no-regret, ignores predictions).

A **Hedge / exponentiated-weights** meta-learner keeps weights `w ∝ exp(−η · cumulative-expert-loss)`
and we play the **weighted-average size** `b = w_follow·b_follow + w_robust·b_robust`. Both experts'
exact per-window losses are observable (full information, since demand `D` is revealed), so Hedge is
clean and deterministic.

## Guarantees

- **Consistency.** Hedge's regret to the best expert is `O(√T)`, so the meta-learner's cost is within
  `O(√T)` of the *better* of {follow, robust}. When predictions are accurate, `follow` plays the
  per-window EOQ optimum, so cost → the offline (clairvoyant) optimum. *Measured: perfect predictions
  give cost/clairvoyant = 1.000; 10%-noisy predictions = 1.001.*
- **Robustness.** When predictions are adversarial, `follow` accrues high loss, Hedge shifts weight to
  `robust`, and cost stays within `O(√T)` of the no-regret learner — never the blow-up of blindly
  obeying the oracle. *Measured: adversarial predictions give cost/robust-only = 1.000, vs. blindly
  following the oracle which is far worse.*
- **Why the average size is sound, not just a sampled expert.** The per-window cost `f` is convex, so
  by Jensen `f(w·b_follow + (1−w)·b_robust) ≤ w·f(b_follow) + (1−w)·f(b_robust)` — the blended size's
  loss is at most the Hedge-weighted average of the experts' losses, to which the regret bound
  applies. So we get a *deterministic* algorithm with the same guarantee (no randomized expert pick).
- **Safety is unconditional.** The emitted size is just a number; Pillar 1 (window-coupled escrow)
  caps per-window global admissions at `L` for *any* sizes. Therefore **no prediction — however
  adversarial — can breach the cap.** *Measured: with every node fed a wrong constant prediction,
  per-window admitted ≤ L on every window.* This is the property no prior predictions-for-systems
  result pairs with distributed leasing.

## Notes / caveats
- `η` (Hedge rate) trades adaptation speed vs. stability; `0.01` is robust across our traces.
- Predictions feed only the *requested* size — never the L2 accounting — which is exactly why safety
  is decoupled from prediction quality.
- The cost model is the EOQ cost `c·D/b + h·b/2` (see `research/gale/PILLAR2-lease-sizing.md`), used
  identically by the learner, the experts, and the clairvoyant baseline (no objective/metric mismatch).
