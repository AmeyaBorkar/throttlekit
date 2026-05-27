# HotNets '26 draft — *Rate Limiting Is Escrow Under Uncertainty*

> Full prose draft of all sections. Plan/page-budget: [OUTLINE.md](OUTLINE.md). Written
> **double-blind-clean** (no library name, author, or URLs in the body); restore the artifact name/links
> for the camera-ready. Format: ≤6 pp excl. refs, 10 pt, **no appendices** — the trilemma proof (one
> line) and the reduction evidence are in-body. Fig 2 is generated + reproducible (`fig2.ts` → `fig2.svg`).

---

## Abstract

Two rate-limiting problems that the systems and ML-systems communities treat as unrelated — enforcing a
global request limit across a fleet of `N` stateless nodes, and enforcing a token-per-minute budget
across concurrent LLM streams — are the same problem. Both must commit a share of a shared budget
*before* the quantity that determines consumption is known, and reconcile *after* it is revealed:
**escrow under uncertainty**. Every deployed limiter on either axis resolves this with one of two corner
heuristics — *over-reserve* (safe, strands budget) or *admit-then-count* (utilized, but with overshoot
that grows without bound) — and a single mechanism beats both: reserve, meter actuals as they accrue, and
**couple credits to the reconciliation window**. This bounds worst-case overshoot *independent of the
quantity that otherwise blows it up* — the fleet size `N` on the placement axis, and `max_tokens` on the
cost axis. An elementary trilemma shows the two corners are the extremes of one design space and that
some coordination is unavoidable; window-coupling spends only the minimum. Finally, the cost-axis
mechanism reduces **byte-identically** to the placement-axis one, so the fleet-size-independent guarantee
transfers to multi-gateway token budgets for free. The mechanism is shipped in a production library,
formally model-checked, and reproducible.

---

## 1 Introduction

Consider two problems. **(P1)** A service enforces a global limit of `L` requests per window across `N`
stateless nodes, where no node sees the others' traffic within the window. **(P2)** An LLM gateway
enforces a token-per-minute budget `L` across many concurrent requests, but a request's dominant cost —
its *output* tokens — is unknown until the model has finished generating. P1 is a classic
distributed-systems problem with two decades of literature; P2 is a 2024-vintage operational problem
discussed mostly in vendor documentation. We argue they are the *same* problem, and that seeing this
yields a single mechanism with a provable guarantee that neither community currently has.

The shared structure is **escrow under uncertainty**. In both, an agent must *commit* part of a shared
budget before the quantity that determines consumption is revealed, then *reconcile* the commitment
against reality. Only the axis of uncertainty differs: on the **placement** axis (P1) the unknown is
*which* node will need budget; on the **cost** axis (P2) it is *how much* a request will spend. The
budget, the commit-then-reconcile rhythm, and the failure modes are identical.

Today both axes are served by the same two corner heuristics, and both corners are bad. **Over-reserve**
commits the worst case up front — a node pre-takes `L/N`; a request reserves `max_tokens`. It never
overshoots, but it strands budget: an idle node's share is denied to a busy one, and because LLM output
lengths are heavy-tailed (p50 ≪ `max_tokens`), a 4096-token reservation that emits 180 tokens sterilizes
~95% of itself. **Admit-then-count** commits nothing and debits the true cost once known. It wastes
nothing but overshoots without bound: `N` nodes can each admit a full local burst, and the requests
admitted near a boundary can each run to `max_tokens`. This is not hypothetical. Distributed limiters
concede it — the classic distributed-rate-limiting line notes a disconnected fleet can oversubscribe by
a factor of `N`, and a widely-cited lease-based limiter documents handing out over 100% of the
configured limit. LLM gateways concede it verbatim — a major cloud API-management token-limit policy
states that "concurrent or near-concurrent requests can temporarily exceed the configured token limit"
and that it "does not aggregate token counts across" gateways; an open-source gateway was measured
admitting 6.6× its limit under five concurrent requests. **No deployed or published limiter on either
axis has a tight, all-time overshoot bound.**

We close that gap with one mechanism and show it is one mechanism. The move is to *reserve, meter
actuals as they accrue, and couple credits to the reconciliation window* — uncommitted credits expire at
the window boundary rather than carrying forward. On the placement axis this is window-coupled leasing;
on the cost axis it is a streaming token meter. In both, worst-case overshoot becomes **independent of
the quantity the corner heuristics let blow it up** — the fleet size `N`, and the per-request
`max_tokens`. Concretely, this paper contributes:

