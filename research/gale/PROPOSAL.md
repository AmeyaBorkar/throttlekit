# GALE: Globally-Accounted Learned Escrow for Distributed Rate Limiting

*A research proposal / paper skeleton built on ThrottleKit. Working title and acronym are placeholders.*

> **One-line thesis.** Distributed rate limiting is *escrow under uncertainty*: every system must decide, online and per-node, how much of a shared global budget to hold locally — trading coordination cost against overshoot (safety) and stranded capacity (utilization). For ~18 years the field has resolved this with static, hand-tuned shares that are provably wrong under skewed, non-stationary demand. We give the first scheme that is simultaneously **overshoot-bounded independent of fleet size**, **work-conserving**, **low-coordination** (a shared atomic store, no gossip), and **online-adaptive with a regret guarantee** — and recast the resulting three-way tradeoff as a **trilemma** whose *tight achievability* is window-coupled leasing — an honest **framing** result, not a claim of new impossibility: the zero-coordination bound is elementary, and complementary to the classical monitoring lower bounds (Cormode–Muthukrishnan–Yi; Woodruff–Zhang) that price coordination itself.

> **Status (this artifact).** Pillar 1 (safety) and the trilemma lower bound are **machine-checked**, and Pillar 1 is **shipped** in `src/twotier` (`lease.windowCoupled`). Pillars 2–3 are **implemented and empirically validated** (the regret/consistency bounds follow from standard OGD/AdaGrad and Hedge analyses on the convex per-window cost; the figures are measured). Pillar 4 (fairness) is **implemented, proven, and measured** — four theorems machine-checked on random instances + a measured multi-tenant contrast. The evaluation is **measured**. All work is gated (lint + strict types + tests + build) and merged to `main`. Per-pillar pointers below.

---

## 1. The problem (real, and validated as open)

A single global rate limit `L` must be enforced across `N` distributed nodes. Two incumbent approaches, both unsatisfying:

1. **Central store per request** (Stripe, Figma, Lyft global stage): a Redis/DB counter is consulted on every request. It is a latency bottleneck and a SPOF — and is often *not even atomic by default* (Figma reports a read-modify-write race that admits **~2× the intended rate**).
2. **Static / heuristic local shares or leases** (DRL/FPS, Doorman, DynamoDB GAC, AdapTBF): each node enforces locally from a pre-assigned or leased share. Cheap, but the share is wrong under skew — an idle node's slice is stranded while a hot node is throttled — and **none bounds global overshoot**.

We surveyed the systems, theory, and fairness literatures (see §8). The decisive finding:

**No deployed or published distributed rate limiter has a hard, tight, all-time bound on global overshoot.**

| Scheme | Overshoot guarantee | What it actually proves |
|---|---|---|
| DRL / FPS — Raghavan et al., SIGCOMM'07 | ✗ worst-case **N×** | equilibrium fixed-point stability only |
| GDRL — Stanojevic & Shorten, IWQoS'09 | ✗ equilibrium-only conservation | geometric *consensus* convergence |
| Doorman — Google, SREcon'16 | ✗ documents **106%** in its own sim | "the configured max is not a hard limit" |
| DynamoDB GAC — Elhemali et al., ATC'22 | ✗ empirical | proportional shares, no proof |
| AdapTBF / AI-token leasing — 2026 | ✗ "future work" | adaptive borrowing, empirical |
| **ThrottleKit `leased` (this repo)** | ✓ `L + N·(B−1)` (TLA⁺/TLC) | **but grows with N; fixed, hand-tuned B** |

ThrottleKit is the *only* one with any proven bound — and even it scales with fleet size `N` and depends on a hand-tuned lease batch `B`. **That is the gap.**

## 2. The key insight

ThrottleKit's own formal model (`spec/DistributedLeasing.tla`) proves overshoot equals **credits that are held-but-unused and survive the L2 window boundary**. That exact quantity, viewed from the other side, is **stranded capacity** — budget an idle node denies to a busy one.

> **Stranded capacity *is* overshoot debt.** They are one quantity. Minimizing held-but-unused credits *simultaneously* tightens overshoot and raises utilization — they are not in tension. The only genuine tension is *holding few credits* vs. *coordination cost* (more round trips). That single tension, made precise, is the trilemma.

This observation does not appear in the surveyed literature and reframes the whole design space.

## 3. The contribution

A decentralized limiter coordinated **only** through the existing shared atomic store (Redis Lua / Postgres transaction) — **no gossip** — in four provable layers plus a capstone.

