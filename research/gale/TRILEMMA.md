# The rate-limiting trilemma — a lower bound

*The capstone **framing** result. The zero-coordination bound below is an elementary, general-`N`
averaging argument — proved here in closed form, and machine-checked exhaustively for `N ∈ {2,3,4}` in
`test/gale/trilemma.test.ts` as corroboration (not the proof's ceiling). Its value is not depth (the
proof is one line) but the **design-space framing** — the three-way tension among **overshoot**,
**coordination**, and **utilisation-under-skew** that every distributed rate limiter negotiates — and
the **achievability**: GALE's window-coupling reaches the good corner with bounded coordination. To our
knowledge the tradeoff has not been stated in this form for rate limiting; it is **complementary to,
not subsumed by**, the distributed-monitoring communication bounds (see "How much coordination?")
that price the coordination axis.*

## Model

One L2 window; `N` enforcement nodes; a global limit of `L` admissions for the window. An (online)
**demand adversary** chooses how much demand `d_n ≥ 0` is offered at each node — this is the *skew*.
The "correct" number of admissions for an offered vector is `min(Σ d_n, L)` (serve up to the limit).

Three costs of a protocol, each a worst case over the adversary's choice:
- **Overshoot** `Δ` — how far global admissions can exceed `L`.
- **Under-utilisation** `U` — how far below `min(Σ d, L)` admissions can fall (capacity that should
  have been served but was not).
- **Coordination** `C` — inter-node messages / L2 round trips per window.

## Zero-coordination theorem

