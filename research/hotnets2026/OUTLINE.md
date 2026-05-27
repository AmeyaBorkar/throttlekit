# HotNets '26 outline — *Rate Limiting Is Escrow Under Uncertainty*

*A 6-page "hot ideas" paper that unifies GALE (placement axis) and TALE (cost axis) under one
mechanism, one bound, and one byte-identical reduction. This is the **workshop** artifact that seeds
the two full papers ([gale/PROPOSAL.md](../gale/PROPOSAL.md), [cost-uncertainty/PROPOSAL.md](../cost-uncertainty/PROPOSAL.md)); the "two papers, not one" rule is for the deep archival versions — a workshop's currency is the idea, and the unification is the idea.*

> **Format (confirmed — HotNets '26 dates from the official page; format from the stable '25 rules, as
> '26's aren't posted yet):** submission **July 16, 2026 (AoE)** · notify **Sep 24** · camera-ready
> **Oct 23** · workshop **Nov 16–17, Salt Lake City**. From late May that's **~7 weeks of runway.**
> **≤6 pages excl. references, 10 pt, NO appendices** (so the trilemma proof *and* the reduction
> evidence must sit in-body); references unlimited. **Fully double-blind / anonymized** — the public
> artifact (npm `throttlekit`, GitHub, author) deanonymizes, so the body says "our library" and points
> at an anonymized mirror (e.g. anonymous.4open.science).

---

## 0. The spine (the elevator pitch, memorize this)

Distributed API rate limiting and LLM token-budget limiting look like different problems. They are the
**same** problem: *escrow under uncertainty* — commit a budget before the true draw is known, reconcile
when it's revealed. Two axes of the unknown: **which node** will need budget (placement) and **how much**
a request will cost (cost). Today both are enforced by two ruinous corner heuristics with **no overshoot
guarantee**. One mechanism — reserve, meter actuals, **couple credits to the window boundary**, reconcile
— bounds overshoot *independent of the quantity that blows it up* (fleet size `N`; per-request
`max_tokens`); a **trilemma** shows coordination is the unavoidable price and this mechanism spends the
minimum; and the cost-axis instance **reduces byte-identically** to the placement-axis one. Shipped,
formally model-checked, reproducible.

**One-sentence contribution:** *the same window-coupled escrow bounds overshoot on both the placement
and cost axes, the second reduces exactly to the first, and a trilemma says that's the best any
low-coordination scheme can do.*

---

## Page budget (~6 pp excl. refs)

| § | Section | pp | Carries |
|---|---|---:|---|
| 1 | Intro: the reframe + the two corners | 1.0 | the hook + contributions |
| 2 | Escrow under uncertainty: the model | 0.75 | the shared currency (Δ, U, C) |
| 3 | The trilemma | 1.0 | the "why corners are forced" + Fig 1 |
| 4 | Placement axis (GALE) | 1.0 | window-coupling ⇒ Δ⊥N + Pareto table |
| 5 | Cost axis (TALE) | 0.75 | streaming meter ⇒ Δ⊥max_tokens |
| 6 | **The reduction (punchline)** | 0.75 | byte-identical equivalence |
| 7 | Related work | 0.5 | honest positioning |
| 8 | Why now / open | 0.25 | urgency + the 3 open levers |

If over length, compress §4 and §5 (they lean on the full papers); **never cut §6** — the reduction is
what makes this a result, not an analogy.

---

## Section-by-section

### §1 — Introduction: the reframe + the two corners *(1.0 pp)*
- **Open on the collision:** two production pains, one structure. (a) A global API limit `L` across `N`
  nodes; (b) a token-per-minute budget `L` across concurrent LLM streams. Both must decide *now* with
  the true draw revealed *later*.
- **The lens:** escrow under uncertainty — *reserve → meter → reconcile at the window boundary.*
- **The two ruinous corners** (the recurring villain): **over-reserve** (safe, wastes budget) vs
  **admit-then-count** (full utilization, **unbounded** overshoot). Name the deployed instances:
  Azure APIM `llm-token-limit` (cost axis — admits "concurrent requests can temporarily exceed the
  limit," and does *not* aggregate across gateways); DRL / Doorman (placement axis — worst-case `N×`).
- **Contributions (C1–C5):** C1 the framing + two-corner diagnosis; C2 window-coupled escrow ⇒
  overshoot ⊥ `N` (placement) and ⊥ `max_tokens` (cost); C3 the trilemma (coordination is the price;
  window-coupling is the tight achievability); C4 the byte-identical reduction; C5 a shipped,
  formally-model-checked, reproducible artifact (AE-ready).
- *Source:* both PROPOSAL §1s. *Reviewer-risk to pre-empt:* "rate limiting is solved" → lead with the
  *deployed-and-unbounded* evidence (Azure quote, LiteLLM's measured 6.6×).

### §2 — Escrow under uncertainty: the model *(0.75 pp)*
- One window, budget `L`, `N` agents (nodes / gateways / concurrent streams). Each **commits a
  reservation** `b` before its draw, **reconciles** at the boundary.
- **The two axes as one model:** placement — draw = which node's demand lands; cost — draw = a request's
  realized token count (`c ∈ [c_in, c_in+max_tokens]`, revealed by streaming).
- **The shared currency — three costs, worst-case over an adversary:** overshoot `Δ`, under-utilization
  `U`, coordination `C`. Everything downstream is stated in these.
- *Source:* TRILEMMA.md model; TALE §1. *Reviewer-risk:* "the analogy is loose" → the model is literally
  shared; §6 then proves the instances coincide.

### §3 — The trilemma *(1.0 pp + Fig 1)*
- **Theorem (zero-coordination):** `Δ + N·U ≥ (N−1)L`, tight (uniform allocation). The two corners are
  its two extremes: exact (`Δ=0`) ⇒ `U ≥ (N−1)L/N`; work-conserving (`U=0`) ⇒ `Δ ≥ (N−1)L`.
- **Honest framing (do NOT oversell):** the bound is **elementary** (a one-line, general-`N` averaging
  argument; the `N∈{2,3,4}` model-check is corroboration). Its value is the **design-space framing** +
  the **achievability**: window-coupling reaches `Δ=0` with bounded `C`. It is **complementary to, not a
  corollary of,** the distributed-monitoring lower bounds (Cormode–Muthukrishnan–Yi; Woodruff–Zhang),
  which price the orthogonal coordination-cost (`Δ–C`) edge.
- **Fig 1:** the (Δ, U, C) triangle / two-corner diagram — the paper's anchor figure.
- *Source:* TRILEMMA.md (already reframed). *Reviewer-risk:* "this is just CMY recast" → state plainly
  it isn't (different axis; neither implies the other) and that the contribution is framing+achievability.

### §4 — Instantiation 1: the placement axis (GALE) *(1.0 pp)*
- **Window-coupled leasing:** couple credit lifetime to the L2 window ⇒ worst-case admissions `= L`,
  **independent of `N`** (vs the prior tight `L + N·(B−1)`). Machine-checked (TLA+ + CI-gated BFS twin,
  self-validated vs TLC counts 31/441). **Shipped** as `lease.windowCoupled`.
- **Efficiency layers (one line each, explicitly *not* the safety story):** online lease sizing
  (EOQ/OGD, `O(√T)` regret) drives `U→0`; predictions-with-safety (Hedge over {follow, robust}) — safety
  holds *unconditionally* because the escrow store gates regardless of the predictor.
- **Eval highlight (Table):** under skew, GALE is the only scheme good on all three axes — Pareto-dominates
  best fixed-batch coupled (equal util, 26% fewer round trips), 4× less coordination than central, `Δ=0`.
- *Source:* gale/PROPOSAL §3–6, EVALUATION.md. *Reviewer-risk:* "incremental over Doorman" → the
  *tight, N-independent* bound + shipped + measured Pareto-dominance is the delta.

### §5 — Instantiation 2: the cost axis (TALE) *(0.75 pp)*
- **Streaming meter:** debit `L` per produced token (amortized every `g`); worst-case overshoot
  **`≤ g−1`, independent of `max_tokens`** (`0` at `g=1`); utilization `→1` (nothing sterilized).
- **The deployed foils, with receipts:** Azure (admits unbounded overshoot; non-aggregating across
  gateways); **LiteLLM measured 6.6×** at concurrency 5 (#18730); Zuplo ("the request that pushes you
  over completes successfully"). The contrast widens with `max_tokens`.
- **L2/L3 in one honest paragraph:** learned reservation (newsvendor critical-fractile via OGD) +
  output-length-rank predictions (Hedge) — **known machinery applied to the cost axis**; safety comes
  from the *meter*, not the predictor. Cite, don't claim.
- *Source:* cost-uncertainty/PROPOSAL §3, token-budget tests. *Reviewer-risk:* "LLM scheduling is
  crowded" → we bound the *budget*, they reorder for *latency*; orthogonal (§7).

### §6 — The reduction: the two axes are one *(0.75 pp) — THE PUNCHLINE*
- **Claim:** the distributed multi-gateway token meter **is** GALE window-coupled leasing with the token
  as the unit — gateway = leasing node, lease = a token batch, the stream debits leased tokens as the
  model emits them.
- **Evidence:** `simulateDistributedBudget` (window-coupled) `produced` is **byte-identical** to GALE's
  request-granular `simulateWindowCoupled` `admitted`; measured across `C ∈ {1..32}` gateways —
  global overshoot stays `0` independent of `C` (vs carryover's `C·(B−1)`).
- **So:** the fleet-size-independent bound transfers to TPM sharing **for free**; the unification is a
  *reduction*, not a metaphor. This paragraph is why the paper is more than two demos.
- *Source:* distributed-budget tests; both PROPOSALs' capstones. *Reviewer-risk:* "analogy dressed up"
  → "byte-identical" is a checkable claim, and the artifact checks it.

### §7 — Related work *(0.5 pp)*
- **Placement:** DRL/Doorman/GAC — no tight `N`-independent bound; CMY/Woodruff–Zhang — price coordination
  (complementary); FairRide — fairness impossibility (we take the sharing-incentive corner, concede
  strategy-proofness).
- **Cost:** Azure/Kong/Zuplo/LiteLLM — deployed, unbounded; LLM-scheduling line (Unschedulable 2604.06970,
  Argus 2512.22925, vLLM L2R 2408.15792) — adjacent (latency/SLO), not budget-overshoot bounds; the
  online-learning machinery L2/L3 instantiate (Nonstationary-Newsvendor-with-predictions 2305.07993;
  Best-of-Many-Worlds 2402.13530; Capacity-Constrained-OL-with-Delays 2503.19856).
- **The honest one-liner:** we claim the framing, the bound + achievability, and the reduction — *not* the
  online-learning bounds and *not* a new impossibility.
- *Source:* both PROPOSAL §8/§5 (already de-risked) + [throttlekit-publishability memory].

### §8 — Why now / open *(0.25 pp)*
- **Why now:** LLM TPM budgets make the cost axis urgent *and* unsolved in production — the framing is
  timely and the foils are live.
- **Open (the honest roadmap):** (1) the partial-coordination `0<C<N` interpolation (the real theory
  depth); (2) a distributed eval at scale on real LLM-serving traces; (3) the conjectured cost-axis
  trilemma.

---

## Figures / tables (keep to ~2–3 — HotNets is figure-light)
- **Fig 1 (anchor):** the (Δ, U, C) trilemma triangle with the two corners marked and GALE/TALE at the
  good corner. *(new; draw from TRILEMMA.md)*
- **Table 1:** placement-axis Pareto comparison (strict / static / fixed-leasing / window-coupled /
  GALE). *(from EVALUATION.md)*
- **Fig 2 (optional, high-value):** overshoot vs the blow-up quantity, *both axes on one plot* — Δ vs `N`
  (placement) and Δ vs `max_tokens` (cost), each flat for window-coupled, each rising for the corner.
  This single figure *is* the paper's thesis. Strongly consider over Table 1 if space is tight.

---

## Title options
1. **Rate Limiting Is Escrow Under Uncertainty** *(recommended — declarative, memorable)*
2. One Window to Bound Them Both: Escrow Rate Limiting Across Placement and Cost
3. Escrow Under Uncertainty: A Unified, Fleet- and `max_tokens`-Independent Overshoot Bound

---

## Open decisions before drafting prose
1. **Unification vs. TALE-only.** This outline is the unification bet. The conservative fallback (if we
   decide the framing won't carry 6 pp) is a TALE-only paper — sharper single problem, lower wow. The
   reduction (§6) is the tiebreaker: if it lands crisply, go unification.
2. **Blind policy** → anonymize the artifact if double-blind.
3. **Eval scope for the workshop:** the existing measured (single-machine/simulation) results are
   *sufficient* for HotNets; do **not** start the at-scale eval for this submission (that's the full
   papers).

## Build plan (fastest path to a draft)
- Day 1: §1 + §2 + Fig 1 + the contributions list (the spine). 
- Day 2: §3 (reframe straight from TRILEMMA.md) + §6 (the reduction — write this early; it's the point).
- Day 3: §4 + §5 (compress from the PROPOSALs) + Fig 2.
- Day 4: §7 + §8 + abstract; tighten to 6 pp.
- Reuse map: ~70% of prose exists in the two PROPOSALs + TRILEMMA.md + EVALUATION.md; this is assembly
  and compression, not new research.