### Pillar 1 — Window-coupled / escrow-accounted leasing ⇒ overshoot independent of N  ✅ *machine-checked*

Couple credit lifetime to the L2 window (credits expire at the boundary) and/or have the L2 escrow-account outstanding grants. This kills the carryover that is the sole source of overshoot.

- **Theorem (Safety).** Per-window global admissions ≤ **L**, *independent of N* — vs. the prior tight `L + N·(B−1)`.
- **Status: ✅ machine-checked AND shipped.** Bounded model check (see §4) in `spec/GaleWindowCoupledLeasing.tla` + its CI-gated Java-free twin `test/gale/leasing-variants.test.ts`; the mechanism ships as the opt-in `lease.windowCoupled` in `src/twotier/index.ts` (contrast test in `test/twotier/window-coupled.test.ts`: legacy admits `K + L·(B−1)`, window-coupled admits exactly `K`).
- **Cost (a liveness/efficiency property, not safety):** a busy node re-leases once per window boundary and forfeits credits it still held — a bounded near-boundary utilization dip that Pillar 2 minimizes.

### Pillar 2 — Online lease sizing ⇒ minimize coordination at fixed safety

The lease size is no longer a knob. The per-window cost is the **EOQ cost** `c·D/b + h·b/2` — expected coordination (`c` per round trip, `≈D/b` of them) plus expected holding/stranding (`h` per idle credit, average inventory `≈b/2`) — minimized at `b* = √(2cD/h)`. Demand `D` is unknown and non-stationary but **observed each window** (full information), so each node runs **AdaGrad in log-space** on this convex loss. Design + proof sketch: `research/gale/PILLAR2-lease-sizing.md`.

- **Theorem (Regret).** Standard OGD/AdaGrad analysis on the convex per-window cost gives static regret `O(√T)` vs. the best fixed lease in hindsight (dynamic `O(√(T(1+P_T)))` under comparator drift). Crucially, **the Pillar-1 safety bound holds for *any* lease sizes**, so learning tunes efficiency and can never breach the cap — a *tight per-window hard* cap, vs. Yu–Neely's *long-run* `O(1)` violation.
- **Status: ✅ implemented + empirically validated** (`test/gale/lease-sizer.test.ts`). Measured: average regret/round falls 18.6 → 0.40 as `T` grows (sublinear); the learner tracks `b*` to <1% (62.6 vs 63.25); under an adversarial demand wave it *beats* the best fixed lease by ~10%; competitive with the EWMA plug-in. `h` is the coordination↔utilization dial (see §6).

### Pillar 3 — Learning-augmented with demand predictions ⇒ consistency/robustness, safety-preserving

A **Hedge meta-learner over two experts** — *follow-the-prediction* (`b = √(2cD̂/h)` for predicted `D̂`) and *robust* (the Pillar-2 learner) — playing the weighted-average size (Jensen-sound). Design: `research/gale/PILLAR3-predictions.md`.

- **Theorem (Predictions).** Hedge's `O(√T)` regret to the best expert gives **consistency** (cost → the offline optimum when predictions are good) and **robustness** (cost → the no-regret learner when they are adversarial); the hard overshoot bound holds **unconditionally**, since predictions set only the *requested* lease and the escrow store still gates it. To our knowledge the **first predictions-with-safety result for distributed rate limiting** (cf. Yang et al. SIGMETRICS'24: centralized, no leasing).
- **Status: ✅ implemented + measured** (`test/gale/predictive-sizer.test.ts`). On a drift trace: perfect predictions give cost/clairvoyant = **1.000** (consistency); adversarial predictions give cost/robust = **1.000** and far below blindly obeying the oracle (robustness); the Hedge weight concentrates (>0.8) on the right expert; and per-window admitted ≤ L even under adversarial predictions (safety unconditional).

### Pillar 4 — Weighted, work-conserving fairness across tenants (Weighted Fair Escrow)  ✅ *proven + measured*