A **zero-coordination** protocol must let each node decide using only its own offered demand and
pre-window state — equivalently, it pre-authorises a local budget `b_n ≥ 0` and admits
`a_n = min(d_n, b_n)` (no node can learn another's load within the window). Let `S = Σ_n b_n`.
(Randomisation cannot beat a worst-case adversary for a *hard* overshoot bound, so deterministic
pre-authorisation is the right abstraction.)

**Lemma (worst cases).** For a fixed allocation `b`:
- `Δ = (S − L)^+`. *Proof:* the adversary offers `d_n ≥ b_n` to every node, so `A = Σ min(d_n,b_n)
  = Σ b_n = S`; and `A ≤ S` always, so this is worst.
- `U = (L − min_n b_n)^+`. *Proof:* the adversary offers `d = L` to a single node `m` with
  `b_m = min_n b_n` and 0 elsewhere. Correct `= min(L, L) = L`; admitted `= min(L, b_m) = b_m`
  (when `b_m ≤ L`); so `U = L − b_m`. No demand vector does worse (any other concentration hits a
  node with `b_n ≥ b_m`).

**Theorem.** For every zero-coordination allocation,
```
        Δ + N · U ≥ (N − 1) · L ,
```
and the bound is **tight** (attained by the uniform allocation `b_n = L/N`).

**Proof.** From the lemma, `S ≤ L + Δ`, hence `min_n b_n ≤ S/N ≤ (L + Δ)/N`. Then
`U = (L − min_n b_n)^+ ≥ L − (L+Δ)/N`, i.e. `N·U ≥ N L − (L + Δ) = (N−1)L − Δ`, which rearranges to
`Δ + N·U ≥ (N−1)L`. Tightness: with `b_n = (L+Δ)/N` for a chosen `Δ ≥ 0`, `min_n b_n = (L+Δ)/N`, so
`N·U = (N−1)L − Δ` and `Δ + N·U = (N−1)L` exactly. ∎

**Interpretation — the two corners are both ruinous without coordination:**
- *Exact (`Δ = 0`)* forces `S ≤ L`, so the min-budget node holds `≤ L/N`; a single hot node is
  throttled to a `1/N` share → `U ≥ L(N−1)/N`. Massive waste under skew.
- *Work-conserving (`U = 0`)* forces every `b_n ≥ L`, so `S ≥ N L` → `Δ ≥ (N−1)L`. Massive overshoot.

You cannot have both at `C = 0`; `Δ + N·U` is pinned at `≥ (N−1)L`. (Verified exhaustively for
`N ∈ {2,3,4}` in the test, including tightness via the uniform allocation.)

## Coordination is the only escape — and that is where GALE lives

The bound is about `C = 0`. **Coordination defeats the adversary**: if the hot node can *fetch* more
budget when it sees demand, it need not be pre-authorised for `L`. This is exactly GALE:
- **Window-coupled escrow (Pillar 1)** gives `Δ = 0` *independent of `N`* (proved in
  `spec/GaleWindowCoupledLeasing.tla` / `test/gale/leasing-variants.test.ts`).
- **Lease-on-demand + adaptive sizing (Pillar 2)** lets a hot node lease more, driving `U → 0` (up to
  a bounded stranding slack), at a coordination cost the online learner *minimises* with `O(√T)`
  regret. Measured utilisation 0.80–0.89 under skew (`test/gale/lease-sizer.test.ts`).

So GALE sits at the `Δ = 0, U ≈ 0` point that the trilemma proves is **unreachable at `C = 0`**, and
spends only the coordination the bound says is unavoidable.

## How much coordination? (the other edge)

The theorem prices the `C = 0` slice. The *cost of `C` itself* — how much communication exact,
work-conserving global admission needs — is bounded below by the distributed-counting and
functional-monitoring literature: maintaining an exact shared count forces a per-processor message
bottleneck (**Wattenhofer & Widmayer, JPDC 1998**), and continuously tracking whether a distributed
sum crosses a threshold to within `(1±ε)` costs `Θ̃(k/ε)` communication (**Cormode, Muthukrishnan &
Yi, SODA 2008**; **Woodruff & Zhang, STOC 2012**) — diverging as `ε → 0` (exactness). Together: the
`Δ–U` edge is the **elementary** bound above (it is *not* implied by — nor does it imply — those
counting bounds; the two price orthogonal axes); the `Δ–C` edge is the counting bounds; GALE is the
scheme that spends bounded `C` to hold `Δ = 0` and `U ≈ 0` simultaneously, which no `C = 0` protocol can.

## Partial coordination: the `0 < C < N` interpolation

The theorem prices the no-coordination slice (`C = 0`) and GALE prices the well-coordinated corner.
What lies between? Here is a clean, tight interpolation in the **static-partition** model of partial
coordination.

**Model.** Partition the `N` nodes into `m` groups. Within a group the members share **one budget
pool** `P_j ≥ 0` atomically — intra-group coordination, so any member may draw the whole `P_j`;
between groups there is none. Maintaining a shared pool across a `g`-member group costs `g − 1`
coordination links per window (a spanning tree over its members), so the total coordination is
`C = Σ_j (g_j − 1) = N − m`.

**Reduction lemma.** A group of any size `g` with pool `P` behaves as a **single super-node of budget
`P`**: flooding it admits `min(Σ d, P)` (its overshoot contribution is per-*pool*, `P`, not per-node),
and a *lone* hot member can draw the whole pool, so its worst-case under-utilisation is `(L − P)^+` —
strictly better than the `(L − P/g)^+` an uncoordinated split of `P` into `g` budgets would suffer.
*The pool is the point: coordination lets the hot member reach budget that, uncoordinated, would sit
idle on its peers.*

**Corollary (static-partition trilemma).** The `m` groups are therefore `m` zero-coordination
super-nodes with budgets `P_j`, and the main theorem applies verbatim with `N := m`:
```
        Δ + (N − C) · U ≥ (N − C − 1) · L ,     C = N − m ∈ {0, …, N − 1},
```
tight at uniform pools `P_j = L/m`. The floor decays **linearly — one `L` per coordination link** —
from `(N−1)L` at `C = 0` (recovering the theorem), through `(N−C−1)L` in between, to `0` at `C = N−1`
(a single group of `N` — full coordination, the GALE corner). Machine-checked exhaustively in
`test/gale/trilemma.test.ts`: the reduction lemma, the bound + tightness for each `m`, and the linear
floor decay (`N=4`: `3L, 2L, L, 0`).

**Static vs. dynamic coordination — why GALE beats this bound.** The interpolation is for *static*
partitions: budget is committed per group up front, and coordination only *shares within* a fixed
group. GALE's leasing is **dynamic and demand-driven** — a single round trip pulls a whole batch `B`
from the shared L2 *to wherever demand just appeared*. That is strictly more powerful per message:
even **one** dynamic fetch defeats the single-hot-node adversary that pins `U` at `C = 0` (the hot node
simply leases more), whereas in the static model one link merely merges two groups (one `L` off the
floor). This is the honest reason GALE reaches `Δ = 0, U ≈ 0` with *bounded* coordination while the
static interpolation needs `C = N−1`: it is the **demand-driven** *use* of coordination, not merely its
quantity, that breaks the trilemma cheaply. A tight lower bound for the *dynamic* `≤ C`-message model —
where one message may redirect a bounded batch `B` — is **open**; the static-partition bound is the
clean, provable anchor between the `C = 0` theorem and the `Δ–C` counting bounds.

## Scope / honesty
- The theorem is a **single-window, deterministic, hard-worst-case** bound — clean and tight.
  Amortised/randomised/multi-window relaxations (where overshoot is averaged or probabilistic) are a
  natural extension, noted not modelled. The `C = 0` abstraction (pre-authorised budgets) is the
  standard one for "no communication"; partial coordination (`0 < C < N`) is characterised above in the
  **static-partition** model (tight, machine-checked), and a tight bound for the *dynamic* `≤ C`-message
  model is the open question.
- This bound concerns the *allocation* tension; it complements, and does not replace, the counting
  lower bounds that price `C`.
