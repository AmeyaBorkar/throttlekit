# GALE: Globally-Accounted Learned Escrow for Distributed Rate Limiting

*A research proposal / paper skeleton built on ThrottleKit. Working title and acronym are placeholders.*

> **One-line thesis.** Distributed rate limiting is *escrow under uncertainty*: every system must decide, online and per-node, how much of a shared global budget to hold locally — trading coordination cost against overshoot (safety) and stranded capacity (utilization). For ~18 years the field has resolved this with static, hand-tuned shares that are provably wrong under skewed, non-stationary demand. We give the first scheme that is simultaneously **overshoot-bounded independent of fleet size**, **work-conserving**, **low-coordination** (a shared atomic store, no gossip), and **online-adaptive with a regret guarantee** — and we prove a matching **trilemma lower bound** showing the three-way tradeoff is fundamental.

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

A decentralized limiter coordinated **only** through the existing shared atomic store (Redis Lua / Postgres transaction) — **no gossip** — in three provable layers plus a capstone.

### Pillar 1 — Window-coupled / escrow-accounted leasing ⇒ overshoot independent of N  ✅ *machine-checked*

Couple credit lifetime to the L2 window (credits expire at the boundary) and/or have the L2 escrow-account outstanding grants. This kills the carryover that is the sole source of overshoot.

- **Theorem (Safety).** Per-window global admissions ≤ **L**, *independent of N* — vs. the prior tight `L + N·(B−1)`.
- **Status: proven by bounded model check** (see §4). The TLA⁺ spec is `spec/GaleWindowCoupledLeasing.tla`; the CI-runnable Java-free twin is `research/gale/leasing-variants.ts`.
- **Cost (a liveness/efficiency property, not safety):** a busy node re-leases once per window boundary and forfeits credits it still held — a bounded near-boundary utilization dip that Pillar 2 minimizes.

### Pillar 2 — Online lease sizing ⇒ minimize coordination at fixed safety

The lease size is no longer a knob. Each round trip is an "order cost"; each held credit a "holding cost" (= overshoot/stranding risk by §2). This is exactly the **EOQ / inventory** tradeoff — optimal lease ≈ `√(2λc/h)` — but demand `λ` is unknown and non-stationary, so each node runs a **no-regret online learner** over its lease size.

- **Theorem (Regret).** Coordination cost over `T` requests is within `O(√T)` of the best fixed lease in hindsight (dynamic regret `Õ(V_T^{1/3}T^{2/3})` under demand variation `V_T`). Crucially, **the Pillar-1 safety bound holds for *any* lease sizes**, so learning tunes efficiency and can never breach the cap. This structural decoupling is what improves on Yu–Neely's *long-run* `O(1)` violation — ours is a *tight per-window hard* cap.

### Pillar 3 — Learning-augmented with demand predictions ⇒ consistency/robustness, safety-preserving

Feed a demand predictor (EWMA or external ML) into lease sizing and proactive credit return.