Pillars 1–3 fix the *total* credits; they say nothing about the *split* when the budget is contended. Single-pool leasing splits it first-come-first-served — equivalently **unweighted** max-min — so a low-priority flood starves a high-priority tenant below its configured share. **Weighted Fair Escrow (WFE)** makes the split the **weighted max-min fair** allocation (water-filling) with idle-share reclamation, using only the shared store (vs. Pisces's central controller; the core-stateless spirit of CSFQ). Design + proofs: `research/gale/PILLAR4-fairness.md`.

- **Theorems.** *T1 (safety, inherited):* the split never changes the total, so `Σ ≤ L` and `Δ = 0` independent of N. *T2 (sharing incentive):* every backlogged tenant gets ≥ its guaranteed weighted share `⌊wᵢ/W·L⌋` — WFE node-wise dominates the static share. *T3 (work-conservation):* `Σ = min(ΣD, L)` — no budget stranded while a tenant is backlogged. *T4 (bounded unfairness):* normalised service `|aᵢ/wᵢ − aⱼ/wⱼ|` is bounded by the lease quantum (the Shreedhar–Varghese DRR bound). All four **machine-checked on 20 000 random instances** (`test/gale/fair-escrow.test.ts`).
- **The honest concession (T5).** Under the share guarantee, FairRide's impossibility (NSDI'16) precludes also being strategy-proof and work-conserving; WFE takes the sharing-incentive + work-conserving corner and is **not strategy-proof** (window-coupling bounds the gain from over-declaring demand). Stated, not hidden.
- **Status: ✅ implemented + measured** (`test/gale/fair-escrow.ts`). Workload C (one weight-4 tenant + three weight-1 flooders, the weight-4 idle every 5th window): WFE is the **only** split good on every axis — utilisation 1.000 (matches weight-blind leasing) and 0 share violations (matches static), beating static's 0.876 utilisation and weight-blind's 21% violations, at the **same coordination** (fairness is free). See §6 / `EVALUATION.md` Workload C.

### Capstone — The Rate-Limiting Trilemma (theory headline)  ✅ *proven + machine-checked*

- **Theorem (Trilemma, zero-coordination regime).** Any protocol that pre-authorizes per-node budgets and admits with **no inter-node coordination** suffers, against a worst-case demand adversary, overshoot `Δ = (ΣB − L)⁺` and under-utilization `U = (L − min B)⁺`, hence **`Δ + N·U ≥ (N−1)·L`, tight** (uniform allocation). So at `C = 0` you cannot make both overshoot and under-utilization small. **Coordination is the only escape — exactly what GALE spends** to reach `Δ = 0, U ≈ 0`. Proof + the two ruinous corners + the counting/monitoring bounds that price coordination itself (Wattenhofer–Widmayer JPDC'98; Cormode–Muthukrishnan–Yi SODA'08; Woodruff–Zhang STOC'12): `research/gale/TRILEMMA.md`. **Positioning (honest):** the zero-coordination bound is **elementary** — a one-line averaging argument, general in `N` (the `N ∈ {2,3,4}` check is corroboration, not the proof's ceiling). It is **complementary to, not a corollary of**, the CMY / Woodruff–Zhang monitoring bounds, which price the orthogonal *coordination-cost* (`Δ–C`) edge — neither implies the other. The contribution is therefore the **design-space framing** plus the **tight achievability**: window-coupled leasing reaches the good corner (`Δ = 0`) with bounded coordination, which the monitoring literature does not give. The remaining theory depth is the partial-coordination (`0 < C < N`) interpolation, not the `C = 0` bound. Exhaustively machine-checked for `N ∈ {2,3,4}` (bound holds on every allocation + tightness) in `test/gale/trilemma.test.ts`.

## 4. The machine-checked keystone (already done)

`test/gale/leasing-variants.test.ts` is an exhaustive BFS over the leasing transition system, a CI-gated vitest twin of `test/twotier/leasing-model.test.ts`. It self-validates, then proves Pillar 1 (the asserted facts):

```
=== 1. Harness validation: reproduce committed TLA+/TLC baseline numbers ===
  ok  baseline N=2,L=4,B=2 distinct states = 31        # matches DistributedLeasing.tla / TLC
  ok  baseline N=2,L=4,B=2 max admitted = 6            # = L + N(B-1)
  ok  baseline N=3,L=6,B=3 distinct states = 441       # matches TLC
  ok  baseline N=3,L=6,B=3 max admitted = 12

=== 2. window-coupled credits => overshoot INDEPENDENT of N (Limit=8, Batch=2) ===
    N | baseline (= L+N(B-1)) | windowCoupled | coupled overshoot
    1 |          9            |      8        |        0
    2 |         10            |      8        |        0
    4 |         12            |      8        |        0
    8 |         16            |      8        |        0     (exhaustive to N=8; beyond, =L is immediate)

=== 3. Tightness: window-coupled attains exactly L (not lower), incl. work-conserving returns ===
  ok  N=3,L=6,B=3 max admitted == 6
  ok  N=5,L=10,B=2 max admitted == 10
  ok  N=4,L=12,B=4 max admitted == 12
```

