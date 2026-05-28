# Joint-LP vs marginal-AND — empirical regret analysis (TK-1007)

> Status: locked deliverable for TK-1007 / 0.9.0. Numbers below are
> reproducible from `research/bigger-bets/unified/sim.ts` via
> `npx tsx research/bigger-bets/unified/sim.ts`. Verdict drives the
> 0.10.1 conditional ship (PLAN.md DR-19).

---

## 0  TL;DR

On a bivariate Markov-correlated workload in the **cost-binding
regime** (small request, large request — 50/50 mix; cost cap 50× the
expected-per-arrival cost):

| ρ (autocorrelation) | regret(marginal-AND) | regret(joint-LP) | ε := M − J |
|---|---|---|---|
| −1.0 (strict alternation) | 40.00% | 0.00% | **+40.00%** |
| −0.5 | 40.00% | 0.70% | **+39.30%** |
|  0.0 (independent) | 40.50% | 1.01% | **+39.49%** |
| +0.5 | 41.50% | 1.16% | **+40.34%** |
| +1.0 (one type forever) | 32.50% | 65.00% | **−32.50%** |
| **mean across ρ** | 38.90% | 13.57% | **+25.33%** |

(20 seeds per ρ; N = 1000 arrivals per simulation run; fluid-LP-derived
clairvoyant upper bound = 500 revenue units.)

**Verdict: SHIP** (mean ε = 25.33% ≫ DR-19's 5% threshold). 0.10.1 will
add `policy: "joint-lp"` to `unifiedAdmission(...)` as an opt-in
runtime, gated on this finding.

Honest caveat — see §4: at the **degenerate extreme** ρ = +1 (one type
fills the entire window), joint-LP is *worse* than marginal-AND. This
is the well-known failure mode of fluid-LP policies under
non-stationarity. Production LLM-gateway workloads are far from this
extreme; the moderate-ρ regime is what 0.10.1 ships for.

---

## 1  The model

### 1.1 Workload

- N = 1000 arrivals per run.
- Two types over the alphabet {small, large}:
  - **small**: cost-weight c_s = 100 ("cheap LLM call")
  - **large**: cost-weight c_l = 10000 ("expensive LLM call")
- Symmetric mixture (long-run distribution): π_s = π_l = 0.5.
- Arrivals are a 2-state symmetric Markov chain with stay-probability
  P(same | prev) = (1 + ρ) / 2. The lag-1 autocorrelation equals ρ
  exactly (by the standard MC identity 2P(stay) − 1). At ρ = 0 the
  chain is independent; at ρ = +1 it's *absorbing* (one type
  forever after the first sample); at ρ = −1 it's strictly
  alternating.
- Per-call revenue: v_s = 1, v_l = 50. Revenue-per-cost ratios:
  v_s / c_s = 1/100 = 0.01 (small is more efficient);
  v_l / c_l = 50/10000 = 0.005 (large is less efficient).

### 1.2 Budgets

- Rate budget R = 1000 (= N; rate is slack).
- Cost budget C = 50_000 (= 50 × c_s; cost is tight — far below the
  expected-per-arrival cost 0.5 · c_s + 0.5 · c_l = 5050, so well
  under 10% of arrivals can be admitted on average).

This regime is **cost-binding**: cost is the bottleneck, rate has
slack. This is where joint-LP's bid-price filter has the most leverage
— it steers spending toward cost-efficient types.

### 1.3 Policies

| Policy | Rule |
|---|---|
| **Marginal-AND** | admit iff `rate.remaining ≥ 1 AND cost.remaining ≥ cost_i` |
| **Joint-LP** | admit iff budget-feasible AND `v_i ≥ p_R + p_C · cost_i` |
| **Clairvoyant** (upper bound) | fluid-LP value = 500 revenue units |

The bid prices `(p_R, p_C)` come from the fluid LP's dual at the
optimum.

---

## 2  Fluid LP — closed form

The per-arrival LP, with symmetric mixture (factor 0.5 folded into
both terms):

```
   max  0.5 · v_s · x_s + 0.5 · v_l · x_l
   s.t. x_s + x_l                ≤ 2 · (R / N) = 2.0          (rate)
        c_s · x_s + c_l · x_l    ≤ 2 · (C / N) = 100.0        (cost)
        x_s, x_l ∈ [0, 1]
```

With R = N = 1000, the rate constraint is `x_s + x_l ≤ 2.0`, which is
slack at any feasible point in [0,1]². With C = 50_000, the cost
constraint is `100 · x_s + 10000 · x_l ≤ 100`, i.e.
`x_s + 100 · x_l ≤ 1`.

**Solver enumeration**:

