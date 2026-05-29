# Joint-LP admission policy — DESIGN (shipped 0.11.1)

> Status: **SHIPPED in 0.11.1** (2026-05-29; TK-1320..TK-1323). Re-sequenced from
> the originally-planned 0.10.1 → **0.11.1** because eager handoff + self-fencing
> took 0.11.0; the design is otherwise as locked at TK-1319. Throughout this doc,
> read "0.10.1" as **0.11.1**.
> Ship was **conditional on DR-19** (ε ≥ 5%) — **MET**: TK-1007 measured
> ε = 25.33% mean. Default behavior is **unchanged**; joint-LP is strictly
> opt-in (`policy: "joint-lp"`).
>
> Implemented as specified, with two refinements found in build/review:
> (1) `solveFluidLp` generalizes the 2-type reference to **N types** via greedy
> per-regime fill + enumerate-and-verify dual recovery, with a KKT optimality
> certificate as the gate (§4/§9.1); (2) the cost-axis requirement (D-JLP-11)
> accepts `fused.cost` so joint-LP composes over the lua-fused backend (D-JLP-6).
> Directly-supplied `jointLp.duals` are validated (finite, ≥ 0) at construction.
>
> Decision records: **D-JLP-1 .. D-JLP-12** in §11.
> Research basis: `research/bigger-bets/unified/THEORY.md` + `…/sim.ts` (TK-1007).

---

## 0. Why this doc exists

`unifiedAdmission` (0.9.0) composes rate / concurrency / cost by **marginal-AND**:
admit iff each configured axis independently allows. THEORY.md (TK-1007) proves
marginal-AND leaves money on the table in the **cost-binding regime** (cost is the
bottleneck, request types differ in cost-efficiency): it admits a low-value
high-cost request that burns budget a high-value request needed. The
revenue-management fix is a **bid-price filter** (joint-LP): admit iff the
request's value clears the shadow price of the budget it consumes.

Measured gap vs the clairvoyant fluid-LP oracle, across the arrival-correlation
sweep ρ ∈ {−1, −0.5, 0, +0.5, +1}:

| ρ | regret(marginal-AND) | regret(joint-LP) | ε = M − J |
|---|---|---|---|
| −1.0 | 40.00% | 0.00% | **+40.00%** |
| −0.5 | 40.00% | 0.70% | **+39.30%** |
|  0.0 | 40.50% | 1.01% | **+39.49%** |
| +0.5 | 41.50% | 1.16% | **+40.34%** |
| +1.0 | 32.50% | 65.00% | **−32.50%** (the foil — §7) |

Mean ε = **25.33%** ≫ DR-19's 5% gate ⇒ **SHIP** (opt-in). Reproduce:
`npx tsx research/bigger-bets/unified/sim.ts` (deterministic; Mulberry32 seeded
on ρ and seed index).

Release is **minor** (`0.10.0 → 0.10.1`): additive `policy` + `value` + a new
zero-dep solver module. `policy` defaults to `"marginal"` — existing callers are
byte-for-byte unaffected (D-JLP-2).

---

## 1. Problem statement

Two-budget admission: a **rate** budget `R` (requests/window) and a **cost**
budget `C` (e.g. tokens/window). Request type `i` has cost `cᵢ` and value `vᵢ`.
Marginal-AND admits iff `rate.remaining ≥ 1 ∧ cost.remaining ≥ cᵢ` — greedy, no
notion of value-per-budget. When cost binds, greedily admitting a cheap-to-pass
but cost-heavy low-value request starves later high-value requests.

**Joint-LP** computes shadow prices `(p_R, p_C)` from the fluid LP relaxation and
admits iff **budget-feasible AND** `vᵢ ≥ p_R·1 + p_C·cᵢ` (the bid-price test).
The filter rejects requests whose value doesn't clear the marginal value of the
budget they'd consume — preserving budget for the requests that do. Joint-LP is
**strictly more selective** than marginal-AND (D-JLP-5): every joint-LP admit is
also a marginal admit, so it never *over*-admits.

---

## 2. Literature synthesis

- **Talluri & van Ryzin 1998**, *An Analysis of Bid-Price Controls for Network
  Revenue Management* (Mgmt Sci 44(11)): static bid prices from the deterministic
  (fluid) LP are **asymptotically optimal under a stationary regime** — and,
  crucially, *fail under non-stationarity*. This is exactly our ρ=+1 foil (§7).