Run: `npx vitest run test/gale/leasing-variants.test.ts`. The harness is *cross-validated* against the published TLA⁺ state counts (31, 441) before it is trusted, exactly as the existing project proof is. (Exhaustive BFS is capped at `N=8` — the reachable state space grows `~2^N`; beyond it the bound `=L` is immediate since window-coupling leaves zero carryover. The overshoot-vs-`N` contrast is carried to `N=16` by the evaluation simulator, §6.)

## 5. The system (shipped, not vaporware)

- **Pillar 1 ships**: `lease.windowCoupled` in `src/twotier/index.ts` — when the L2 window that granted a key's credits rolls over (`now ≥` the lease's `resetAt`), the credits expire instead of carrying over. Default off (legacy behaviour preserved); the whole library suite (374 tests) stays green and the 11-subpath build is clean.
- **Pillars 2–3** are L1-local, dependency-free, deterministic (injected `Clock`/seeds), matching the project's testing idiom — implemented in `test/gale/{lease-sizer,predictive-sizer}.ts` (research home; promotable to `src/` when productized).
- **Proof/measurement infra reused**: TLA⁺ + the Java-free BFS twin pattern; seeded discrete-event simulation; the library's existing Redis/Postgres benchmarks cover the shipped path's latency.

## 6. Evaluation (measured)

Reproducible seeded simulation; engine `test/gale/evaluate.ts`, gated claims `test/gale/evaluation.test.ts`, full table `research/gale/EVALUATION.md`. **Skewed overload** (N=5, limit 100, one hot node ~80 + four cold ~5 — offered ≈ limit):

| scheme | coordination (round trips) | overshoot Δ | utilization | fails |
|---|---:|---:|---:|---|
| strict (central per-request) | 51 186 | 0 | 1.000 | coordination |
| static equal share `L/N` | 0 | 0 | 0.446 | utilization |
| fixed leasing B=10, legacy | 9 669 | 28 | 1.007 | **overshoot** |
| fixed leasing, window-coupled | 17 178 (best B) | 0 | 0.955 | needs the right B (B=20 → util 0.446) |
| **GALE (coupled + adaptive, h=10)** | **12 731** | **0** | **0.962** | — none |