- **C1 — The reframing.** Distributed rate limiting and LLM token budgeting are instances of *escrow
  under uncertainty*, on a placement and a cost axis; the two corner heuristics are the ruinous extremes
  of one design space (§2).
- **C2 — One bounding mechanism.** Window-coupled escrow makes worst-case overshoot independent of `N`
  on the placement axis (`Δ = 0`, vs. the prior tight `L + N(B−1)`) and independent of `max_tokens` on
  the cost axis (`Δ ≤ g−1` for reconcile granularity `g`; `0` at `g=1`) (§4, §5).
- **C3 — A trilemma.** An elementary, tight bound `Δ + N·U ≥ (N−1)L` shows that at zero coordination,
  overshoot `Δ` and stranded capacity `U` cannot both be small — so some coordination is unavoidable,
  and window-coupling spends exactly the minimum. The bound is *complementary to*, not a corollary of,
  the distributed-monitoring lower bounds that price coordination itself (§3).
- **C4 — A reduction.** The distributed cost-axis meter reduces **byte-identically** to placement-axis
  window-coupled leasing, so the fleet-size-independent guarantee transfers to multi-gateway token
  budgets for free (§6). The unification is a reduction, not an analogy.
- **C5 — A shipped, checked artifact.** The placement-axis mechanism ships in a production
  rate-limiting library; the bounds are machine-checked by exhaustive model checking, and every figure
  here is reproducible.

---

## 2 Escrow under uncertainty: the model

One window, a shared budget of `L`, and `N` agents (nodes, gateways, or concurrent streams). Each agent
must **commit** part of the budget — a reservation `b` — before its draw is known, and **reconcile** the
commitment at the window boundary. We measure three worst-case quantities, taken over an adversary that
chooses the draws:

- **overshoot** `Δ` — how far total consumption can exceed `L`;
- **under-utilization** `U` — how far below the serveable demand `min(ΣD, L)` admissions fall (budget
  that should have been used but was stranded);
- **coordination** `C` — inter-agent messages / shared-store round trips per window.

The two axes are two instantiations of *what the draw is*. On the **placement** axis the draw is the
demand vector — which agent needs budget; the reservation is a per-node lease. On the **cost** axis the
draw is a request's realized token count `c ∈ [c_in, c_in + max_tokens]`, revealed only as the model
streams; the reservation is a per-request token estimate. Everything below is stated in `(Δ, U, C)` — and
§6 shows the two instantiations are not merely modeled alike, but inter-reducible.

---

## 3 The trilemma

The two corner heuristics are not a failure of engineering; without coordination, *something* must give.
Model a **zero-coordination** protocol as one that pre-authorizes each agent a local budget `b_i ≥ 0` and
admits `a_i = min(d_i, b_i)` — no agent learns another's draw within the window. Let `S = Σ b_i`.

**Lemma.** For a fixed allocation the adversary forces `Δ = (S − L)⁺` (offer every agent ≥ its budget) and
`U = (L − min_i b_i)⁺` (concentrate all demand on the thinnest-budgeted agent).

**Theorem (tight).** `Δ + N·U ≥ (N−1)·L`, attained with equality by the uniform allocation `b_i = L/N`.
*Proof:* `min_i b_i ≤ S/N ≤ (L+Δ)/N`, so `N·U ≥ NL − (L+Δ) = (N−1)L − Δ`. ∎

The two corners are its extremes: exact admission (`Δ=0`) forces `U ≥ (N−1)L/N` (a hot agent throttled to
a `1/N` share); work-conservation (`U=0`) forces `Δ ≥ (N−1)L`. **Neither overshoot nor stranding can be
made small without coordination.**

We are deliberate about what this is. The bound is **elementary** — a one-line averaging argument, general
in `N` (we machine-check it exhaustively for `N ∈ {2,3,4}` as a guard). Its worth is not depth but (i) the
*framing* — it places the two deployed heuristics as the two ruinous corners of one design space — and
(ii) the *achievability*: §4–§5's window-coupling reaches the good corner (`Δ=0`, `U→0`) by spending a
bounded amount of the coordination the bound proves necessary. It is **complementary to, not a corollary
of**, the distributed functional-monitoring lower bounds (Cormode–Muthukrishnan–Yi; Woodruff–Zhang),
which price the orthogonal `Δ–C` edge — the *cost* of coordination — rather than this `Δ–U` allocation
edge. Neither implies the other.