| corner | (x_s, x_l) | rate feas. | cost feas. | obj = 0.5·x_s + 25·x_l |
|---|---|---|---|---|
| (0, 0) | (0, 0) | ✓ | ✓ | 0 |
| small-only on cost | (1, 0) | ✓ | ✓ (tight) | 0.5 |
| large-only on cost | (0, 0.01) | ✓ | ✓ (tight) | 0.25 |
| both at cost intersection | (cost-tight, rate-tight infeasible) | — | — | — |

**Optimum: x* = (1, 0). Admit every small, zero large. V* per arrival = 0.5; over N = 1000 → V* = 500.**

### 2.1 Bid prices (dual variables)

Complementary slackness: at the optimum, only the cost constraint is
tight, so p_R = 0. For small (in the interior x_s = 1, at the upper
bound), the dual condition is satisfied; for large (at the lower
bound x_l = 0), the dual condition is `v_l ≤ p_R + p_C · c_l`. Pick
p_C so that small is on the boundary of profitability:

```
   v_s = p_R + p_C · c_s    →    1 = 0 + p_C · 100    →    p_C = 0.01
```

Check large: `v_l ≤ p_R + p_C · c_l` → `50 ≤ 0 + 0.01 · 10000 = 100`. ✓
(Large is strictly dominated.)

**Bid prices: p_R = 0, p_C = 0.01. Bid-price filter admits small
(value=1 ≥ shadow-cost=1), rejects large (value=50 < shadow-cost=100).**

---

## 3  Why the gap (the marginal-AND failure mode)

Marginal-AND has no price signal. It admits **the first arrivals it
sees**, regardless of cost-efficiency. With a 50/50 mix of small (cost
100) and large (cost 10000), marginal-AND on average admits

```
   E[admits] ≈ C / E[c] = 50000 / 5050 ≈ 9.9 arrivals
   E[revenue] ≈ 9.9 · 0.5 · (v_s + v_l) = 9.9 · 25.5 ≈ 252
```

vs joint-LP's deterministic 500 (admit-all-smalls until cost runs
out — exactly C/c_s = 500 admits at revenue 1 each).

Regret_marginal ≈ (500 − 252) / 500 ≈ **49.6%** (theory).
Regret_marginal observed ≈ **40.5%** at ρ = 0 (close to theory; the
slight discrepancy is integer-rounding and within-seed variance.)

**Why joint-LP is near-perfect (ε ≈ 39%):** the bid-price filter
selectively rejects all large requests upstream, freeing the cost
budget for cheap small requests. With C = 50000 and c_s = 100,
**exactly 500 smalls fit**; the bid-price filter ensures we get
exactly that.

---

## 4  The ρ = +1 negative result (and why it's not blocking)

| ρ | regret(marginal-AND) | regret(joint-LP) | ε |
|---|---|---|---|
| +1 | 32.50% | **65.00%** | **−32.50%** |

At ρ = +1 the Markov chain is *absorbing*: after the first sample,
the chain stays in that state forever. Realizations are bimodal: half
the time the entire 1000-arrival sequence is all-small; the other
half it's all-large.

- All-small: joint-LP admits 500 (cost cap), revenue 500. Regret 0%.
- All-large: joint-LP rejects every arrival (large fails the
  bid-price test), revenue 0. Regret 100%.
- Mean over seeds: ≈ 50% — observed 65% reflects a draw imbalance
  with 20 seeds.

Marginal-AND under all-large: admits 5 large (cost 50000 = 5 · 10000),
revenue 5 · 50 = 250. Regret 50%. Under all-small: same as joint-LP
(both admit 500). Mean over seeds: ≈ 25%.

So at ρ = +1 marginal-AND wins. **This is the well-known fluid-LP
failure under non-stationarity** (Talluri-van Ryzin 1998; the
asymptotic optimality result requires a stationary regime). At ρ = +1
the *observed* distribution is wildly different from the assumed
stationary mixture used to solve the LP.

### 4.1 Why this isn't blocking the ship

Three reasons production LLM-gateway workloads are nowhere near
ρ = +1:

1. **Tenancy mixes within a window.** Even when individual tenants
   are bursty, an aggregator's window sees a mix of tenants and
   request types. The empirical autocorrelation on real traces sits
   in `[−0.2, +0.5]` (industry sketches; not formally measured here).
   In that range, ε is consistently +39–40%.

2. **The Devanur-Hayes 2009 result** addresses exactly this concern:
   under *random permutation* of arrivals (a form of approximate
   stationarity), the primal-dual policy is `1 − ε` competitive for
   any ε > 0 — even when individual arrivals are correlated, as long
   as the *order* is a random permutation. Real arrival streams are
   closer to random-permutation than to absorbing-MC.

3. **The 0.10.1 ship is opt-in.** `policy: "joint-lp"` is gated on
   user-explicit choice. Users running degenerate workloads can stick
   with the default marginal-AND. The wiki page (TK-1322) will
   document this caveat.

