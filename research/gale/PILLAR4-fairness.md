# Pillar 4 — Weighted, work-conserving fairness across tenants (Weighted Fair Escrow)

*Design + proofs for GALE's fairness layer. Implemented in `test/gale/fair-escrow.ts`; properties
gated in `test/gale/fair-escrow.test.ts`; measured in `research/gale/EVALUATION.md` (Workload C).*

## The gap (distinct from Pillars 1–2)

Pillars 1–3 fix the **total**: how many credits exist (safety, `Δ = 0` independent of `N`), how big
each lease is (efficiency), and how that adapts (predictions). They say nothing about **the split** —
*which* node gets the next credit when the budget is contended. Single-pool leasing splits it
**first-come-first-served**: whoever leases first, or leases biggest, wins. Under multi-tenant
overload that is *work-conserving but weight-blind* — a low-priority tenant that floods can starve a
high-priority one below its configured share. The two incumbent fixes each fail an axis:

| split policy | honors weights? | work-conserving? | overshoot |
|---|:--:|:--:|:--:|
| static weighted share `gᵢ = ⌊wᵢ/W · L⌋` | ✓ | ✗ — idle tenant's share is stranded | 0 |
| FCFS / weight-blind leasing (GALE P1–2) | ✗ — splits by who-leases-most | ✓ | 0 |
| **Weighted Fair Escrow (this pillar)** | **✓** | **✓** | **0** |

Max-min fair sharing yields strictly higher utilisation than static equal sharing under skew
(standard result); the open part is getting it **with** a hard overshoot bound and low coordination,
over the escrow-lease abstraction, using only the shared store (no central arbiter à la Pisces).

## Model

One L2 window, integer budget `L`. Nodes `1..N` with integer weights `wᵢ ≥ 1`, `W = Σ wᵢ`. Node `i`
offers demand `dᵢ ≥ 0` this window. Window-coupling (Pillar 1) makes credits expire at the boundary,
so **`Σᵢ (credits granted) ≤ L ⟹ Σ admitted ≤ L ⟹ Δ = 0`, independent of `N`**. Pillar 4 changes only
*which* node is granted the next credit, never the total — so the safety bound is inherited verbatim.

Guaranteed weighted share: `gᵢ = ⌊(wᵢ/W)·L⌋`.

## Ideal — weighted max-min fair allocation (water-filling)

`a*` is the allocation that lexicographically maximises the sorted vector of normalised allocations
`aᵢ/wᵢ` subject to `0 ≤ aᵢ ≤ dᵢ` and `Σ aᵢ ≤ L`. It is computed by **water-filling**: raise a level
`λ`, set `aᵢ(λ) = min(dᵢ, wᵢ·λ)`, and increase `λ` until `Σ aᵢ = L` (overload) or every `aᵢ = dᵢ`
(feasible). `waterfill(d, w, L)` in `fair-escrow.ts` computes the integer version exactly.

## Mechanism — Weighted Fair Escrow (WFE)

WFE is **Deficit Round Robin over the lease stream**, with the lease size as the DRR *quantum* and the
shared budget counter as the only coordination state:

1. Each node may hold outstanding credits up to a **fair ceiling** `cᵢ`, initialised to `gᵢ`.
2. A node leases (a round trip) only while `granted_i < cᵢ` **and** budget remains; each grant is
   `min(sizeᵢ, l2, cᵢ − granted_i)`, decrementing the shared `l2`.
3. **Reclamation:** budget a node does not claim (because `dᵢ < cᵢ` — it went idle) is redistributed
   to still-backlogged nodes in proportion to weight, raising their ceilings. Iterating reclamation to
   its fixed point *is* water-filling — so the realised split equals `a*` up to one quantum per node.

