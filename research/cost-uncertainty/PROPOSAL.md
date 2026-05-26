# Escrow under Cost Uncertainty: Provable Token-Budget Rate Limiting for LLMs

*A research proposal / paper skeleton — the cost-axis sibling of [GALE](../gale/PROPOSAL.md). Working
title acronym **TALE** (Temporally-Accounted Learned Escrow) is a placeholder.*

> **One-line thesis.** Classical rate limiting assumes a request's cost is known at admission. LLM
> serving breaks that: the binding limit is **tokens-per-minute (TPM)**, and the dominant cost —
> *output* tokens — is revealed only *during/after* generation. We treat token-budget rate limiting as
> **escrow under cost uncertainty**: reserve a cost at admission, reconcile when the truth is revealed.
> We give what is, to our knowledge, the first scheme with a **tight, provable overshoot bound independent of `max_tokens`** —
> via a *streaming meter* that is the cost-axis analog of GALE's window-coupling — plus an online
> learned reservation and a predictions-with-safety layer that reuses GALE's machinery.

> **Status.** Design + validated-open. **All three layers are implemented + measured** and gated under
> `test/cost/`. L1 (streaming meter): overshoot `0` at full utilisation across *every* `max_tokens`,
> where reserve-max collapses to `0` util (at `m ≥ L`) and admit-then-count's overshoot grows `≈ C·m`.
> L2 (learned reservation): avg pinball regret `8.49 → 2.77` (the no-regret signature), and the only
> implementable admission policy with full utilisation *and* few aborts (matching the clairvoyant
> oracle). L3 (predictions): perfect advice → clairvoyant, adversarial → the robust quantile (`1.00×`),
> and overshoot stays `0` under *any* predictor. Reproduce with `npx vitest run test/cost`.

---

## 1. The problem (real, and validated as open)

A token budget `L` (e.g. an OTPM cap, or a TPM budget shared across tenants) must be enforced, but a
request's token cost `c` is **not known at admission** — `c ∈ [c_in, c_in + max_tokens]`, and the
output portion is whatever the model decides to generate. Two incumbent behaviours, both unsatisfying,
straight from production gateways:

1. **Reserve the max.** Azure API Management's `llm-token-limit` policy reserves `max_tokens` at
   admission and credits back the unused difference on completion. Safe (never overshoots) — but
   utilization is `E[c]/max_tokens`, and LLM output lengths are **heavy-tailed** (p50 ≪ `max_tokens`),
   so most of the budget is reserved-but-unused. A `max_tokens = 4096` request that emits 180 tokens
   sterilised ~95% of its reservation.
2. **Admit, then count.** Debit the actual cost once the response returns. Full utilization — but the
   same docs concede that *"concurrent requests can temporarily exceed the configured token limit"*:
   `C` requests admitted near the boundary can each run to `max_tokens`, so overshoot is **`≈ C ·
   max_tokens`, unbounded in `max_tokens`**, with no stated bound. This is not hypothetical: LiteLLM's TPM limiter was **measured at 6.6×** under 5 concurrent requests (issue #18730, whose proposed "reserve-then-refund" fix ships no bound), and Zuplo documents that *the request that pushes you over the budget completes successfully* — every production token limiter sits at one of these two corners.

**No deployed or published token-budget limiter has a tight, all-time bound on overshoot under post-hoc
costs.** That is the gap — the cost-axis twin of the gap GALE closed for distributed leasing.

## 2. The key insight

> **Streaming reconciliation is window-coupling on the cost axis.** GALE bounds overshoot by *not
> pre-committing the max* and *metering actuals as they accrue* across nodes; coupling credits to the
> L2 window makes the bound independent of fleet size `N`. The identical move on the cost axis:
> **don't reserve `max_tokens`; meter the budget per produced token (or per `g`-token chunk) and stop
> at the boundary.** Overshoot then depends only on the in-flight reconcile granularity, not on
> `max_tokens`. Reserve-max and admit-then-count are the two ruinous corners; streaming is the escrow
> that beats both — exactly as window-coupling beat carryover and static shares.

LLMs *stream* tokens, so the actual cost is observable incrementally — the meter is free.

## 3. The contribution

A token-budget admission/metering scheme — **reserve-then-reconcile escrow** — in three layers.

### Layer 1 — Streaming meter ⇒ overshoot independent of `max_tokens`

Debit the shared budget `L` per produced token (amortised every `g` tokens — the *reconcile
granularity*); admit a new request only while budget remains; when it is exhausted, stop in-flight
streams at their next chunk boundary and reject new ones.

