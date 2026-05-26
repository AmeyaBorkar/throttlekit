# Escrow under Cost Uncertainty: Provable Token-Budget Rate Limiting for LLMs

*A research proposal / paper skeleton — the cost-axis sibling of [GALE](../gale/PROPOSAL.md). Working
title acronym **TALE** (Temporally-Accounted Learned Escrow) is a placeholder.*

> **One-line thesis.** Classical rate limiting assumes a request's cost is known at admission. LLM
> serving breaks that: the binding limit is **tokens-per-minute (TPM)**, and the dominant cost —
> *output* tokens — is revealed only *during/after* generation. We treat token-budget rate limiting as
> **escrow under cost uncertainty**: reserve a cost at admission, reconcile when the truth is revealed.
> We give the first scheme with a **tight, provable overshoot bound independent of `max_tokens`** —
> via a *streaming meter* that is the cost-axis analog of GALE's window-coupling — plus an online
> learned reservation and a predictions-with-safety layer that reuses GALE's machinery.

> **Status.** Design + validated-open. The streaming-meter bound and the baseline contrasts are
> specified here and slated for a machine-checked + measured kernel (`test/cost/`), mirroring the GALE
> pillars. Nothing implemented yet — this is the scoping artifact.

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
   max_tokens`, unbounded in `max_tokens`**, with no stated bound.

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

- **Theorem (Safety).** Worst-case overshoot `≤ C · (g − 1)`, where `C` is the max concurrent in-flight
  streams — **independent of `max_tokens`**. Per-token metering (`g = 1`) ⇒ overshoot `0`; chunked
  metering trades a small bounded overshoot for fewer budget round trips. Utilization `→ 1` (no
  reservation is sterilised).
- **Contrast (the two corners).** *Reserve-max:* overshoot `0`, utilization `E[c]/max_tokens` (≈5% on
  heavy-tailed traces). *Admit-then-count:* utilization `1`, overshoot `≤ C·(max_tokens−1)` (unbounded
  in `max_tokens`). Streaming dominates both: `Δ = C·(g−1)`, util `→ 1`.

### Layer 2 — Learned reservation ⇒ admit-time decisions without over-reserving

The meter bounds overshoot, but *admission* still needs a per-request reservation `r` (to decide the
429 and to pace concurrency). Over-reserve (`r = max_tokens`) and you needlessly 429 admissible
traffic; under-reserve and you over-admit. Pick `r` as a **learned quantile** of the output-length
distribution and reconcile the residual against the streaming meter. This is GALE's Pillar 2 on the
cost axis: an online learner (AdaGrad / quantile-tracking) minimising a convex admission cost
(false-429 vs over-admit), with `O(√T)` regret; safety is unconditional because the *meter* (Layer 1),
not the reservation, enforces `L`.

### Layer 3 — Learning-augmented with output-length predictions ⇒ consistency/robustness

Per-request output-length **predictions** exist and work: exact length is infeasible, but the relative
*rank* is predictable (vLLM "Learning to Rank", NeurIPS'24). Feed a predicted length `ĉ` as the
reservation, arbitrated by a Hedge meta-learner over {follow-prediction, robust-quantile} — GALE's
Pillar 3 verbatim. **Consistency** (good predictions ⇒ near-clairvoyant admission/utilization),
**robustness** (adversarial predictions ⇒ the no-regret quantile), and **safety unconditional** (the
streaming meter holds `Δ ≤ C·(g−1)` no matter how wrong the predictor is — the *first*
predictions-with-safety result for token budgets).

### Capstone — the cost-axis trilemma, and unification with GALE

The same three-way tension reappears on the cost axis: **overshoot** (Δ), **utilization** (sterilised
budget), and **reconciliation/abort overhead** (how often you meter or preempt streams). Reserve-max
kills utilization; admit-then-count kills the overshoot bound; per-token metering maximises
reconciliation overhead. We conjecture a lower bound of the GALE form tying the three, with streaming
escrow as the Pareto point — and a single **"escrow under uncertainty"** framework subsuming both
papers: GALE escrows across the **distribution** axis (which node will need budget), TALE across the
**cost/time** axis (how much a request will spend). Same mechanism (reserve, meter actuals, reconcile
at the boundary), two uncertainties.

## 4. Evaluation plan (to match GALE's measured artifact)

Seeded discrete-event simulator over **heavy-tailed output-length traces** (log-normal / Zipfian, the
empirically-reported shape), `C` concurrent streams against budget `L`. Schemes: `reserve-max`,
`admit-then-count`, `streaming(g)`, `streaming + learned-reservation`, `+ predictions`. Metrics:
overshoot Δ, utilization, 429-rate on admissible traffic, reconcile round trips, and (Layer 3)
cost-vs-clairvoyant under good/adversarial predictors. Headline: streaming is the only scheme with
both bounded Δ (independent of `max_tokens`) and utilization ≈ 1; the learned/predicted layers cut the
429-rate toward clairvoyant. Distributed instantiation: the meter *is* a GALE leased budget whose unit
is tokens, so multi-gateway TPM sharing inherits the window-coupled fleet-size-independent bound too.

## 5. Venue & positioning

- **Primary: SIGMETRICS / POMACS or NSDI/OSDI** (systems-measurement; LLM serving is a hot track).
  Theory-lead alternative: the cost-axis trilemma at PODC/SODA. ML-systems: MLSys.
- **Must-cite / must-beat.** *Production:* Azure APIM `llm-token-limit` (reserve-max + credit-back),
  LiteLLM dynamic TPM/RPM, Portkey / agentgateway (after-count, admits the overshoot). *Scheduling
  under unknown length:* Fu et al., **Efficient LLM Scheduling by Learning to Rank**, NeurIPS'24 (the
  predictor; they optimise *latency* via SJF, we optimise *budget overshoot* — complementary). *Theory:*
  Bandits-with-Knapsacks (Badanidiyuru et al.; adversarial BwK, JACM'22), Online Knapsack with
  Departures, anytime-knapsack (2025); Yang et al. Replenishable Budgets (SIGMETRICS'24). *Framework:*
  GALE (this repo) and the escrow lineage (O'Neil; Balegas bounded counters).
- **Distinction.** Scheduling work reorders a fixed budget for latency; we *bound the budget overshoot*
  under post-hoc costs with a tight, `max_tokens`-independent guarantee — and make it safe under any
  predictor. No prior work states such a bound.

## 6. Why now

TPM budgets are the real operational constraint for every LLM gateway in production (2024–2026), and
they are enforced today by exactly the two corner heuristics above. A provable, learned, prediction-
augmented alternative — reusing a framework we've already machine-checked — is both timely and a clean
second paper. **Next step:** the Layer-1 kernel (`test/cost/`) — the streaming-meter bound, measured
against the two corners on heavy-tailed traces, gated like the GALE pillars.