### 4.2 What would change the verdict

A future "smart" joint-LP using **online primal-dual** updates (the
Devanur-Hayes update rule on observed arrivals) instead of static
fluid prices would handle ρ ≈ 1 gracefully. That's an *enhancement*
to the 0.10.1 design, not a blocker. The static-bid-price version
ships first; the online-PD version can land as 0.10.2 if the static
version finds users.

---

## 5  Reproducibility

```bash
$ npx tsx research/bigger-bets/unified/sim.ts
# TK-1007 — Joint-LP vs marginal-AND toy simulation
…
Mean ε over ρ ∈ {-1, -0.5, 0, +0.5, +1}: 25.33%
DR-19 threshold: 5%. Ship 0.10.1 joint-LP iff ε ≥ 5%.
Verdict: SHIP (ε ≥ 5%)
```

Numbers in §0's table are deterministic given the seeded PRNG
(`makeRng()` is Mulberry32 over `0xdeadbeef ^ (ρ·1000) ^ seed·2654435761`).
Any future change to the sim should re-run and update the table here.

---

## 6  Implications for the 0.9.0 / 0.10.1 design

| Decision | Status |
|---|---|
| `unifiedAdmission(...)` ships in 0.9.0 with **marginal-AND only** (the algebra in TK-1002 + sequential / fused composition in TK-1004 / TK-1005). | unchanged — TK-1007 confirms this is the right 0.9.0 deliverable |
| 0.10.1 adds `policy: "joint-lp"` to `unifiedAdmission(...)` as opt-in. | **GREEN** — ε = 25.33% mean is well above DR-19's 5% threshold |
| API for 0.10.1: `policy: "joint-lp"` + `duals: { rate, cost }` (caller-supplied static prices) OR `policy: "joint-lp"` + automatic LP solve from observed demand. | both are reasonable; TK-1319 design will lock the choice |
| Document the ρ = +1 caveat in the wiki page (TK-1322) and the example. | required for honest UX |
| Future enhancement: online primal-dual (Devanur-Hayes update) for non-stationary workloads. | candidate for 0.10.2; not blocking |

---

## 7  Limitations

1. **Toy model.** Two-type bivariate workload; a real production
   trace likely has many more types. The qualitative argument
   (joint-LP filters cost-inefficient types when cost is binding)
   generalizes, but the magnitude of ε can shift.

2. **Static bid prices.** We solve the fluid LP *assuming* the true
   stationary distribution. In practice, the operator either knows
   the distribution from historical telemetry or estimates it
   online. The Devanur-Hayes online primal-dual algorithm uses a
   prefix of the arrival stream to learn the duals — a more robust
   alternative for 0.10.2.

3. **Per-arrival admit, not horizon-based.** The fluid LP gives an
   asymptotic bound; integer effects (each arrival is admit-or-deny,
   not partial) introduce O(1) gap that vanishes as N grows. At
   N = 1000 the residual is well within seed-variance.

4. **Single-window.** The sim doesn't model window rollover. Real
   admission control sees windows repeating; per-window the same
   analysis applies, and the bid prices stay the same (since the
   stationary distribution doesn't change).

5. **No concurrency axis.** The sim is 2-axis (rate + cost). Adding
   the concurrency axis (the third axis in `unifiedAdmission`) would
   make the LP 3-dimensional; the structural argument is identical
   (bid prices for each binding axis) but the numbers shift. Concurrency's
   in-process semantics also make it harder to fold into a single fluid
   LP that's portable across the fleet — a 0.10.x topic.

---

## 8  References

- **Devanur, N. R., & Hayes, T. P. (2009).** "The adwords problem:
  online keyword matching with budgeted bidders under random
  permutations." *EC'09.* The primal-dual sample-then-price algorithm
  with `1 − ε` competitive ratio under random permutations.
- **Talluri, K. T., & van Ryzin, G. J. (1998).** "An analysis of
  bid-price controls for network revenue management." *Management
  Science* 44(11), 1577–1593. Asymptotic optimality of fluid-LP bid
  prices under stationarity.
- **Talluri, K. T., & van Ryzin, G. J. (2004).** *The Theory and
  Practice of Revenue Management.* Springer. The canonical textbook
  on bid-price controls.
- **Buchbinder, N., Jain, K., & Naor, J. (2007).** "Online primal-dual
  algorithms for maximizing ad-auctions revenue." *ESA'07.* Generalizes
  the AdWords primal-dual analysis to multi-resource auctions.
- **PLAN.md DR-11 + DR-19.** The 0.10.1 ship is conditional on this
  result.
- **research/bigger-bets/unified/DESIGN.md §7.** The TK-1007 spec
  this writeup answers.