---

## 4 Placement axis: window-coupled leasing

Each node leases a batch of `B` credits from the shared store and admits locally against them; the store's
per-window counter is the budget `L`. The sole source of overshoot is **carryover** — credits leased late
in one window that survive into the next, stacking on top of a fresh `L`. **Window-coupling** expires
uncommitted credits at the boundary, removing carryover:

**Theorem.** Per-window global admissions `≤ L`, **independent of `N`** — versus the prior tight bound
`L + N·(B−1)` when credits carry.

We verify this by exhaustive model checking of the leasing transition system (a TLA⁺ spec and a CI-gated
re-implementation, self-validated against the published TLC state counts). Fig 2(a) shows the realized
contrast: against an adversarial trace, the carrying scheme overshoots `N·(B−1)` (rising with the fleet)
while window-coupling holds `Δ=0` at every `N`. The mechanism **ships** in a production rate-limiting
library (anonymized).

Two efficiency layers ride on top without touching safety, because the shared store gates regardless: an
**online lease sizer** (an EOQ cost minimized by OGD, `O(√T)` regret) drives `U→0` by matching each
node's batch to its own demand; a **predictions-with-safety** layer (a Hedge meta-learner over a demand
predictor and the robust sizer) earns consistency when the predictor is good and robustness when it is
adversarial. Both are efficiency knobs; the overshoot bound holds for any lease sizes.

---

## 5 Cost axis: the streaming meter

A request's reservation is its *estimate*; its true cost is its output-token count, revealed as the model
streams. The same move applies: don't reserve `max_tokens` (over-reserve — the first corner) and don't
debit only at completion (admit-then-count — the second); **meter the budget per produced token**,
amortized every `g` tokens, and stop in-flight streams at their next chunk boundary once the budget is
spent.

**Theorem.** With an atomic per-chunk meter, worst-case overshoot `≤ g−1`, **independent of `max_tokens`
and of concurrency** (`g=1 ⇒ Δ=0`); utilization `→ 1`.

Fig 2(b) shows the realized contrast against a cap-hitting trace: admit-then-count overshoots
`C·max_tokens − L` (rising steeply with `max_tokens`), while the streaming meter holds `Δ=0` at every
`max_tokens`. The deployed baselines sit at the corners and concede it (§1).

Admission still wants a per-request reservation (to pace concurrency and issue 429s). We pick it as a
learned quantile of the output-length distribution (the newsvendor critical fractile, via OGD) and, when
a per-request output-length-*rank* predictor is available, arbitrate predicted vs. robust reservations
with a Hedge meta-learner. These two layers are **known online-learning machinery applied to the cost
axis** — newsvendor-with-predictions and online-allocation-with-predictions — not new analysis; safety
comes from the *meter*, not the reservation, so it is unconditional on predictor quality.

---

## 6 The reduction: the two axes are one

Sections 4 and 5 give two mechanisms with the same shape and the same guarantee. We now show they are not
merely analogous but the *same* mechanism: the distributed cost-axis meter **is** placement-axis
window-coupled leasing with the token as the unit of budget.

The mapping is exact. A leasing **node** becomes an LLM **gateway**; a **lease** of `B` request-credits
becomes a lease of a `B`-token batch from the shared budget; **admitting a request** against a held credit
becomes **emitting a token** against held token-budget; the **window rollover** at which uncommitted
credits expire becomes the TPM-window boundary. Under this relabeling, a gateway that leases token batches
from a shared store and debits them as the model streams output runs, step for step, the window-coupled
leasing protocol of §4.

The correspondence is literal, not informal. Running both systems on the same demand schedule, the
window-coupled cost-axis meter's count of *produced* tokens is **byte-identical** to the placement-axis
protocol's count of *admitted* requests, across `C ∈ {1..32}` gateways sharing one budget. The consequence
is immediate: the placement-axis theorem — global overshoot `= L`, independent of fleet size — transfers
to the cost axis unchanged. Multi-gateway token-per-minute sharing, which production gateways today leave
un-aggregated and unbounded, **inherits a fleet-size-independent overshoot bound for free, with no new
proof.**

This is what raises §1's reframing from a useful analogy to a result: the two problems are not similar,
they are inter-reducible, and a guarantee proved once holds on both axes.