- **Theorem (Predictions).** Consistency (coordination → offline optimum as prediction error `η → 0`) and bounded robustness for any `η`, while the hard overshoot bound holds **unconditionally** — predictions set only the *requested* lease; the escrow store still gates it. This is, to our knowledge, the **first predictions-with-safety result for distributed rate limiting** (cf. Yang et al. SIGMETRICS'24, which is centralized with no leasing).

### Pillar 4 (extension) — Weighted, work-conserving fairness across nodes & tenants

Single-pool escrow + idle-return yields approximate weighted max-min fairness to within additive slack `b_max`, using only the shared store (vs. Pisces's central controller). FairRide's SIP impossibility tells us precisely what must be conceded (bounded non-work-conservation); characterizing that frontier is itself a result.

### Capstone — The Rate-Limiting Trilemma (theory headline)

- **Theorem (Impossibility).** No online distributed leasing policy can simultaneously achieve tight overshoot `Δ = o(1)`, sub-linear coordination `C = o(demand)`, and full utilization `U = o(1)` under adversarial skew + non-stationarity; any policy obeys `C ≥ f(Δ, U, V_T)`. Built on the proven distributed-counting (Wattenhofer–Widmayer) and functional-monitoring (Cormode–Muthukrishnan–Yi; Woodruff–Zhang) lower bounds for the `Δ–C` edge, extended with a demand-shifting adversary for the `U` axis. **GALE is then shown to sit on this frontier** (achieving it up to logarithmic/constant factors).

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
    8 |         16            |      8        |        0
   16 |         24            |      8        |        0

=== 3. Tightness: window-coupled attains exactly L (not lower), incl. work-conserving returns ===
  ok  N=3,L=6,B=3 max admitted == 6
  ok  N=5,L=10,B=2 max admitted == 10
  ok  N=4,L=12,B=4 max admitted == 12
```

Run: `npx vitest run test/gale/leasing-variants.test.ts`. The harness is *cross-validated* against the published TLA⁺ state counts (31, 441) before it is trusted, exactly as the existing project proof is. This de-risks the paper's central safety theorem before a line of the system is written.

## 5. The system (why this is not vaporware)

Every pillar is a bounded change to code that already exists in this repo:
- **Pillar 1**: the Redis Lua script already does atomic compare-and-decrement; add an outstanding-grant counter + a `return`/expire op. The Postgres advisory-lock RMW runs the same transform. The `twoTier` engine (`src/twotier/index.ts`) is the host.
- **Pillar 2/3**: lease sizing lives entirely in L1 (the node); the learner and predictor are local, dependency-free, deterministic under the injected `Clock` (matching the project's testing idiom).
- **Proof/measurement infra already present**: TLA⁺ + Java-free BFS twin; the bit-identical JS↔Lua conformance suite; the comparative benchmark harness (`bench/`).

## 6. Evaluation plan

- **Baselines**: central-store-per-request (ThrottleKit `strict`); fixed-batch leasing (ThrottleKit `leased` — the current SOTA bound); static equal share (`L/N`); FPS-style gossip (Raghavan'07); Doorman/GAC-style proportional leases.
- **Workloads**: skewed per-node demand (Zipf), non-stationary/bursty traces (diurnal + spikes), adversarial demand-shifting.
- **Metrics**: realized overshoot vs. `L`; coordination round trips per 1k requests; utilization (admitted / `L` under offered overload); per-tenant fairness (Jain's index, max-min ratio); tail latency.
- **Headline figures**: (a) overshoot flat in `N` for GALE vs. linear for fixed-batch; (b) Pareto frontier — same overshoot at far lower coordination *and* higher utilization; (c) learning curve — coordination approaching the offline optimum as predictions improve, with safety never violated.

## 7. Venue & roadmap

- **Primary: SIGMETRICS / POMACS** — rewards exactly this blend of provable performance modeling + a real, measured artifact.
- Alternatives: NSDI/OSDI/EuroSys (systems-lead), PODC/SODA (theory-lead on the trilemma), NeurIPS/ICML (learning-augmented-with-safety).
- **Second paper**: the *cost-uncertainty* axis — rate limiting under post-hoc-revealed costs (LLM token / TPM budgets, where output length is unknown at admission): reserve-then-reconcile with bounded overshoot. Same "escrow under uncertainty" framework, a different and very timely instantiation.

Roadmap: (1) ✅ keystone safety result (done). (2) Formalize the model + prove the regret bound (Pillar 2). (3) Implement GALE Pillar 1 in the Redis/Postgres path + extend the conformance suite. (4) Consistency/robustness analysis (Pillar 3). (5) Trilemma lower bound. (6) Evaluation. (7) Write-up.

## 8. Related work & reviewer threats (pre-empted)

**Must-cite / must-beat:**
- *Distributed RL systems*: Raghavan et al., **Cloud Control with DRL**, SIGCOMM'07 (GRD/FPS — direct prior art, empirical, N× worst case); Stanojevic & Shorten, **GDRL**, IWQoS'09 (consensus convergence, equilibrium-only conservation); Elhemali et al., **DynamoDB GAC**, USENIX ATC'22 (production lease/escrow, no proof).
- *Escrow / bounded counters*: O'Neil, **Escrow Transactional Method**, TODS'86; Balegas et al., **Bounded Counter CRDT**, SRDS'15 & **Indigo**, EuroSys'15; Barbará & Garcia-Molina, **Demarcation Protocol**, VLDBJ'94. (Safety yes; refill heuristic; no regret/work-conservation.)
- *Online learning w/ constraints & predictions*: Yu & Neely, **O(√T) regret + O(1) violation**, JMLR'20; Badanidiyuru et al., **Bandits with Knapsacks**, JACM'18; Yang et al., **Replenishable Budgets**, SIGMETRICS'24; Lykouris & Vassilvitskii, ICML'18 and Purohit et al., NeurIPS'18 (predictions framing).
- *Lower bounds*: Wattenhofer & Widmayer, **Inherent Bottleneck in Distributed Counting**, JPDC'98; Cormode, Muthukrishnan & Yi, **Distributed Functional Monitoring**, SODA'08 (+ Woodruff–Zhang, STOC'12).
- *Fairness*: Shue et al., **Pisces**, OSDI'12 (fairness-under-skew, central + empirical); Ghodsi et al., **DRF**, NSDI'11; Khamse-Ashari et al., **CM⁴FQ**, 2016; Pu et al., **FairRide** (SIP impossibility), NSDI'16.

**Threats and our distinctions:** CM⁴FQ → we add weights + a hard cap + the shared-store (vs. shared per-key tags). Pisces → we add *proofs* + low coordination (no central controller). DRL/FPS → provable, N-independent vs. their empirical N×. Yu–Neely → tight per-window hard cap vs. long-run `O(1)`. Yang et al.'24 → distributed + leasing + coordination objective. AdapTBF'26 → we supply the proofs they explicitly omit.

---

### Artifacts
- `../../test/gale/leasing-variants.test.ts` — the CI-gated exhaustive BFS model checker (`npx vitest run test/gale`). Proves Pillar 1.
- `../../spec/GaleWindowCoupledLeasing.tla` + `.cfg` — the human-auditable TLA⁺ spec (the authoritative twin; TLC needs Java).