- **Devanur & Hayes 2009**, *The AdWords problem … under random permutations*
  (EC'09): a one-pass **sample-then-price** primal-dual policy is `1−ε`
  competitive under random permutation of arrivals — approximate stationarity,
  not i.i.d. Real arrival streams sit far closer to random-permutation than to
  ρ=+1's absorbing chain, which is why the foil is not a production blocker (§7).
- **Mehta et al. 2007 / Buchbinder et al. 2007**: online primal-dual,
  multi-resource bid prices. The formal grounding for the optional online dual
  update (§6, deferred).

DR-19 (PLAN §8) reclassified joint-LP from "research-only" to "productizable
now": the *bound* is literature-established; TK-1007's job was only to calibrate
the *magnitude* ε for LLM-gateway workloads. ε = 25.33% clears the gate.

---

## 3. The fluid LP and its dual

Primal (admit fraction `xᵢ ∈ [0,1]` per type, arrival weight `wᵢ`):

```
max   Σ wᵢ vᵢ xᵢ
s.t.  Σ wᵢ xᵢ        ≤ R        (rate,  dual p_R ≥ 0)
      Σ wᵢ cᵢ xᵢ     ≤ C        (cost,  dual p_C ≥ 0)
      0 ≤ xᵢ ≤ 1
```

By LP duality / complementary slackness, the optimal bid-price test is
`admit type i  ⟺  vᵢ ≥ p_R + p_C·cᵢ`. For the THEORY.md example (small:
c=100,v=1,w=0.5; large: c=10000,v=50,w=0.5; R=1000, C=50000) the optimum is
`x* = (1, 0)` with `p_R = 0, p_C = 0.01` — admit every small, reject every large.
These two numbers are the **canonical unit-test fixture** (§9.1).

---

## 4. The in-library solver — `src/admission/fluid-lp.ts` (NEW)

Strict zero-runtime-deps ⇒ **no LP library**. The 2-constraint LP is solved by
**vertex enumeration** — the working implementation already exists as
`solveFluidLP()` in `research/bigger-bets/unified/sim.ts:149-232`. **Port it
verbatim** (adapt only types/exports); do not redesign the math (D-JLP-7).

```ts
/** One request archetype in the workload model. */
export interface WorkloadType {
  /** Cost-axis weight per admit (matches Limiter.check(key, cost)'s 2nd arg). */
  cost: number;
  /** Business value of admitting one (revenue, priority, …). */
  value: number;
  /** Arrival weight / probability. Need not sum to 1 — normalized internally. */
  weight: number;
}

export interface FluidLpInput {
  types: WorkloadType[];
  /** Rate budget R per window (admits/window). */
  rateBudget: number;
  /** Cost budget C per window (cost units/window). */
  costBudget: number;
}

export interface FluidLpSolution {
  /** Bid prices: admit type i iff value ≥ duals.rate + duals.cost * cost. */
  duals: { rate: number; cost: number };
  /** Optimal admit fraction per input type (same order as input.types). */
  admitFractions: number[];
  /** Optimal objective Σ wᵢ vᵢ xᵢ (telemetry / tests). */
  objective: number;
}

/**
 * Solve the 2-budget fluid LP by enumerating the candidate dual regimes
 * {neither binds, rate binds, cost binds, both bind}, solving the small system
 * for each, and selecting the feasible solution with the optimal objective.
 * Hand-written, zero-dep, O(types · constant). Reference impl + derivation:
 * research/bigger-bets/unified/sim.ts:149-232 and THEORY.md §2.
 */
export function solveFluidLp(input: FluidLpInput): FluidLpSolution;
```

Validation: `types` non-empty; all `cost`/`value`/`weight` finite and ≥ 0;
`rateBudget`/`costBudget` > 0. Throw `ThrottleKitError` otherwise.

---

## 5. `unifiedAdmission` integration (exact edits)

### 5.1 `UnifiedAdmissionOptions` (add to `src/admission/unified.ts:13-38`)

```ts
  /**
   * Admission policy. `"marginal"` (DEFAULT) = the 0.9.0 marginal-AND behavior
   * (each axis allows independently). `"joint-lp"` = additionally apply a
   * bid-price filter (admit iff value ≥ p_R + p_C·cost) on top of marginal
   * feasibility — opt-in, research-backed (research/bigger-bets/joint-lp-admission).
   */
  policy?: "marginal" | "joint-lp";
  /**
   * Required iff `policy: "joint-lp"`. Supply EXACTLY ONE of:
   *  - `duals`: precomputed bid prices (you solved the LP elsewhere); or
   *  - `workload`: a model the library solves at construction via solveFluidLp().
   */
  jointLp?: {
    duals?: { rate: number; cost: number };
    workload?: FluidLpInput;
  };
```

### 5.2 `UnifiedAdmitOptions` (add to `src/admission/unified.ts:41-52`)

```ts
  /**
   * The request's value vᵢ for the joint-LP bid-price test. Ignored unless
   * `policy: "joint-lp"`. Default 1.
   */
  value?: number;
```

### 5.3 `UnifiedAdmission` (add to `src/admission/unified.ts:55-66`)

```ts
  /**
   * True iff the admission was denied specifically by the joint-LP bid-price
   * filter (all per-axis budgets had slack, but value < p_R + p_C·cost).
   * Absent/false under `policy: "marginal"` or any axis-bound denial. Lets the
   * TK-1008 OTel `tk.binding_axis` attribute report "policy".
   */
  policyDenied?: boolean;
```

### 5.4 Construction-time wiring (in `unifiedAdmission()`, after the backend validation block, ~line 153)

```ts
  const policy = options.policy ?? "marginal";
  let duals: { rate: number; cost: number } | undefined;
  if (policy === "joint-lp") {
    if (cost === undefined) {
      throw new ThrottleKitError('unifiedAdmission: policy "joint-lp" requires a `cost` axis');
    }
    const jl = options.jointLp;
    const hasDuals = jl?.duals !== undefined;
    const hasWorkload = jl?.workload !== undefined;
    if (hasDuals === hasWorkload) { // both or neither
      throw new ThrottleKitError(
        'unifiedAdmission: policy "joint-lp" requires exactly one of jointLp.duals or jointLp.workload',
      );
    }
    duals = hasDuals ? jl!.duals! : solveFluidLp(jl!.workload!).duals;
  } else if (options.jointLp !== undefined) {
    throw new ThrottleKitError('unifiedAdmission: `jointLp` requires policy: "joint-lp"');
  }
```

### 5.5 The bid-price gate (admit path)

Apply **after** rate+cost both allow (marginal feasibility confirmed), **before**
`finalize()`. Both backends, both async (`admit`, after line 276) and sync
(`admitSync`, after line 319). `value` comes from `opts`; `requestCost` is
already in scope.

```ts
      // joint-LP bid-price filter (only when configured; pure JS, backend-agnostic).
      if (duals !== undefined) {
        const value = opts?.value ?? 1;
        const bid = duals.rate * 1 + duals.cost * requestCost;
        if (value < bid) {
          leaseRelease?.({ dropped: false });           // release the held slot (upstream-style deny)
          const denied = denyByPolicy(combineSnapshot()); // allowed:false, remaining:0; keep limit/resetAt
          return { decision: denied, release: NOOP_RELEASE, policyDenied: true };
        }
      }
      return finalize(leaseRelease);
```

Helper (module-scope):

```ts
/** Turn an all-axes-allowed snapshot into a policy denial: flip allowed, zero
 *  remaining + retryAfter; preserve limit/resetAt so headers stay coherent. */
function denyByPolicy(d: Decision): Decision {
  return { ...d, allowed: false, remaining: 0, retryAfterMs: 0 };
}
```

`finalize()` returns `policyDenied` absent (⇒ falsy). `lastDecisions()` is
unchanged — under a policy denial every per-axis Decision is `allowed:true`, and
`policyDenied` is the signal that the *filter* (not an axis) bound. (D-JLP-4.)

> **D-JLP-6 — the gate is pure JS, applied after the rate/cost step in BOTH
> backends.** It needs only `value`, `requestCost`, and the static `duals`, so
> `"lua-fused"` works too (the fused script returns the combined rate+cost
> Decision; the JS bid-price test runs on top).

---

## 6. Online dual update (Devanur-Hayes) — **SHIPPED 0.11.3, opt-in (D-JLP-8, D-JLP-13/14)**

0.11.1 shipped **static duals** as the primary path (ε = 25.33%, measured on static
fluid-LP duals). 0.11.3 adds the **online sample-then-price** variant as an opt-in
refinement: `jointLp.adaptive = { sampleWindow: W }` (requires the `workload` form).

### 6.1 The naïve design FAILS — the gate killed it
The textbook sample-then-price (observe `W` arrivals UNPRICED, re-solve, freeze)
loses badly when the prior was *correct*: the gate (`adaptive-gate.ts`) measured the
"freeze-always" variant at **9.9–21.1%** regret in WORLD A (correct prior) vs static's
**0.7–1.2%** — it adopts a noisy finite-sample estimate over an already-optimal prior.
Running the warm-up *unpriced* also squanders a binding budget before the duals exist.

### 6.2 The shipped design — **GUARDED (self-validating) sample-then-price** (D-JLP-13)
1. **Price the warm-up with the prior.** During the first `W` policy-evaluated requests
   the bid filter uses the construction prior's duals (`solveFluidLp(workload).duals`) —
   so a binding budget is never run unpriced, and behavior is byte-identical to static
   joint-LP until the window fills.
2. **Tally + buffer.** Observe the `(cost, value)` mixture (counts, capped at 64 distinct
   archetypes) and buffer the arrivals.
3. **Re-solve at the boundary.** At the `W`-th request re-solve the fluid LP from the
   observed weights (`count/seen`) to get the LEARNED duals.
4. **Adopt only if it beats the prior ON THE OBSERVED SAMPLE.** Replay the buffer greedily
   under the window-scaled budget (`rateBudget·W`, `costBudget·W`) with both dual sets;
   adopt the learned duals iff `revenue(learned) > revenue(prior)` strictly, else keep the
   prior. Then freeze for the lifetime of the admitter.

This is **self-validating**: a correct prior cannot be strictly beaten on its own sample,
so noise can't dislodge it (matches static(oracle) in WORLD A); a *catastrophically* wrong
prior — one whose duals reject everything (WORLD C: believed-large=200, true=50 ⇒ 100%
regret, admits nothing) — is escaped, rescued to **~20–30%**. The gate verdict:

| world | static(prior) | freeze-always | **GUARDED** | static(oracle) |
|-------|---------------|---------------|-------------|----------------|
| A correct prior (ρ∈[−0.5,0.5]) | 0.7–1.2% | 9.9–21.1% | **0.7–1.2%** | 0.7–1.2% |
| C catastrophic prior (ρ∈[−0.5,0.5]) | **100%** | 19.9–30.1% | **19.9–30.1%** | 0.7–1.2% |
| ρ=+1 foil (A) | 65% | 32.5% | **32.5%** | 65% |

### 6.3 Honest scope of the guarantee (D-JLP-14)
The guarantee is **non-inferiority on the observed sample**, proved structurally (adoption
is gated on a strict `>` over a buffer replayed with the identical-to-live admit predicate,
with a prior fallback that also catches every NaN/throw). It does **NOT** imply full-horizon
dominance: under autocorrelated / non-stationary arrivals the `W`-window can be
unrepresentative, so an adopted dual can be *slightly* worse over the full stream (measured
+0.8pp at ρ=0.5, believed-large=2/true=80; bounded and still far better than marginal-AND).
This is the **autocorrelation cousin of the ρ=+1 foil (§7)** and is regression-guarded in
`test/admission/joint-lp-adaptive.test.ts` exactly as the foil is — never silently "fixed".
Two further honest notes: with a `concurrency` axis the window counts the **concurrency-passed**
population (the bid filter sits after it); and the requires-`workload` constraint is load-bearing
(the bare `duals` form carries no per-arrival budget to re-solve or replay against).

---

## 7. The ρ = +1 foil — honest caveat (do NOT bury this, D-JLP-9)

At ρ = +1 the arrival chain is **absorbing**: one type forever. Realizations are
bimodal (all-small or all-large). On all-large, joint-LP rejects every request
(large fails the bid-price test) → revenue 0 → 100% regret; marginal-AND admits
5 large (cost cap) → 50% regret. So at ρ=+1 marginal-AND **wins** (joint-LP ε is
**negative**, −32.5%). This is the **textbook fluid-LP failure under
non-stationarity** (Talluri-van Ryzin 1998).

Why it does **not** block the opt-in ship:

1. **Real workloads aren't absorbing.** An aggregator's window mixes tenants and
   types; empirical lag-1 autocorrelation sits in ≈ [−0.2, +0.5], where ε is a
   consistent +39–40%.
2. **Devanur-Hayes 2009**: under random-permutation arrivals (approximate
   stationarity), the primal-dual policy is `1−ε` competitive — real streams are
   near-random-permutation, far from ρ=+1.
3. **Opt-in.** `policy: "joint-lp"` is user-explicit; default stays marginal.
   Degenerate-workload operators simply don't enable it.

This caveat must appear verbatim-in-spirit in: the CHANGELOG [0.10.1] entry, the
wiki joint-LP section (TK-1322), and a FAILURE-MODES "operational caveat" row.
The empirical-regret test (§9.2) **regression-guards the foil** (asserts
joint-LP *is* worse at ρ=+1) so we never silently "fix" the honest result.

---

## 8. (reserved)

---

## 9. Test substrate (TK-1321)

1. **Solver unit — `test/admission/fluid-lp.test.ts`**: the THEORY.md fixture →
   assert `duals ≈ { rate: 0, cost: 0.01 }` (tolerance 1e-9), `admitFractions ≈
   [1, 0]`, `objective ≈ 0.5` (per-arrival) / scaled total. Plus: rate-binds-only
   regime, both-bind regime, neither-binds (all `x=1`, duals 0), single-type,
   validation throws.
2. **Empirical regret — `test/admission/joint-lp-regret.test.ts`** (the DR-19
   gate, as a committed test): import/reuse the `sim.ts` harness; assert
   **mean ε over ρ ∈ {−1,−0.5,0,+0.5} ≥ 0.05** (the non-degenerate regimes; the
   committed value is ≈ 0.398 so the 5% gate has huge margin) AND assert the
   **ρ=+1 foil**: `regret(joint-LP) > regret(marginal-AND)` at ρ=+1 (§7
   regression guard). Deterministic seed (Mulberry32) → exact, no flake.
3. **Property — `test/admission/joint-lp-properties.test.ts`** (fast-check,
   numRuns 100-200):
   - **monotonicity**: for fixed `(duals, cost)`, if `v1 ≥ v2` then admit(v1) ⇒
     admit(v2) is *false*-direction… i.e. higher value is never *less* likely to
     pass the bid-price test (the test is monotone-increasing in value).
   - **subset/strictness (D-JLP-5)**: under identical limiter state, every
     joint-LP admit is also a marginal admit (joint-LP never over-admits).
   - **default-unchanged (D-JLP-2)**: `policy:"marginal"` (and omitted) is
     identical, decision-for-decision, to the pre-0.10.1 path over random
     workloads (golden-compare against a marginal-only admitter).
   - **duals=0 ≡ marginal**: `jointLp.duals = { rate:0, cost:0 }` makes the
     bid-price test `value ≥ 0` (always true) ⇒ behaves as marginal.
4. **Dual-path — `test/admission/joint-lp-dual-path.test.ts`** (Redis-gated, port
   6380): the bid-price filter yields identical admit/deny on `"sequential"` and
   `"lua-fused"` for the same `(value, cost)` stream (D-JLP-6).

---

## 10. Docs (TK-1322)

- **Wiki `Unified-Admission.md`**: a "Joint-LP policy (opt-in)" section — the
  bid-price intuition, the `workload`/`duals` API, the ε=25.33% result table,
  and the §7 ρ=+1 caveat. Example: an LLM gateway with small/large completions.
- **`docs/FAILURE-MODES.md`**: an "operational caveat" row — *joint-LP can
  under-perform marginal-AND under highly autocorrelated (near-absorbing)
  workloads; default marginal-AND is the safe choice; see §7.*
- **README**: one line under unified admission noting the opt-in policy + link.
- Wiki commits accumulate locally on `tk-wiki master`; push at the 0.10.1 tag.

---

## 11. Decision records

- **D-JLP-1 — Joint-LP ships as opt-in 0.10.1, separate from 0.10.0.** DR-16
  sequencing; clean changelog; the conditional-ship gate gets its own release
  note. (User-approved, 2026-05-29.)
- **D-JLP-2 — Default `policy: "marginal"`; existing callers byte-unchanged.**
  Property-tested (§9.3 default-unchanged + duals=0≡marginal).
- **D-JLP-3 — In-library zero-dep solver (`solveFluidLp`), workload model as
  primary input; static `duals` as escape hatch.** Best DX without an LP
  dependency. (User-approved, 2026-05-29.)
- **D-JLP-4 — Policy denial is signaled by `policyDenied`, NOT by widening
  `UnifiedAxis`.** Under a policy deny every axis Decision is `allowed:true`;
  `policyDenied` distinguishes filter-bound from axis-bound. Additive; preserves
  the 0.9.0 `lastDecisions()` shape.
- **D-JLP-5 — Joint-LP is strictly more selective than marginal-AND.** Every
  joint-LP admit ⊆ marginal admits; the filter only ever *removes* admits, so it
  cannot break any existing safety/limit property. Property-tested.
- **D-JLP-6 — Bid-price gate is pure JS, applied post rate+cost in BOTH
  backends.** Works under `"lua-fused"` unchanged. See §5.5.
- **D-JLP-7 — Port `solveFluidLP` from `sim.ts:149-232` verbatim; do not
  redesign the math.** The vertex-enumeration LP is already validated by TK-1007.
- **D-JLP-8 — Online primal-dual: SHIPPED 0.11.3 as opt-in `jointLp.adaptive`.** 0.11.1
  shipped static duals (ε=25.33% validated); 0.11.3 adds the GUARDED sample-then-price
  refinement. See §6, D-JLP-13/14.
- **D-JLP-13 — The online design is GUARDED (self-validating), not naïve sample-then-price.**
  Price the warm-up with the prior; adopt the re-solved duals only if they STRICTLY beat the
  prior on the observed sample (buffer replayed under the window-scaled budget), else keep the
  prior, then freeze. The naïve "freeze-always" variant FAILS in WORLD A (correct prior:
  9.9–21.1% regret vs static's 0.7–1.2%) — the gate killed it. Requires the `workload` form (it
  carries both the prior and the per-arrival budgets the re-solve/replay need; bare `duals`
  cannot). Verified end-to-end in `test/admission/joint-lp-adaptive.test.ts` (WORLD A/B/C
  reproduced on the shipped state machine; both the no-op and always-adopt mutants are caught).
- **D-JLP-14 — The guarantee is on-sample non-inferiority, NOT full-horizon dominance.** Proved
  structurally (strict-`>` adoption + a prior fallback that also covers every NaN/throw, so the
  chosen duals never beat the prior on-sample). Under autocorrelation the W-window can be
  unrepresentative ⇒ an adopted dual can be *slightly* worse over the full stream (+0.8pp
  measured at ρ=0.5) — the autocorrelation cousin of the ρ=+1 foil; regression-guarded so it is
  never silently claimed away. With a concurrency axis the window counts the concurrency-passed
  population. Headline wording everywhere is scoped to "never worse than the prior on the
  observed sample".
- **D-JLP-9 — The ρ=+1 foil is documented everywhere and regression-tested.**
  Never silently "fixed". See §7, §9.2.
- **D-JLP-10 — `value` defaults to 1 on `UnifiedAdmitOptions`.** A workload that
  doesn't set per-request value collapses joint-LP to a cost-threshold filter
  (still valid; documented).
- **D-JLP-11 — `policy:"joint-lp"` requires a `cost` axis** (the bid-price test
  is over the cost budget). Rate axis optional. Fail loud at construction.
- **D-JLP-12 — Ship is conditional on DR-19 (ε ≥ 5%); MET at 25.33%.** If a
  future re-measure dropped below 5%, the release note documents the negative
  result and holds — but the gate is currently green with >5× margin.

---

## 12. Open questions / future work

1. ✅ **DONE 0.11.3 — Online primal-dual dual update** (Devanur-Hayes sample-then-price):
   `jointLp.adaptive = { sampleWindow }`. Shipped as the GUARDED self-validating variant
   (§6, D-JLP-13/14) — not the naïve form, which the gate refuted.
2. ⚖️ **GATE DONE 0.11.3 — GO (narrow but real) — 3-axis joint LP** (rate + cost + a
   *concurrency* shadow price). The "concurrency is instantaneous, doesn't fit the fluid
   relaxation" worry is RESOLVED by **Little's law**: an occupancy cap `L` is a 3rd fluid
   budget `Σ wᵢ hᵢ xᵢ ≤ L·T` with per-request consumption = **hold time** `hᵢ`; the bid test
   gains a term `value ≥ p_R + p_C·cost + p_K·hold` (gate `three-axis-gate.ts`; the 3-budget
   dual solves cleanly by 3D vertex enumeration). **WIN:** cuts regret **53%→2% (ε≈51pp)** when
   concurrency binds and a strictly-dominated hold-time hog is INDISTINGUISHABLE from good
   traffic on (rate,cost) — 2-axis is structurally blind to it. **NO HARM** when concurrency is
   ample (`p_K=0` ⇒ 3-axis ≡ 2-axis ≡ marginal). **STRUCTURAL LIMIT (honest):** a bid-price
   threshold cannot RATION a *marginal* hog (admitted at `value = p_K·hold`; the greedy limiter
   rations instead) — it strictly helps only against a strictly-dominated hog. **Implementation
   (deferred pending disposition):** a 3-budget solver + per-type `hold` in the workload + a
   per-request `hold` estimate at admit time + the `p_K·hold` bid term; expands the public
   per-request API (experimental-frontier under STABILITY.md).
3. **Per-tenant duals** (pair with Pillar 4 WFE): different bid prices per tenant
   class. Composition study.

---

## 13. References

- Talluri & van Ryzin 1998, *An Analysis of Bid-Price Controls for Network
  Revenue Management*, Management Science 44(11).
- Devanur & Hayes 2009, *The AdWords Problem: Online Keyword Matching with
  Budgeted Bidders under Random Permutations*, EC'09.
- Mehta, Saberi, Vazirani, Vazirani 2007; Buchbinder, Jain, Naor 2007
  (online primal-dual, multi-resource bid prices).
- `research/bigger-bets/unified/THEORY.md` + `sim.ts` (TK-1007) — the ε
  measurement, the foil analysis, the reference solver.

---

## Appendix A — Task breakdown & PARALLEL DISPATCH DAG (for the coding phase)

```
PHASE B0 (BARRIER — land first):
  B0  this DESIGN.md committed                                     (TK-1319 commit)

PHASE B1 (FAN-OUT — independent):
  B1a src/admission/fluid-lp.ts        solveFluidLp (port sim.ts:149-232)   (§4)
  B1b src/admission/unified.ts edits   policy/jointLp/value/policyDenied + gate (§5)
        (B1b's construction wiring imports B1a's solveFluidLp → B1b depends on B1a's
         EXPORTS only; safe to author in parallel against the §4/§5 signatures, integrate last)

PHASE B2 (DEPENDS B1):
  B2a src/index.ts exports             solveFluidLp + FluidLp* types         (§4)
  B2b test/admission/fluid-lp.test.ts                                        (§9.1)
  B2c test/admission/joint-lp-regret.test.ts   (DR-19 gate + ρ=+1 foil)      (§9.2)
  B2d test/admission/joint-lp-properties.test.ts                             (§9.3)
  B2e test/admission/joint-lp-dual-path.test.ts (Redis-gated, port 6380)     (§9.4)
  B2f examples/joint-lp-admission.ts                                         (LLM gateway)

PHASE B3 (release prep — serial, last):
  B3a wiki Unified-Admission joint-LP section + FAILURE-MODES caveat + README (TK-1322)
  B3b version 0.10.0→0.10.1; CHANGELOG [0.10.1] (SHIP verdict + ρ=+1 caveat + cites);
      SCOREBOARD test count                                                   (TK-1323)
  B3c npm run check; commit chain; (await user authorization before tag/publish)
```

Commit shapes (no Co-Authored-By; each passes `npm run check`):

| TK | Commit |
|---|---|
| TK-1319 | `docs(research): joint-LP admission design + bid-price API + ε gate (TK-1319)` |
| TK-1320 | `feat(admission): joint-LP policy in unifiedAdmission + zero-dep fluid-lp solver (TK-1320)` |
| TK-1321 | `test(admission): fluid-lp unit + empirical-regret gate + properties + dual-path (TK-1321)` |
| TK-1322 | `docs(admission): wiki joint-LP section + FAILURE-MODES caveat + example (TK-1322)` |
| TK-1323 | `chore(release): prepare 0.10.1 (joint-LP admission policy) (TK-1323)` |
