# HotNets '26 spine draft — *Rate Limiting Is Escrow Under Uncertainty*

> Working prose for the load-bearing sections: **abstract, §1 (intro + contributions), §6 (the
> reduction), and Fig 2.** Plan and full section map: [OUTLINE.md](OUTLINE.md). Written
> **double-blind-clean** (no library name, author, or URLs in the body) so it's submission-ready; for
> the camera-ready, restore the artifact name/links. Format constraints baked in: ≤6 pp excl. refs,
> 10 pt, **no appendices** — the trilemma proof (one line) and the reduction evidence are in-body.

---

## Abstract (draft, ~170 words → trim to ~150)

Two rate-limiting problems that the systems and ML-systems communities treat as unrelated — enforcing a
global request limit across a fleet of `N` stateless nodes, and enforcing a token-per-minute budget
across concurrent LLM streams — are the same problem. Both must commit a share of a shared budget
*before* the quantity that determines consumption is known, and reconcile *after* it is revealed:
**escrow under uncertainty**. We observe that every deployed limiter on either axis resolves this with
one of two corner heuristics — *over-reserve* (safe, but strands budget) or *admit-then-count*
(fully utilized, but with overshoot that grows without bound) — and that a single mechanism beats both:
reserve, meter actuals as they accrue, and **couple credits to the reconciliation window**. This bounds
worst-case overshoot *independent of the quantity that otherwise blows it up* — the fleet size `N` on the
placement axis, and `max_tokens` on the cost axis. An elementary trilemma shows the two corners are the
extremes of one design space and that some coordination is unavoidable; window-coupling spends only the
minimum. Finally, the cost-axis mechanism reduces **byte-identically** to the placement-axis one, so the
fleet-size-independent guarantee transfers to multi-gateway token budgets for free. The mechanism is
shipped in a production library, formally model-checked, and reproducible.

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

## 6 The reduction: the two axes are one

Sections 4 and 5 give two mechanisms with the same shape and the same guarantee. We now show they are
not merely analogous but the *same* mechanism: the distributed cost-axis meter **is** placement-axis
window-coupled leasing with the token as the unit of budget.

The mapping is exact. A leasing **node** becomes an LLM **gateway**; a **lease** of `B` request-credits
becomes a lease of a `B`-token batch from the shared budget; **admitting a request** against a held
credit becomes **emitting a token** against held token-budget; the **window rollover** at which
uncommitted credits expire becomes the TPM-window boundary. Under this relabeling, a gateway that leases
token batches from a shared store and debits them as the model streams output runs, step for step, the
window-coupled leasing protocol of §4.

The correspondence is literal, not informal. Running both systems on the same demand schedule, the
window-coupled cost-axis meter's count of *produced* tokens is **byte-identical** to the placement-axis
protocol's count of *admitted* requests, across `C ∈ {1..32}` gateways sharing one budget. The
consequence is immediate: the placement-axis theorem — global overshoot `= L`, independent of fleet size
— transfers to the cost axis unchanged. Multi-gateway token-per-minute sharing, which production
gateways today leave un-aggregated and unbounded, **inherits a fleet-size-independent overshoot bound for
free, with no new proof.**

This is what raises §1's reframing from a useful analogy to a result: the two problems are not similar,
they are inter-reducible, and a guarantee proved once holds on both axes.

---

## Figure 2 — the thesis in one plot *(the figure to get right)*

One plot carries the whole argument.

- **x-axis:** the blow-up quantity, normalized — fleet size `N` (placement) and per-request `max_tokens`
  (cost) overlaid on a shared normalized scale.
- **y-axis:** worst-case overshoot `Δ`, as a fraction of the budget `L`.
- **Four series:**
  - *admit-then-count, placement* — rises ≈ linearly toward `(N−1)L`;
  - *admit-then-count, cost* — rises ≈ linearly in `max_tokens` (toward `C·max_tokens`);
  - *window-coupled, placement* — flat at `Δ = 0`;
  - *window-coupled, cost* — flat at `Δ ≤ g−1` (visually ≈ 0).

Under normalization the two rising curves coincide and the two flat curves coincide: *the same mechanism
flattens overshoot on both axes against the quantity that otherwise blows it up.*

**Caption (draft):** *Worst-case budget overshoot vs. the quantity that determines it, on both axes. The
corner heuristic (admit-then-count) overshoots without bound — linearly in fleet size `N` (placement)
and in `max_tokens` (cost). Window-coupled escrow holds overshoot at `0` (placement) and `≤ g−1` (cost),
independent of both. The placement and cost series coincide because, by §6, they are the same mechanism.
Reproducible simulation; artifact anonymized for review.*

**Data already exists:** placement `Δ`-vs-`N` (legacy grows 15→25 as `N`: 2→16; window-coupled `0`) in
`research/gale/EVALUATION.md`; cost `Δ`-vs-`max_tokens` (admit-then-count 24→7192 as `m`: 256→2048;
streaming `0`) in the `test/cost/` token-budget results. Fig 2 is a re-plot, not a new experiment.