The store holds one integer (`l2`) plus the per-key lease record it already keeps — **no per-tenant
queues, no central controller.** This is the core-stateless spirit of CSFQ (Stoica et al., SIGCOMM'98)
applied to escrow leasing.

## Theorems

Let `a` be WFE's realised allocation, `q` the lease quantum (granularity).

- **T1 — Safety (inherited).** `l2` starts at `L` and only decreases, and no grant exceeds it, so
  `Σ aᵢ ≤ L`. With window-coupling, global admissions `≤ L`, **`Δ = 0`, independent of `N`.** Pillar 4
  reorders *who* gets credits; it cannot raise the total. *(Composition with Pillar 1.)*

- **T2 — Sharing incentive / no starvation.** `aᵢ ≥ min(dᵢ, gᵢ)` for every node: WFE node-wise
  **dominates the static weighted share.** *Proof.* If `Σd ≤ L`, water-filling gives `aᵢ = dᵢ`. Under
  overload it stops at level `λ*` with `Σ min(dᵢ, wᵢλ*) = L`. Suppose `a_k < min(d_k, g_k)`. Then
  `a_k < d_k`, so `a_k = w_k λ*`, so `w_k λ* < g_k ≤ w_k L/W`, i.e. `λ* < L/W`. But then every
  `aᵢ = min(dᵢ, wᵢλ*) ≤ wᵢλ* < wᵢ L/W`, so `Σ aᵢ < (L/W)Σwᵢ = L`, contradicting `Σ a = L`. ∎

- **T3 — Work-conservation / Pareto efficiency.** `Σ aᵢ = min(Σd, L)`: full utilisation when feasible,
  and under overload all `L` is allocated — no budget is stranded while a backlogged node sits below
  its fair share. WFE realises this to within one quantum `q` per node. *(Water-filling definition; the
  realised gap is the DRR rounding.)*

- **T4 — Bounded unfairness (DRR/GPS analog).** For any two nodes continuously backlogged through the
  window, `|aᵢ/wᵢ − aⱼ/wⱼ| ≤ q·(1/wᵢ + 1/wⱼ)` — **bounded by the quantum, independent of window length
  or demand magnitude.** This is the Shreedhar–Varghese relative-fairness bound with the lease size as
  the quantum; bigger adaptive leases (Pillar 2) trade a looser fairness bound for fewer round trips.

- **T5 — The FairRide concession (honesty, not a win).** Under the isolation guarantee (T2),
  FairRide's impossibility (Pu et al., NSDI'16) precludes being simultaneously **strategy-proof** and
  **Pareto-efficient**. WFE takes the **sharing-incentive + work-conserving** corner, so it is **not
  strategy-proof**: a tenant can over-declare demand to claim surplus. Window-coupling bounds the gain —
  inflated credits beyond true demand are stranded and expire (no carryover), costing the liar
  utilisation next window — but we claim no strategy-proofness. (FairRide takes the other corner:
  strategy-proof + isolation, conceding a little efficiency. Same triangle, different vertex.)

## Composition with the rest of GALE

Fairness is **orthogonal to and composable with** Pillars 1–3, by construction: P1–3 decide the *total*
credits and the *lease size*; P4 decides the *split* and never touches the total. So WFE keeps `Δ = 0`
(T1), inherits Pillar-2 adaptive sizing (the quantum), and is safe under Pillar-3 predictions
unconditionally. The trilemma is unaffected — it bounds overshoot vs coordination vs utilisation; P4
adds a fairness guarantee *within* the work-conserving utilisation that the trilemma already requires
coordination to reach.

## Scope / honesty

- **Not strategy-proof** (T5) — the conceded vertex; stated, not hidden.
- The simulator computes the split via water-filling (the DRR fixed point) and counts the weighted lease
  round trips; it does **not** model an online adversary reordering requests within a window. The
  `≤ q`-per-node realised-vs-ideal gap is the DRR rounding, measured in `fair-escrow.test.ts`.