---

## 7 Related work

**Placement.** Distributed rate limiting (DRL, GDRL, DynamoDB GAC, Doorman) is empirical or
equilibrium-only and concedes `N×`-style overshoot; none gives a tight `N`-independent bound. The
distributed functional-monitoring lower bounds (Cormode–Muthukrishnan–Yi; Woodruff–Zhang) price the
coordination edge and are complementary to our `Δ–U` trilemma. Weighted-fair variants must contend with
FairRide's sharing-incentive / strategy-proofness impossibility; our split takes the sharing-incentive
corner and concedes strategy-proofness.

**Cost.** Production gateways (Azure APIM, Kong, Zuplo, LiteLLM) implement reserve-then-reconcile but
leave overshoot unbounded and un-aggregated across gateways. A vigorous LLM-scheduling line
(learning-to-rank output lengths; black-box admission/ordering; length-prediction + Lyapunov offloading)
reorders a budget for latency/SLO — adjacent, but it does not bound a token budget. The online-learning
machinery our reservation layers instantiate (newsvendor-with-predictions; online allocation with
predictions; capacity-constrained learning with delays) is prior, and cited as such.

**The honest line:** we claim the framing, the bound and its achievability, and the reduction — not the
online-learning bounds, and not a new impossibility.

---

## 8 Why now, and what's open

LLM token-per-minute budgets make the cost axis both urgent and, in production, unsolved — the framing is
timely and its baselines are live. Three things are open and honestly out of scope here: the
a tight lower bound for *dynamic* partial coordination — the *static-partition* interpolation `Δ + (N−C)·U ≥ (N−C−1)·L` is settled (tight, machine-checked), but the dynamic `≤C`-message case, which demand-driven leasing exploits, is open (the real theory depth);
a distributed evaluation at scale on real LLM-serving traces (the systems depth); and a cost-axis
trilemma to match the placement one (conjectured). Each is a full-paper contribution; this paper's claim
is the unification and the shared bound.

---

## Figure 2 — the thesis in one plot *(generated, reproducible)*

`fig2.svg`, regenerated from the real simulators by `fig2.ts` (`npx tsx research/hotnets2026/fig2.ts`;
series in `fig2-data.csv`). Two panels, each *worst-case overshoot `Δ/L` vs. the quantity that determines
it*:

- **(a) placement:** `Δ` vs fleet size `N` — carryover leasing rises as `N·(B−1)` (0.09→0.72·`L` for
  `N`: 2→16); window-coupled flat at `0`.
- **(b) cost:** `Δ` vs `max_tokens` — admit-then-count rises as `C·m − L` (0.024→7.19·`L` for `m`:
  256→2048); streaming (`g=1`) flat at `0`.

Two panels, not a shared axis: the cost corner overshoots ~5× the placement corner as a fraction of `L`,
so overlaying on one y-axis would mislead. The load-bearing message is the **parallel structure** — on
*both* axes the corner heuristic's overshoot grows without bound in its blow-up quantity, and the *same*
window-coupled escrow flattens it to ≈0 — reinforced by §6, where the two mechanisms are shown to be the
same. The values regenerate exactly from the engines (and match the standalone GALE/TALE evaluations), so
the figure is reproducible, not asserted.

**Caption (draft):** *Worst-case budget overshoot vs. the quantity that determines it. (a) Across a fleet
of `N` nodes, carrying leased credits overshoots `N·(B−1)`; window-coupling holds `Δ=0`. (b) Across
concurrent LLM streams, admit-then-count overshoots `C·max_tokens − L`; a streaming meter (`g=1`) holds
`Δ=0`. The same mechanism — reserve, meter, couple to the window — flattens overshoot on both axes; §6
shows they are literally the same mechanism.*

---

## Status / build notes
- **Reusable as-is:** ~70% of prose derives from `gale/PROPOSAL.md`, `cost-uncertainty/PROPOSAL.md`,
  `gale/TRILEMMA.md`, `gale/EVALUATION.md`. Fig 2 is generated and self-validating.
- **Before submission:** anonymize (artifact name/links → "our library" + anonymized mirror); confirm the
  '26 page/format rules when posted; tighten to 6 pp (compress §4/§5 first; never §6).
- **Decision still open:** unification (this draft) vs. TALE-only fallback — the reduction (§6) reads as a
  real result, so the recommendation is to hold the unification line.