- **Theorem (Safety).** With an *atomic* per-chunk meter (single gateway), worst-case overshoot
  `≤ g − 1` — **independent of `max_tokens` *and* of concurrency**; per-token metering (`g = 1`) ⇒
  overshoot `0`. With a *distributed* meter across `C` gateways sharing one budget (each commits a
  chunk before observing the others — exactly GALE's coordination regime), `≤ C·g`. Either way the
  bound is independent of `max_tokens`, and utilization `→ 1` (nothing is sterilised). The distributed
  case *is* a GALE leased budget with tokens as the unit — so multi-gateway TPM sharing inherits the
  window-coupled, fleet-size-independent bound.
- **Contrast + measured** (`L = 1000`, `C = 4`; heavy-tailed and cap-hitting traces; numbers gated in
  `test/cost/token-budget.test.ts`). *Reserve-max:* overshoot `0`, but utilisation **collapses
  `0.77 → 0.50 → 0`** as `m` grows `256 → 512 → 1024` (at `m ≥ L` it cannot admit one request).
  *Admit-then-count:* utilisation `1`, but worst-case overshoot **grows `24 → 1048 → 3096 → 7192`** as
  `m` grows `256 → 2048` (within `C·(m−1)`). *Streaming (`g = 1`):* overshoot **`0`** and utilisation
  **`1`** at *every* `m` — the only scheme good on both axes, and the gap *widens* with `max_tokens`.

### Layer 2 — Learned reservation ⇒ admit-time decisions without over-reserving

The meter bounds overshoot, but *admission* still needs a per-request reservation `r` (to decide the
429 and to pace concurrency). Over-reserve (`r = max_tokens`) and you needlessly 429 admissible
traffic; under-reserve and you over-admit. Pick `r` as a **learned quantile** of the output-length
distribution and reconcile the residual against the streaming meter. This is GALE's Pillar 2 on the
cost axis: an online learner minimising a convex admission cost (false-429 vs over-admit), with
`O(√T)` regret; safety is unconditional because the *meter* (Layer 1), not the reservation, enforces `L`.

**Implemented + measured** (`test/cost/learned-reservation.ts`; seeded, `h=1, p=4, τ=0.8`). The
admission cost is the newsvendor / pinball loss `ℓ(r,c) = h·(r−c)₊ + p·(c−r)₊`, minimised at the
critical-fractile quantile `τ = p/(h+p)`. The learner is **projected OGD** (Zinkevich) — the pinball
subgradient is *bounded and constant-magnitude*, exactly where vanilla OGD with `η_t = D/(G√t)` is
regret-optimal, so it is the right tool here (Pillar 2's *unbounded, smooth* EOQ gradient is what earns
AdaGrad). Measured: avg pinball regret `8.49 → 2.77` as `T: 100 → 6400`; the best fixed reservation in
hindsight *is* the empirical τ-quantile (the newsvendor identity, machine-checked); it beats any fixed
reservation by 31% under a distribution shift. In the admission loop (`L=1000, C=16, g=1`) the learned
reservation is the only *implementable* policy that gets **full utilisation and ~4 aborts** — matching
the clairvoyant oracle — where greedy streaming aborts 16 and reserve-max collapses to `0.40`
utilisation; overshoot stays `0` for every reservation policy.

### Layer 3 — Learning-augmented with output-length predictions ⇒ consistency/robustness

Per-request output-length **predictions** exist and work: exact length is infeasible, but the relative
*rank* is predictable (vLLM "Learning to Rank", NeurIPS'24). Feed a predicted length `ĉ` as the
reservation, arbitrated by a Hedge meta-learner over {follow-prediction, robust-quantile} — GALE's
Pillar 3 verbatim. **Consistency** (good predictions ⇒ near-clairvoyant admission/utilization),
**robustness** (adversarial predictions ⇒ the no-regret quantile), and **safety unconditional** (the
streaming meter holds `Δ ≤ g−1` no matter how wrong the predictor is — to our knowledge the first
predictions-with-safety result for token *budgets*, instantiating the known newsvendor / predictions-with-safety machinery (§5) on the cost axis).

**Implemented + measured** (`test/cost/predicted-reservation.ts`). The predictor is modelled on the
LtR reality: it recovers output-length *rank* (with tunable noise) and maps ranks back through the
calibrated length distribution — not implausible magnitude guesses. Perfect advice drives cost to
~clairvoyant (`0.0003×` the robust cost) with weight → follow; a good rank-predictor (noise 0.1) cuts
cost 62%; adversarial advice (anti-correlated rank) falls back to the robust quantile (`1.00×`,
weight → robust) versus `2.14×` for blindly obeying it. Safety is unconditional: under good *or*
adversarial predictions — and even when *blindly following* an anti-correlated predictor — the meter
holds overshoot at `0` (g=1) / `≤ g−1` (chunked), independent of slots and of the predictor.

### Capstone — the cost-axis trilemma, and unification with GALE

The same three-way tension reappears on the cost axis: **overshoot** (Δ), **utilization** (sterilised
budget), and **reconciliation/abort overhead** (how often you meter or preempt streams). Reserve-max
kills utilization; admit-then-count kills the overshoot bound; per-token metering maximises
reconciliation overhead. We conjecture a lower bound of the GALE form tying the three, with streaming
escrow as the Pareto point — and a single **"escrow under uncertainty"** framework subsuming both
papers: GALE escrows across the **distribution** axis (which node will need budget), TALE across the
**cost/time** axis (how much a request will spend). Same mechanism (reserve, meter actuals, reconcile
at the boundary), two uncertainties. This unification is no longer just framing: the distributed
multi-gateway token meter reduces *byte-identically* to GALE window-coupled leasing (§ 4), so the
fleet-size-independent overshoot bound carries over to TPM sharing for free.

## 4. Evaluation plan (to match GALE's measured artifact)

Seeded discrete-event simulator over **heavy-tailed output-length traces** (log-normal / Zipfian, the
empirically-reported shape), `C` concurrent streams against budget `L`. Schemes: `reserve-max`,
`admit-then-count`, `streaming(g)`, `streaming + learned-reservation`, `+ predictions`. Metrics:
overshoot Δ, utilization, 429-rate on admissible traffic, reconcile round trips, and (Layer 3)
cost-vs-clairvoyant under good/adversarial predictors. Headline: streaming is the only scheme with
both bounded Δ (independent of `max_tokens`) and utilization ≈ 1; the learned/predicted layers cut the
429-rate toward clairvoyant. **Distributed instantiation — done + machine-checked**
(`test/cost/distributed-budget.ts`): the meter *is* a GALE leased budget whose unit is tokens, so
multi-gateway TPM sharing inherits the window-coupled fleet-size-independent bound. Measured across
`C ∈ {1..32}` gateways sharing one TPM budget — window-coupled global overshoot stays `0` independent
of `C` (vs carryover's `C·(B−1)`, which grows with the fleet), at full utilisation — and the
window-coupled token budget is *byte-identical* to GALE's request-granular `simulateWindowCoupled`.

## 5. Venue & positioning

- **Primary: SIGMETRICS / POMACS or NSDI/OSDI** (systems-measurement; LLM serving is a hot track).
  Theory-lead alternative: the cost-axis trilemma at PODC/SODA. ML-systems: MLSys.
- **Must-cite / must-beat.** *Production:* Azure APIM `llm-token-limit` (reserve-max + credit-back),
  LiteLLM dynamic TPM/RPM, Kong / Zuplo / Portkey / agentgateway (admit-then-count, overshoot conceded, no bound). LiteLLM was **measured at 6.6× overshoot** (issue #18730); Zuplo states *the request that pushes you over the budget completes successfully*; Azure `llm-token-limit` is explicitly *non-aggregating across gateways*. Every one sits at corner 1 (reserve-max) or corner 2 (admit-then-count, unbounded). *Scheduling
  under unknown length:* Fu et al., **Efficient LLM Scheduling by Learning to Rank**, NeurIPS'24 (the
  predictor; they optimise *latency* via SJF, we optimise *budget overshoot* — complementary). Adjacent scheduling-under-unknown-length work — reorders for latency/SLO, does **not** bound a token budget: **Scheduling the Unschedulable** (arXiv 2604.06970), **Argus** (2512.22925), Uncertainty-Aware Output-Length scheduling (2604.00499). *Theory:*
  Bandits-with-Knapsacks (Badanidiyuru et al.; adversarial BwK, JACM'22), Online Knapsack with
  Departures, anytime-knapsack (2025); **the newsvendor-with-predictions / online-allocation-with-predictions machinery that L2/L3 instantiate (cite, not claim):** An, Li, Moseley & Ravi, *The Nonstationary Newsvendor with (and without) Predictions* (arXiv 2305.07993 — newsvendor + predictions-with-safety, the joint framework behind L2+L3); *Best of Many in Both Worlds* online allocation with predictions (2402.13530); *Capacity-Constrained Online Learning with Delays* (2503.19856, COLT'25); Yang et al. Replenishable Budgets (SIGMETRICS'24). *Framework:*
  GALE (this repo) and the escrow lineage (O'Neil; Balegas bounded counters).
- **Distinction.** Scheduling work reorders a fixed budget for latency; we *bound the budget overshoot*
  under post-hoc costs with a tight, `max_tokens`-independent guarantee — and make it safe under any
  predictor. **Honest scope:** L2 (newsvendor critical-fractile via OGD) and L3 (Hedge predictions-with-safety) are *known machinery applied to the cost axis* — we cite the newsvendor / online-allocation-with-predictions line above and claim only the token-streaming-reconciliation instantiation plus its unconditional-safety coupling to L1. The load-bearing novelty is **L1's tight, `max_tokens`-independent overshoot bound** (and its byte-identical reduction to GALE leasing). We are aware of no prior work — system or paper — that states such a bound.

## 6. Why now

TPM budgets are the real operational constraint for every LLM gateway in production (2024–2026), and
they are enforced today by exactly the two corner heuristics above. A May-2026 position paper — *LLM Serving Needs Mathematical Optimization and Algorithmic Foundations* (arXiv 2605.01280) — argues precisely this: deployed serving leans on heuristics that ignore the unknown-output-length structure and lack provable guarantees. A provable, learned, prediction-
augmented alternative — reusing a framework we've already machine-checked — is both timely and a clean
second paper. **Status:** all three layers *plus the distributed instantiation* are implemented,
proven, and gated under `test/cost/` (the measured results above; the multi-gateway meter reduces
byte-identically to GALE's leased mechanism). The write-up is the remaining work.