- WFE is a **research module + simulator scheme** (like Pillars 2–3), not yet shipped in `src/twotier`
  (Pillar 1's `windowCoupled` is the only shipped piece). Promoting WFE to the store — a weighted
  variant of the lease grant — is noted as future work.
- ~~Single global pool; hierarchical/nested weights (tenants-within-regions) are a clean extension,
  not modelled here.~~ → **modelled + shipped** as Federated WFE (TK-1404); see below.

## Federated composition — hierarchical weights across regions (TK-1404, #176)

The open extension above: tenants distributed across **regions**, drawing from one global budget `L`,
where each tenant's **global** total (summed over its regions) should be the weighted-max-min split a
single flat WFE over `L` would give — the regions being plumbing, not a fairness boundary. Shipped as
`federatedWeightedFairEscrow` + `regionFairPool` in `src/twotier`; the machine-checked gate is
`research/bigger-bets/federation/federated-wfe-gate.ts`.

**Why it is not automatic.** Hierarchical max-min fairness is in general **not** flat max-min fairness:
running WFE per region over a budget shared by a plain FCFS counter gives per-region *isolation* (HLS,
Saeed et al., arXiv:2108.09864) — a tenant penalised for *which* region it lives in. The collapse
condition is the Parekh–Gallager GPS decomposition: an internal node weighted by the **sum of its
children's weights** reproduces the flat allocation. The mechanism realises it as **two composed WFEs**:

1. **Cross-region WFE** (`regionFairPool`): a weighted-fair *reservation* layer whose "tenants" are
   regions; region `r`'s weight is its **dynamic active aggregate** tenant weight `W_r = Σ w_{t,r}`. It
   guarantees region `r` at least `⌊W_r/ΣW·L⌋` (reserved — a plain counter cannot reserve, the root of
   the isolation gap) and lets it borrow idle regions' surplus.
2. **In-region WFE** (per tenant): the same `decide` arithmetic splits each region's granted budget.
3. **Demand-proportional weight-split** for a region-spanning tenant: `w_{t,r} = w_t·d_{t,r}/d_t` (so
   `Σ_r w_{t,r} = w_t`); the full `w_t` in every region double-counts it (over-served ≈k×).

**Theorems** (let `q_R` = the region-level lease quantum, `span(t)` = #regions `t` is active in):

- **T-FED-1 — Safety.** The pool grants `Σ_r (region budget) ≤ L` and in-region WFE serves
  `Σ_t used ≤` the region budget, so `Σ admitted ≤ L` globally, independent of region count
  (`Δ = 0`, inherited). Mutual reservation `granted_r ≤ L − Σ_{j≠r} max(granted_j, g_j)` makes the
  cross-region sum bound inductive; `l1.maxKeys` eviction folds evicted credits into `evictedUsed`
  so the bound survives unbounded unique-tenant input.
- **T-FED-2 — Fluid exactness.** Under the three conditions, the per-tenant global total equals the
  flat global weighted-max-min ideal **exactly in the fluid limit**. *Proof:* the streaming mechanism's
  fluid limit is a single water-fill over the leaves `(t,r)` (region rate ∝ backlogged leaf weight ⟹
  one global level `λ*`); demand-proportional split makes the flat per-tenant service distribute as
  `s_{t,r}=min(d_{t,r},w_{t,r}λ*)`, summing to `a*_t`. ∎ (Machine-checked: 0 deviation on 4 structured
  + 400 random worlds.)
- **T-FED-3 — Bounded discrete error.** With discrete granting, `|a_t − a*_t| ≤ span(t)·(2·q_R+1)` —
  a two-level DRR residual (per-leaf: ≤ `q_R` region-scheduling overshoot + ≤ `q_R` budget-boundary
  slack + 1 in-region drip; `w_leaf ≤ W_r` ⟹ ≤ `2q_R+1` per leaf, ×span). Verified `q_R`-linear
  (worst 2→12→22 at `q_R=1→8→16`), ≈0.02% relative — the two-level analog of H-PFQ's per-level
  deficit (Bennett–Zhang, ToN'97; HLS Lemma 5).

**The failure boundary** (each lit up materially in the gate, proving the conditions are necessary):
**F1** fixed/equal region weights → HLS isolation (dev 268); **F2** full-weight replication →
double-count (2×); **F3** static batch (constant `W_r`, `D_r`) → fails on mixed-bottleneck regions
(min-of-sums ≠ sum-of-mins, dev 14); **F4** no reclamation → idle surplus stranded (dev 145).

**Scope / honesty (the streaming gap, inherited from in-region T3).** The fluid exactness assumes full
reclamation. The shipped *streaming* code reserves an **active** participant's guarantee until the
window rolls, reclaiming only from **truly-absent** regions — so under **mixed saturation** (a region
with a demand-bottlenecked co-tenant) the realised split follows the hierarchical weighted shares and
strands the saturated participant's reserve, deviating from the *clairvoyant* fluid oracle by the
saturated weight fraction. This is **identical to in-region WFE T3** (realised between truly-absent,
not paused, participants) — and it equals what a **flat streaming WFE** does, the realizable target. No
streaming limiter can match the clairvoyant oracle without a demand oracle. Exactness holds in the
all-backlogged regime (the common overload case); the gate's Part 5 confirms the shipped code matches
the flat oracle there within a few credits and never over-admits. Decision records: **DR-P4-7**
(federate WFE) and **DR-P4-8** (hierarchical weights) — both flipped to *shipped*; **DR-FWFE-1** the
store-backed multi-process pool (the weighted analog of `RegionalEscrow`'s Lua) as the production path,
staged like WFE's L1→L2.

## Anchors

- Shreedhar & Varghese, **Efficient Fair Queuing using Deficit Round Robin**, SIGCOMM'95 — the quantum
  discipline and its fairness bound (T4).
- Demers, Keshav & Shenker, **WFQ**, SIGCOMM'89; Parekh & Gallager, **GPS**, ToN'93 — the ideal
  weighted max-min fluid model that DRR/WFE approximate.
- Stoica, Shenker & Zhang, **Core-Stateless Fair Queueing**, SIGCOMM'98 — fairness with O(1) core state;
  WFE is its escrow-leasing analog (one shared integer, no per-tenant queues).
- Shue, Freedman & Shaikh, **Pisces**, OSDI'12 — fairness-under-skew with a *central* controller; we
  remove it. Ghodsi et al., **DRF**, NSDI'11 — multi-resource (we are single-resource → weighted
  max-min is the right frame). Pu et al., **FairRide**, NSDI'16 — the SIP impossibility (T5).