GALE is the only scheme good on all three axes: it **Pareto-dominates** the best fixed-batch coupled scheme (equal utilization at **26% fewer round trips**, because it sizes each node's lease to its own demand), runs at **4× less coordination than strict**, and **~2.2× the utilization of static** — all at `Δ = 0`. Overshoot-vs-`N` (B=10): legacy grows 15 → 25 as `N` goes 2 → 16; window-coupled stays **0**. `h` is the coordination↔utilization dial — under contention set it high so leases track demand; a fully contention-adaptive `h` is a noted refinement.

**Fairness (Workload C, Pillar 4)** isolates the *split*: one weight-4 tenant (idle every 5th window) + three weight-1 flooders, limit 70. WFE is the only policy good on every axis — utilization **1.000** with **0** share-guarantee violations — vs. static (utilization **0.876**, strands the idle share) and weight-blind leasing (**21%** violations, splits equally and ignores priority), at **identical coordination**. Full table: `EVALUATION.md` Workload C.

## 7. Venue & roadmap

- **Primary: SIGMETRICS / POMACS** — rewards exactly this blend of provable performance modeling + a real, measured artifact.
- Alternatives: NSDI/OSDI/EuroSys (systems-lead), PODC/SODA (theory-lead on the trilemma), NeurIPS/ICML (learning-augmented-with-safety).
- **Second paper**: the *cost-uncertainty* axis — rate limiting under post-hoc-revealed costs (LLM token / TPM budgets, where output length is unknown at admission): reserve-then-reconcile with bounded overshoot. Same "escrow under uncertainty" framework, a different and very timely instantiation.

Roadmap status: (1) ✅ keystone safety (machine-checked). (2) ✅ Pillar 2 lease sizing (implemented + regret measured). (3) ✅ Pillar 1 shipped in `src`. (4) ✅ Pillar 3 predictions (implemented + measured). (5) ✅ trilemma lower bound (proven + checked). (6) ✅ evaluation (measured). (7) ✅ Pillar 4 fairness (proven + measured). (8) ✅ this write-up. **Open:** shipping WFE into `src/twotier` (a weighted lease grant); contention-adaptive `h`; a full distributed deployment + the cost-uncertainty second paper.

## 8. Related work & reviewer threats (pre-empted)

**Must-cite / must-beat:**
- *Distributed RL systems*: Raghavan et al., **Cloud Control with DRL**, SIGCOMM'07 (GRD/FPS — direct prior art, empirical, N× worst case); Stanojevic & Shorten, **GDRL**, IWQoS'09 (consensus convergence, equilibrium-only conservation); Elhemali et al., **DynamoDB GAC**, USENIX ATC'22 (production lease/escrow, no proof).
- *Escrow / bounded counters*: O'Neil, **Escrow Transactional Method**, TODS'86; Balegas et al., **Bounded Counter CRDT**, SRDS'15 & **Indigo**, EuroSys'15; Barbará & Garcia-Molina, **Demarcation Protocol**, VLDBJ'94. (Safety yes; refill heuristic; no regret/work-conservation.)
- *Online learning w/ constraints & predictions*: Yu & Neely, **O(√T) regret + O(1) violation**, JMLR'20; Badanidiyuru et al., **Bandits with Knapsacks**, JACM'18; Yang et al., **Replenishable Budgets**, SIGMETRICS'24; Lykouris & Vassilvitskii, ICML'18 and Purohit et al., NeurIPS'18 (predictions framing).
- *Lower bounds*: Wattenhofer & Widmayer, **Inherent Bottleneck in Distributed Counting**, JPDC'98; Cormode, Muthukrishnan & Yi, **Distributed Functional Monitoring**, SODA'08 (+ Woodruff–Zhang, STOC'12).
- *Fairness*: Shue et al., **Pisces**, OSDI'12 (fairness-under-skew, central + empirical); Ghodsi et al., **DRF**, NSDI'11; Khamse-Ashari et al., **CM⁴FQ**, 2016; Pu et al., **FairRide** (SIP impossibility), NSDI'16.

**Threats and our distinctions:** CM⁴FQ → we add weights + a hard cap + the shared-store (vs. shared per-key tags). Pisces → we add *proofs* + low coordination (no central controller). DRL/FPS → provable, N-independent vs. their empirical N×. Yu–Neely → tight per-window hard cap vs. long-run `O(1)`. Yang et al.'24 → distributed + leasing + coordination objective. AdapTBF'26 → we supply the proofs they explicitly omit. **Trilemma vs. CMY / Woodruff–Zhang** → the zero-coordination bound is *elementary* and **complementary** to their monitoring bounds (it prices the `Δ–U` allocation edge; they price the `Δ–C` coordination-cost edge — neither implies the other), so we cite them, we do not subsume them; the contribution is the framing + the tight achievability (window-coupling), and the open theory work is the `0 < C < N` interpolation. **FairRide (NSDI'16)** → cache slots are rivalrous and non-fungible, whereas leased credits within a window are fungible; WFE therefore takes the sharing-incentive + work-conserving corner and concedes strategy-proofness (T5) rather than evading the impossibility.

---

### Artifacts & reproducibility

All gated (lint + strict types + tests + build) and merged to `main`. Run the lot with `npx vitest run test/gale test/twotier`.

| Claim | Artifact |
|---|---|
| Pillar 1 safety — overshoot `= L`, independent of `N` (proof) | `spec/GaleWindowCoupledLeasing.tla` + `.cfg`; `test/gale/leasing-variants.test.ts` (BFS twin, self-validated vs TLC counts 31/441) |
| Pillar 1 — shipped mechanism | `src/twotier/index.ts` (`lease.windowCoupled`); `test/twotier/window-coupled.test.ts` |
| Pillar 2 — online lease sizing, sublinear regret, EOQ tracking | `test/gale/lease-sizer.ts`, `test/gale/lease-sizer.test.ts`; design `research/gale/PILLAR2-lease-sizing.md` |
| Pillar 3 — predictions: consistency / robustness / unconditional safety | `test/gale/predictive-sizer.ts`, `test/gale/predictive-sizer.test.ts`; design `research/gale/PILLAR3-predictions.md` |
| Pillar 4 — weighted fair escrow: safety / sharing-incentive / work-conservation / bounded unfairness | `test/gale/fair-escrow.ts`, `test/gale/fair-escrow.test.ts`; design `research/gale/PILLAR4-fairness.md` |
| Trilemma lower bound `Δ + N·U ≥ (N−1)L`, tight | `test/gale/trilemma.test.ts`; proof `research/gale/TRILEMMA.md` |
| Evaluation — Pareto position vs baselines | `test/gale/evaluate.ts`, `test/gale/evaluation.test.ts`; results `research/gale/EVALUATION.md` |
| Demand traces / predictions (seeded, deterministic) | `test/gale/demand.ts` |
