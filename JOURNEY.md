# ThrottleKit — Build Journey

A running, dated log of how ThrottleKit is built: decisions, dead-ends, and the
reasoning behind them. Newest entries at the top.

---

## 2026-06-30 — A performance optimization sweep (measured before/after)

Ran a multi-agent performance audit across all three libraries — core, the server (`throttlekit-server`),
and the Python client (`throttlekit-py`): fan out finders by perf dimension, then *adversarially* verify every
finding for **hotness × impact × safety** before it could land. 33 opportunities found, 29 confirmed, 4
dismissed on honest impact (real inefficiencies, but negligible on network/cold paths). The gated ~169 ns
`gcra checkSync` hot path yielded **zero** findings — the right outcome; it's already allocation-tight.

**Measurement-first, because a perf "win" you can't measure is a regression waiting to happen.** Most of the
audit's targets sat on paths with *no benchmark* — the multi-dimension combine, the two-tier WFE grant, the
server `Check` handler. So step one was benches for those (wired into the machine-independent `bench/gate.ts`),
which made the wins provable and, going forward, regression-guarded. Same-machine, median-of-3 before/after
(unoptimized `7db5c65` vs the optimized tree):

| Path | Before | After | Δ |
|---|--:|--:|--:|
| `multiRateLimit.checkSync` (2-dim) | 4968 ns | 2968 ns | **−40%** |
| `multiRateLimit.checkSync` (3-dim) | 7507 ns | 4599 ns | **−39%** |
| `weightedFairEscrow` grant (8 tenants) | 182 ns | 155 ns | **−15%** |
| server `RateLimiter.Check` handler | 898 ns (1.11M/s) | 675 ns (1.48M/s) | **−25%** |
| `gcra` / `tokenBucket` / `fixedWindow` checkSync | 176 / 190 / 206 | 173 / 191 / 204 | flat (gate untouched) |

**The hero** was almost embarrassing: the multi-dimension sync path deep-`structuredClone`d *every* dimension's
stored state per decision to protect the no-partial-consume contract — even when that state is an immutable
primitive (GCRA's `Strategy<number>`). Guarding the clone on object-ness (primitives pass straight through;
object/array states still clone) cut ~40% off the common per-IP∧per-user composite, byte-identical decisions.
Three independent finders converged on it.

**The one with a real trap** was the WFE aggregate. Replacing the O(active-tenants) rescan with running
`Σweight`/`Σused` counters is only safe for *integer* weights and costs — a mutation-order float sum can
1-ULP-diverge from a fresh rescan and flip a floor. So the fast path is gated on integers and falls back to the
rescan the instant a fractional value enters; the new conformance test drives fractional adversarial timelines
*and* carries a **gate-guard** proving the gate is load-bearing (a counter-mode aggregate genuinely diverges
from the rescan oracle, so the suite fails if anyone removes the gate). A measured −15% on the side.

**Honest scoping.** #3 coalesces the `ttlFloorMs` floor into the strategy eval in one pipelined round trip — but
only for clients that expose `pipeline()` (ioredis); `fused-conformance` drives node-redis (no `pipeline()`),
so its bounded retry stays and the comment now says exactly why. Deferred, with rationale in
`research/perf/FOLLOWUPS.md`: the OCC connection pool (niche custom-strategy path, would add a public `close()`
+ an idle-socket leak), the slidingWindow `HGETALL` (blocked by the frozen, checksummed wire scripts), and the
Postgres 5-statement collapse (the proposed CTE is unsafe — advisory-lock ordering is proof-load-bearing).
Three more (multi double-check-commit, heartbeat Lua, monitor double-wrap) skipped as high-risk/low-reward.
"Optimize as much as possible, but safely" meant taking the niche-but-safe long tail (leaky `reserveSync`
reuse, Python `slots`, capture/monitor cleanups, a Postgres `RETURNING` round-trip drop, …) while *declining*
the ones that buy a vanity number at real risk.

**Two dead-ends worth recording.** (1) A fix agent was killed mid-flight by a monthly spend limit, leaving a
half-finished commit in the tree; rather than trust it, I reviewed the diff and the new test by hand and ran
the full verification it never reached before committing. (2) A live-Redis run went red — and it was *not* the
code: the Docker daemon had crashed (`ECONNREFUSED`, a hook timeout), not an assertion. The recurring lesson on
this box: an infra failure and a logic failure look different if you actually read the error.

**Status.** 18 optimizations landed across the three repos as small byte-identical commits, each behind a test
or benchmark. Verified green: storeless core **1469**, server **321**, consolidated live-store (Redis+Postgres)
**608**, the bench gate (no regressions), lint + strict types on both. Committed on `main` in both repos,
**not yet released** — clean patch bumps (core 1.6.1 / server 0.4.4 / py 0.5.1) pending the call.

## 2026-05-28 → 06-23 — Catch-up: 0.8 → 1.6, the embedded-library pivot, and the scaling arc

A consolidation entry — the journal skipped a busy five weeks. The through-line, so the gap isn't a hole:

- **1.0.0 (2026-05-31): the stability signal.** After a fast 0.8 → 0.13 run hardening the surface, cut the 1.0
  with a frozen public API — the contract the later distributed work builds on without breaking callers.
- **Python client + store breadth (1.1–1.2, server-door, early June).** `throttlekit-py` shipped (async
  backends, framework adapters), and non-Redis stores (Postgres, DynamoDB) became reachable from Python via the
  service door rather than re-implementing the oracle.
- **The product pivot — the embedded-library wedge (Road B, 06-08).** Rather than chase a fleet/wire build
  first, the bet: make the single-process library undeniable — multi-axis attribution + deterministic replay —
  *then* distribute.
- **Replay (→ `throttlekit@1.3.0`, server `0.1.0`/`0.2.0`, 06-09).** A deterministic decision recorder/replayer
  + candidate-compare scorecard (`throttlekit/testkit`); server-side opt-in capture (durable, AES-GCM-redacted,
  fail-closed) and a "what-if" replay tab in the terminal dashboard. Two security rounds fixed a critical
  unbounded-redaction-map leak and a tenant-scope leak.
- **Policy Plans (→ `throttlekit@1.4.0`, server `0.3.0`, 06-10).** "terraform plan for limits": replay recorded
  traffic against a *candidate* policy and diff allow↔deny before deploy (`throttlekit/policy`).
- **The scaling arc — "one oracle, four doors, two tiers" (P0–P9, → 1.5.x / server `0.3.0` / py `0.5.0`).** With
  the wire-freeze reauthorized (additive-only, `buf`-gated), the distributed features (federation, fleet budget,
  distributed concurrency, store-backed cross-region fair escrow) became reachable from every language over the
  service door; a read-only **Monitor** door + Prometheus/health landed; and a Tier-2 **`Fleet.Reserve`** lease
  shipped — lease a batch, spend locally byte-identical to the core L1, conformance-vector-pinned. The Python
  client reached parity (`throttlekit-py@0.5.0`: Fleet + Monitor clients).
- **A full-codebase audit (→ `throttlekit@1.6.0`, server `0.4.3`, 06-23).** Find → reproduce → adversarially
  verify; 28 confirmed bugs fixed as clean bisectable commits (a Redis-coordinator over-eviction, an in-flight
  federation lease crossing a window roll, a multi `reset()` prefix no-op, an OCC lost-update, …), plus the
  determinism root-fix (`ttlFloorMs`) decoupling Redis GC from the logical window.

The monitoring story also settled in this stretch: the web "Lens" pivoted to a built-in **terminal dashboard**
(`throttlekit-server --tui`).

## 2026-05-27 — 0.7.0: the learned/predictive layers ship

The research that sat gated under `test/` now lands in `src/`. Four primitives, one per GALE/TALE
learned layer, each a faithful port of its proven kernel:

- **`learnedReservation`** (TALE L2) + **`predictiveReservation`** (TALE L3) in `src/admission` — the
  online newsvendor reservation that paces admission over `tokenBudget`, and its
  predictions-with-safety sibling.
- **`leaseSizer`** (GALE P2) + **`predictiveLeaseSizer`** (GALE P3) in a new `src/twotier/sizing.ts` —
  online-EOQ lease-batch sizing and its prediction-augmented form.

The deliberate scoping call: ship them as **standalone, pure learners**, *not* wired into the `twoTier`
hot path. The sizers advise `lease.batch`; live in-loop adaptation touches the proven async leasing
path and is best validated by the at-scale cluster eval, so it's a separate, later step. The
reservation learners pair with `tokenBudget` (the meter holds safety; the learner only paces). Nothing
in the proven core changed — these are purely additive.

Source-of-truth discipline: rather than duplicate-and-hope, each shipped primitive's test
**cross-checks it byte-identically against the research kernel** it was ported from (many seeds, every
step, reservations/sizes *and* Hedge weights). That both proves the shipped code inherits the kernel's
guarantees and makes drift impossible — any divergence turns CI red. The reference kernels stay
pristine; the equivalence test is the bridge. 460 → 490 tests; full
lint+typecheck+suite green at every one of the four feature commits.

One self-caught slip worth recording: `tsc` flagged an unused research import in the Pillar-3 test that
biome missed — the same TS6133 class that bit a commit two releases ago. The per-commit `npm run check`
(lint **and** typecheck **and** test) caught it before it could land. The lesson holds: typecheck every
commit, biome alone is not enough.

## 2026-05-27 — 0.6.1: the dynamic trilemma bound, on the record

Docs release. The package code is byte-identical to 0.6.0 — the dynamic `≤C`-message bound was
research/test/docs only — so `0.6.1` is a README republish (the 0.5.1 pattern) recording the now-proved
`Δ + N·U ≥ (N−1)(L − C·B)` (tight at `B=1`) in the research framing on the npm page. Honest scope: the
proven core is elementary and the practically-relevant batched case (`B>1`) stays open — the release
reflects the result, it doesn't add library functionality.

## 2026-05-27 — the dynamic `≤C`-message trilemma bound (the last open theory piece)

Closed the dynamic counterpart to the static-partition interpolation — coordination as *demand-driven
leasing* capped at `C` round-trips of batch `B` (the GALE model), windowCoupled so `Δ=0`. Ran it
Stage-1-first: an exhaustive solver (`test/gale/dynamic-coordination.ts`) computes `U* = min over
pre-auth of max over demand` of under-utilisation, exactly, for small `(N,L,B,C)`. The data drove the
proof.

Result: **`Δ + N·U ≥ (N−1)(L − C·B)`** (single-hot-node adversary), **tight at unit batch `B=1`**, where
`U* = (N−1)(L−C)/N` — each unit of dynamic coordination buys back `(N−1)` from the static floor, so the
floor trades against the *reach* `C·B`, not the number of groups. That is the precise reason
demand-driven leasing breaks the trilemma where static partitioning can't.

The honest open piece, which the solver pinned down rather than hid: for **batched** leasing
(`B>1, C≥2`) a *"barely-hot-then-starve"* adversary baits a node into leasing a full batch, uses one
token, moves on — stranding `B−1` and burning a round-trip. So `U*` exceeds the single-hot bound
(`N=3,L=9,B=3`: bound predicts `4,2,0` for `C=1,2,3`; truth is `4,4,4` — tight at the single lease, gap
opens at `C≥2`). The tight closed form there is the remaining open problem (a genuine online-stranding
lower bound); uniform pre-auth is optimal throughout (machine-verified). Resisted forcing a clean
general formula — `B=1` is genuinely tight and proven, `B>1` is genuinely open, and saying exactly that
is the result. Gated in `dynamic-coordination.test.ts`; TRILEMMA.md + PROPOSAL/DRAFT/OUTLINE/SCOREBOARD
updated.

## 2026-05-27 — 0.6.0: `tokenBudget` ships + a provability rebrand

Cut **`throttlekit@0.6.0`** — the first release carrying the TALE Layer-1 meter as a public primitive
(`tokenBudget`), plus this session's version-const fix. Paired it with a **rebrand**: the README now
leads with the one thing no other JS limiter has — a machine-checked, fleet-size-independent overshoot
bound — under the line *"rate limiting you can prove,"* trimmed ~220 → ~110 lines (the wiki holds the
full guides), with a matching npm description and an `llm` keyword. The research advances this session
(the `0<C<N` interpolation, the L2/L3 regret analysis, the N→512 discrete-event sim) are noted in the
changelog as gated under `research/`, **not** shipped in the package — the published surface is just
the library + `tokenBudget`. Minor bump (additive, backward-compatible); held the 1.0 signal since the
public API may still move.

## 2026-05-27 — GALE at scale: a discrete-event simulator (N → 512, latency, partitions)

Built a discrete-event simulator (`test/gale/discrete-event-sim.ts`) to carry the Pillar-1 overshoot
bound past its single-window synchronous proof into a realistic async model: continuous-time Poisson
arrivals with per-node skew, lease round-trip latency, and network partitions, across N → 512 nodes.

The headline holds: **windowCoupled Δ = 0 at every N from 2 to 512**, under latency and skew — because
the shared L2 budget is decremented *atomically* per grant (a Redis/Postgres `INCR`), so concurrent
in-flight leases serialise and never over-grant. Latency only delays grants (Δ=0 even at 50 ms RTT,
util ~0.95); partitions fail closed (cut nodes starved 6160→4020, fleet reclaims the budget
0.952→0.938, Δ=0); and the B=1 zero-latency case is byte-identical to the synchronous
`simulateDistributedBudget` kernel — the engine validated against the proven model.

The honest, useful finding: with a *fixed* batch B=20, utilisation collapses at large N (1.0 → **0.39**
at N=512) — only ~L/B≈50 of 512 nodes can lease, each stranding the rest. That is *not* a safety problem
(Δ stays 0); it is the Pillar-2 lesson, measured — the *safe* batch is N-independent, the *efficient*
one is not. Reported precisely because it motivates adaptive sizing rather than hiding it.

Two test-premise corrections the sim forced out (it taught me my own assertions were wrong): (1) under
heavy overload, partitioning one node doesn't change *aggregate* shed — reachable nodes absorb the freed
budget — so the real effect is *per-node* starvation; added per-node admit tracking and asserted that.
(2) Carryover only leaks when nodes hold leftover credits at the boundary (demand < batch), so the leak
test needed a controlled demand-below-batch scenario, not overload. Also caught & fixed a self-inflicted
regression — the trilemma commit had an unused var `tsc` flags but biome didn't, committed without
re-running typecheck (fixed in c637317; `npm run typecheck` is now in the pre-commit ritual). The
remaining open systems work is a real multi-region cluster (needs cloud); this de-risks and predicts it.

## 2026-05-27 — TALE L2/L3 regret & consistency bounds, instantiated

Wrote out the L2/L3 online-learning guarantees with the **explicit constants and assumptions for our
loss** (`research/cost-uncertainty/REGRET-ANALYSIS.md`), so the proposal's `O(√T)` and
"consistency/robustness" claims are precise — and, as agreed, framed as *known machinery on the cost
axis*, not new theory (the load-bearing novelty is L1's bound + safety decoupled from the learner).
L2: Zinkevich OGD on the pinball loss ⇒ `R_T ≤ (3/2)·D·G·√T`, `D = r_max−r_min`, `G = max(h,p)`, with
the newsvendor `τ = p/(h+p)` quantile as the comparator. L3: Jensen + Hedge ⇒ `Σℓ(blend) ≤
min(L_follow, L_robust) + O(√T)` (consistency to perfect advice, robustness to adversarial), with
unconditional safety from the meter.

Two honesty catches the careful instantiation forced out, both now stated plainly. **(1) Integer
rounding.** The reservation is rounded for admission, so the clean `O(√T)` is the *continuous* OGD
trajectory; rounding adds a `G`-Lipschitz `≤ G/2` per-round term to the *played* loss. Measured, it's
tiny (`|rnd−cont|` = 0/6/27/93 over `T` = 100..6400, vs the `(G/2)T` = 200..12800 worst case) — the
half-token errors mean-cancel — and it never touches safety. **(2) Fixed Hedge η.** The shipped default
`η=0.01` gives the consistency/robustness *dichotomy* for any `η>0`, but the worst-case `√T` *rate*
needs an annealed/tuned `η` — said so, rather than quietly claiming `√T` for the fixed-`η` code.

Verified: added an envelope check to `learned-reservation.test.ts` (continuous regret `≤ (3/2)DG√T` at
four horizons; the rounding term `≤ (G/2)T`), and a throwaway run confirmed the regret is genuinely
positive and sits at 3–7% of the envelope (worst-case bounds are loose on benign stationary data, as
expected). PROPOSAL/SCOREBOARD updated to point at the analysis.

## 2026-05-27 — the trilemma's `0 < C < N` interpolation

Closed the standing open piece of the GALE capstone — what happens *between* zero coordination and
GALE's well-coordinated corner — in a clean, tight, machine-checked form. The model: partition the `N`
nodes into `m` groups that each share **one budget pool** atomically (intra-group coordination, none
across); maintaining `m` pools costs `C = N − m` links/window. The **reduction lemma** is the crux: a
size-`g` group with pool `P` behaves as a *single super-node* of budget `P` — a lone hot member draws
the whole pool, so its under-utilisation is `(L−P)⁺`, not the `(L−P/g)⁺` of an uncoordinated split.
The `m` groups are then `m` zero-coordination super-nodes, so the main theorem applies with `N := m`:

```
        Δ + (N − C)·U ≥ (N − C − 1)·L ,   tight,   C = N − m ∈ {0,…,N−1}.
```

The floor decays **linearly — one `L` per coordination link** — from `(N−1)L` at `C=0` to `0` at
`C=N−1`. Verified exhaustively (`test/gale/trilemma.test.ts`): the reduction lemma, the bound +
tightness per `m`, and the floor sequence `24,16,8,0` at `N=4, L=8`.

The honest boundary — and the genuinely interesting part. This is a *static-partition* model; it is
**not** a universal lower bound for "≤ C messages." GALE's leasing is *dynamic and demand-driven* — one
round trip pulls a whole batch to *wherever demand just appeared* — which is strictly more powerful per
message: even **one** dynamic fetch defeats the single-hot-node adversary that pins `U` at `C=0`,
whereas a static link only merges two groups. So the static interpolation is the provable anchor, and
the tight bound for the *dynamic* `≤C`-message model is the real open problem (and explains *why* GALE
reaches `Δ=0, U≈0` cheaply: the demand-driven *use* of coordination, not its quantity). Resisted the
temptation to claim the static bound as the general one — it isn't, and the central-pool counterexample
(one message redistributing the whole pool) shows it. TRILEMMA.md, the PROPOSAL/DRAFT/OUTLINE "open"
framing, and SCOREBOARD updated to match.

## 2026-05-27 — TALE Layer 1 ships as `tokenBudget`

The streaming token-budget meter — TALE's load-bearing Layer 1 — graduates from the research kernel
(`test/cost/token-budget.ts`) into the published library as **`tokenBudget`**, in the `admission`
module beside `fairShare`/`weightedFairShare`. It enforces a per-window token budget when cost is
*post-hoc* (LLM output tokens, known only as they stream): debit actual tokens as they're produced; a
debit is admitted iff budget remains *before* it, so worst-case overshoot is bounded by the debit
granularity — **exactly 0 per token**, `≤ g−1` at chunk `g` — *independent of the per-request cap and
of concurrency* (only the single crossing debit can exceed the budget, no matter how many streams
meter at once).

Two decisions worth recording. **(1) Stop-at-boundary, not pre-check.** The meter counts the crossing
debit in full rather than refusing it — the tokens are already produced (that *is* what "post-hoc
cost" means), so honest accounting plus stopping future production is both correct and provably
minimal: you can't beat `Δ ≤ g−1` without knowing cost in advance. **(2) Naming.** `tokenBudget` sits
one letter from `tokenBucket`, but they have disjoint option/return types, so a wrong pick is a
*compile* error under strict TS — and the name keeps the code↔proposal↔paper story consistent. A
JSDoc `@see` spells out the distinction (rate limiter vs fixed post-hoc quota).

Tests cross-check the shipped meter against the research `simulate(…, "streaming")` kernel for
byte-identical overshoot over 200 randomized property runs, plus the tight `Δ = g−1` worst case,
concurrency-independence, cap-independence, window roll, `remaining()`, and the `Decision` contract.
Suite → **442**. Also synced the stale `version` const (0.3.0 → 0.5.1, its own commit). Not released
yet — lands in the next version bump.

## 2026-05-26 — 0.5.1: lean README + a GitHub wiki

Refit the public face. The README had grown to ~600 lines of reference; rewrote it to ~220 that lead
with what's *provably* different — the formally-verified, fleet-size-independent overshoot bound; one
transform across in-memory/Redis/Postgres proven bit-identical; the sync API; and the GALE/TALE
tracks — keeping the honest "here's where it loses" voice, which for a correctness library *is* the
credibility. The per-feature walkthroughs moved into a new **GitHub wiki** (10 guides + Home/sidebar/
footer), so nothing was lost, only relocated.

One snag worth recording: GitHub's wiki has no content API and the `.wiki.git` repo is created lazily
on the *first* page saved through the web UI — so a push to an "enabled but never opened" wiki returns
*Repository not found*. Initialising it took one manual UI click; the 13 pages then force-pushed from
a local clone over the throwaway init page.

Cut **`throttlekit@0.5.1`** to refresh the npm package page with the new README (and a matching
one-line description leading with the proven bound). Docs-only — no code or API change.

## 2026-05-26 — 0.5.0: Weighted Fair Escrow ships

Promoted GALE Pillar 4 from research into the published library and cut **`throttlekit@0.5.0`**. The
proven weighted max-min allocator is now a public primitive:

- **`weightedMaxMin(demands, weights, limit)`** — exact integer weighted max-min: work-conserving
  (sums to `min(Σ demand, limit)`; an idle tenant's share flows to the backlogged) and weight-honoring
  (a common weighted service level `a_i/w_i`, ≥ each tenant's floor `⌊w_i/W·L⌋`). Computed as
  continuous water-filling + a bounded integer drip of the `< n`-credit remainder — `O(n log n)`, not
  the research kernel's `O(limit·N)` unit-drip, so it's fast for large budgets. The four Pillar-4
  theorems are re-checked on 5k random instances against the *shipped* code.
- **`weightedFairShare`** — the online streaming limiter: `fairShare` with weighted caps and the same
  honest online caveats.

**The scoping call.** The original note said "ship WFE into `src/twotier` (weighted lease grant)." But
on reading the code, the leased path is per-key and the L2 grant is FCFS; making it weighted *across
tenants* needs a global demand view — the core-stateless / no-central-arbiter problem the research
itself flags as open. So the honest, right-sized ship is the in-process primitive (its natural home,
next to `fairShare`), which *composes* with `twoTier` — split a node's leased batch among its local
tenants via `weightedMaxMin`. Distributed weighted *leasing* stays a tracked follow-up, not a rushed
release. (Asked, and the steer was "do what's best" — this is it.)

Also bumped the CI/release workflows to `actions/checkout@v5` + `setup-node@v5` (Node 24 — Node 20
actions are being retired from GitHub runners on June 2). Suite → 430 tests; npm 0.4.1 → 0.5.0.

## 2026-05-26 — TALE × GALE unified: the distributed token meter *is* GALE leasing

Closed the loop between the two papers. The distributed instantiation of the cost-uncertainty thread
— one TPM budget `L` shared across `C` gateways, each leasing `B`-token batches from a shared L2 — is
not merely *like* GALE leasing, it **is** GALE leased two-tier with the token as the unit (a gateway =
a leasing node, a lease = a batch of token budget, the streaming meter debits leased tokens as the
model emits them). `simulateDistributedBudget` (`test/cost/distributed-budget.ts`) runs `C` gateways
round-robin over the shared budget in two modes — window-coupled (leased tokens expire at the TPM
boundary) vs carryover (they persist):

- **windowCoupled global overshoot = 0 for every `C ∈ {1..32}`** — bounded *independent of fleet size*,
  at full utilisation. Carryover leaks up to `C·(B−1)`, growing with `C` (mean 32 → 196 as `C` 2 → 32
  in the un-starved regime) — the fleet penalty window-coupling erases.
- **The reduction is byte-identical:** windowCoupled `produced` equals GALE's request-granular
  `simulateWindowCoupled` `admitted` token-for-token (`C ∈ {2,8,32}`). Same mechanism, different unit.

So multi-gateway TPM sharing inherits GALE Pillar 1's fleet-size-independent overshoot bound for free,
and "escrow under uncertainty" is now a *proven reduction*, not a slogan: GALE escrows across
*placement*, TALE across *cost*, and the distributed cost meter literally runs GALE's leasing. Suite
414 → 419.

## 2026-05-26 — TALE Layers 2–3: learned reservation + predictions-with-safety (cost axis)

Built out the **cost-uncertainty** research thread (`research/cost-uncertainty/`, `test/cost/`) — the
sibling to GALE where the uncertainty is *cost* (an LLM request's output tokens, revealed only as it
streams) rather than *placement*. Layer 1 — the streaming meter, which is window-coupling on the cost
axis, with overshoot independent of `max_tokens` — landed earlier this session; this adds Layers 2–3,
retargeting GALE's Pillar 2/3 machinery onto the new axis.

The reframing that makes L2 distinct from L1: the meter bounds *overshoot* for any reservation, but
admission still has to commit a per-request **reservation** before the cost is known — and that choice
trades two evils. Over-reserve (the Azure `max_tokens` corner) and you starve concurrency and 429
admissible traffic; under-reserve (greedy streaming) and the meter has to abort half-finished
generations at the budget boundary. The per-request regret of a reservation against the realised cost
is exactly the **newsvendor / pinball loss**, minimised at the critical-fractile quantile τ = p/(h+p)
— so the right policy is to *learn that quantile online*.

- **L2 (learned reservation):** projected OGD on the pinball loss. The deliberate departure from
  Pillar 2: that loss has a **bounded, constant-magnitude subgradient**, which is precisely the case
  where vanilla OGD with `η_t = D/(G√t)` is regret-optimal — whereas Pillar 2's *unbounded, smooth*
  EOQ gradient is what earns AdaGrad. (I started with AdaGrad for house-style consistency; a step
  sweep showed it thrashes on the cold start at full-diameter scale, and the fix it pointed to *was*
  the Zinkevich step. Right tool for the loss, not cargo-culted.) Measured: avg pinball regret
  8.49 → 2.77 as T grows (the no-regret signature), converges onto the oracle τ-quantile, beats any
  fixed reservation by 31% under a distribution shift. In the admission loop (L=1000, C=16) the learned
  reservation is the only *implementable* policy with **full utilisation AND ~4 aborts** (matching the
  clairvoyant oracle), where greedy streaming aborts 16 and reserve-max collapses to 0.40 utilisation.

- **L3 (predictions-with-safety):** the realistic LLM predictor predicts output-length *rank*, not
  magnitude (vLLM Learning-to-Rank, NeurIPS'24), so I modelled it as rank-recovery-with-noise mapped
  back through a calibrated length distribution. Feed it as one Hedge expert against the L2 quantile;
  play the weighted-average reservation. Consistency (perfect advice → clairvoyant cost, weight →
  follow), robustness (adversarial advice → the robust quantile at 1.00×, vs 2.14× if obeyed), and the
  headline: **safety is unconditional** — under good *or* adversarial predictions, and even when
  blindly following an anti-correlated predictor, the streaming meter holds overshoot at 0 (g=1) /
  ≤ g−1 (chunked). No prediction, however wrong, can breach the budget — the first
  predictions-with-safety result for token budgets.

The unification is the point: GALE escrows across the **placement** axis (which node will spend the
budget), TALE across the **cost** axis (how much a request will spend) — same mechanism (reserve,
meter actuals, reconcile at the boundary), and L2/L3 are literally GALE's Pillar 2/3 retargeted. All
seeded and gated (`npx vitest run test/cost`); calibration records in
`research/cost-uncertainty/explore-*.ts`. Suite 395 → 414. Still a research artifact, not packaged.

## 2026-05-26 — 0.4.1 release (rolled forward through a GitHub Actions outage)

Cut **`throttlekit@0.4.1`** as the first published version since 0.3.0. It carries the one shipped
public-API addition — `lease.windowCoupled`, the opt-in that makes the two-tier `leased` overshoot
bound *independent of fleet size* — plus the README rewrite. Everything else under `research/`,
`test/gale/`, and `spec/` is research, not packaged (published `files` are `dist` +
README/CHANGELOG/LICENSE; tarball verified clean — 11 subpaths, no source/tests/sourcemaps).

**Why 0.4.1, not 0.4.0:** I tagged `v0.4.0` first, but a **GitHub Actions major outage** (from 10:57
UTC) meant tag pushes created *no* workflow runs — the pushes landed, Actions just wasn't
orchestrating — so 0.4.0 never published. Rather than leave a dangling, never-published 0.4.0 tag, I
deleted it and rolled forward to **0.4.1**, which bundles windowCoupled + the README. npm goes
0.3.0 → 0.4.1.

**Resolution — published.** Once Actions started processing the `v0.4.1` tag, the run still failed —
but not from the outage and not from our config: it died at `actions/checkout` with a 403, *"Your
account is suspended"*. The account-status flag, not a workflow fault, was the binding blocker
(`NPM_TOKEN` was set and `permissions: contents/id-token: write` were correct all along; the job just
never got past step 1, so the publish never ran — which is why npm sat at 0.3.0). The suspension was
transient; once it cleared, **re-running the release went green end-to-end** — checkout → gate → build
→ **`npm publish --provenance`** → GitHub Release. `throttlekit@0.4.1` is now on npm with provenance
(`latest`; versions 0.1.0/0.2.0/0.3.0/0.4.1 — 0.4.0 correctly never shipped). Lesson: a failed release
run's *first failing step* is the real story — "Actions outage" was at most half of it.

Caught a latent bug in the release step on the way: the CHANGELOG note-extraction matched on a
`\[`-escaped regex that gawk mis-parses as a character class (curated notes silently fell back to
auto-generated). Rewrote it `index()`-based — regex-free, portable across awk — and verified it
extracts the 0.4.1 section exactly.

## 2026-05-26 — GALE lands on main; Pillar 4 (weighted fairness) proven

Merged the **GALE** research program (`research/gale/`, `test/gale/`, `spec/`) to `main` — the
serious research bet built on the `leased` two-tier path. The thesis: distributed rate limiting is
*escrow under uncertainty*, and the field has no limiter with a hard, tight overshoot bound that
doesn't blow up with fleet size. The crux insight that reframes it: **stranded capacity *is*
overshoot debt** — both are held-but-unused credits surviving the L2 window boundary, so killing them
tightens overshoot and raises utilisation at once. Four provable layers + a capstone lower bound,
each either machine-checked or measured:

- **P1 (safety, shipped):** window-coupled leasing drops overshoot from `L + N·(B−1)` to exactly `L`,
  *independent of N* — TLA⁺ + an exhaustive BFS twin (self-validated against the published TLC state
  counts 31/441), and it ships as `lease.windowCoupled`.
- **P2 (efficiency):** lease sizing as online EOQ (AdaGrad), `O(√T)` regret.
- **P3 (predictions):** a Hedge meta-learner — consistency when predictions are good, robustness when
  adversarial, safety unconditional.
- **Capstone:** the trilemma `Δ + N·U ≥ (N−1)L`, tight — proved and machine-checked; coordination is
  the only escape, and it's exactly what GALE spends.

**This session's new work — Pillar 4 (Weighted Fair Escrow).** P1–3 fix the *total* credits; they say
nothing about the *split* when the budget is contended. I'd left it as "design only." The gap, made
precise: single-pool leasing splits a contended budget **first-come-first-served — equivalently
*unweighted* max-min**, so a low-priority flood starves a high-priority tenant below its configured
share. The two obvious fixes each fail an axis — static shares honour priority but strand an idle
tenant's slice (not work-conserving); FCFS leasing is work-conserving but weight-blind. WFE makes the
split the **weighted max-min fair** allocation (water-filling) with idle-share reclamation, using only
the shared store — the core-stateless spirit of CSFQ, no central arbiter à la Pisces. Four theorems
(safety inherited, sharing-incentive, work-conservation, DRR-bounded unfairness with the lease size as
the quantum) **machine-checked on 20 000 random instances**; the measured Workload C says it plainly:
WFE is the only split that is both work-conserving (util 1.000, matching weight-blind) and weight-fair
(0 share violations, matching static), at the *same* coordination — fairness is free.

**Two honest calls.** (1) WFE is **not strategy-proof**, and I state it rather than bury it: under the
share guarantee, FairRide's impossibility (NSDI'16) says you can't also be strategy-proof *and*
work-conserving, so we take the sharing-incentive + work-conserving corner; window-coupling at least
makes a demand-inflating tenant strand the credits it can't fill. (2) I kept WFE a **research module**,
not a shipped `src/twotier` API — Pillar 1's `windowCoupled` is a tiny safety flag that earned its
place in the store, but a weighted lease grant is a real cross-node mechanism that should prove out in
research before it touches the production path. Promoting it is noted, not rushed.

**Status:** every gate green; the four-pillar program is proven/measured and on `main`. Docs synced
(PROPOSAL now four pillars, SCOREBOARD has a research-track table, EVALUATION has Workload C).

## 2026-05-26 — Benchmark sweep, and a deliberately-declined optimization

Re-measured the full comparative suite (memory / Redis / Postgres) and audited the docs for drift.
Where we land, honestly:

- **In-process:** `checkSync` ~320 ns (≈allocation-free) beats rate-limiter-flexible's async-only API;
  on the async *counter* path the bare-counter incumbents are ~2–3× faster — inherent, since GCRA over
  a timing-wheel + CLOCK-eviction store is more work than `Map++`.
- **Redis:** tied on p50/throughput (both one atomic round trip); **we win the tail** (p999 ~1.6×
  tighter — cached `EVALSHA` + a leaner script).
- **Postgres:** two opposite truths. rate-limiter-flexible wins the **bare single op ~3×** (its counter
  is one atomic UPSERT; our generic RMW is a ~5-round-trip transaction), but **`twoTier(leased)` over
  Postgres wins throughput ~34×** — measured 12.6k vs 366 ops/s, 79.7 µs vs 2.6 ms/op (one transaction
  per batch; no incumbent equivalent).

Chased the Postgres per-op gap into the implementation. A single-statement SQL fast-path **can't**
safely win here: "deny-doesn't-consume" can't both skip the write *and* return the deny decision from
one `INSERT … ON CONFLICT … RETURNING`, and first-touch concurrency loses updates without the advisory
lock (which needs the transaction). The clean 1-round-trip path is a **server-side PL/pgSQL function**
— a *third* execution path with its own bit-identical conformance, float-exactness risk, and DB
function lifecycle. **Declined on purpose:** Postgres per-op latency only bites at high volume, and at
high volume you use `leased` (already winning 34×), so the function would buy a corner case that barely
exists, at permanent maintenance cost. Honest ROI over a vanity benchmark row.

Net: we win or tie on every axis that matters for real workloads; the only outright losses are
async in-process micro-throughput (vs a feature-less counter) and Postgres bare-single-op — both
corner cases. SCOREBOARD/README synced; `bench:compare` now covers all three tiers + the leased row.

## 2026-05-26 — Tested latency, and Postgres as a first-class backend

Measured the latency story end-to-end (this machine, Node 24, Redis + Postgres in Docker), and
closed the biggest concrete gap vs the incumbents: **backend breadth.**

**Latency, measured (not claimed).** In-process `gcra checkSync` is **~290–350 ns/op** (2–5 B/op);
async `check` ~580–685 ns. The pure-counter incumbents are faster on the *async* memory path
(express-rate-limit 199 ns, rate-limiter-flexible 344 ns) — honestly, because a GCRA cell over a
store that does TTL expiry + CLOCK eviction is more work than `count++` in a Map; our `checkSync`
(293 ns) still beats rate-limiter-flexible's async. On **Redis we tie on p50 and win the tail
decisively** — p99 2461 vs 3045 µs, **p999 6.7 vs 18.5 ms** (tighter tails from `EVALSHA` + leaner
Lua). The ~1.2 ms absolute p50 is a Docker-Desktop-on-Windows loopback artifact, common-mode to both
contenders. **Leased mode is the latency lever**: 100 reqs/round trip ⇒ ~14 µs effective.

**PostgresStore (`throttlekit/postgres`).** A Postgres-only shop previously couldn't adopt us without
standing up Redis. Now there's a fully distributed Postgres backend — and the design keeps the whole
correctness story intact: it runs the **same pure JS transform** the in-memory store runs (no new
algorithm path to verify), inside a transaction serialized per key by a **transaction-scoped advisory
lock**. The advisory lock (not `SELECT … FOR UPDATE`) is the crux: `FOR UPDATE` can't lock a row that
doesn't exist yet, so two first-touch transactions on a new key could race; `pg_advisory_xact_lock`
keyed by the key's hash serializes them regardless, and auto-releases at COMMIT/ROLLBACK. State is
stored as the **same JSON text** the Redis OCC path writes, so decisions are bit-identical across
backends. Expiry is clock-driven (lazy read-filter + background sweep), which is safe precisely
because every built-in strategy is idempotent w.r.t. stale state — the same property the Redis
conformance leans on; injecting the clock even lets the **TTL-expiry conformance test run** here
(Redis has to skip it). Proven on a live server: the full conformance kit, **exactly-K under 200
concurrent checks**, and dual-path equivalence to the JS executor for gcra/tokenBucket/slidingWindow.
A `pg.Pool` is accepted directly (structurally typed — no adapter); `pg` is an optional peer.

Isolation note for future me: tests use a dedicated **`tk-postgres` on 5433**, never the unrelated
`sarva-postgres` on 5432 (mirrors the `tk-redis` 6380 vs `sarva-redis` 6379 split).

**Status:** every gate green — **379 tests** (95.2% lines), lint + strict types clean, build emits
**11 subpaths** (added `/postgres`), `publint` clean, all pushed in small commits. Two more roadmap
items landed the
same day: **`checkMany` / `checkManySync`** (batch checks at one consistent timestamp; an ordered
loop with no per-key promise on a sync store, concurrent on async stores → one round trip on
auto-pipelining clients; threaded through `twoTier` and the analytics/OTel wrappers so batches are
counted too), and the **multi-region story** — which turned out to need *no new engine*: it's
`twoTier` leased over a shared L2, where the already-proven bound caps worldwide overshoot at
`Limit + regions·(batch−1)`. Documented with a runnable example (~50 requests served per cross-region
hop).

The frontier item landed too: **`mergeableSketch`** — a Count-Min Sketch for *cluster-wide*
heavy-hitter detection. CMS counters are linear, so merging per-node sketches (shipped as compact
bytes) is **exact** — counter-for-counter the union sketch — which means a low-and-slow distributed
attacker that hides under every single node's threshold is caught once the views merge, all in fixed
~7.4 KiB per node. Scoped honestly: eventually-consistent *detection* / best-effort shedding, not a
strongly-consistent global limit (that's what the Redis/Postgres stores and `twoTier` are for). The
exact-merge property and byte round-trip are unit-proven. That closes the post-0.2.0 ROI roadmap.

## 2026-05-26 — Past v0.1.0: reach, parity, and a formally-verified frontier

A second push after the publish, aimed at "the go-to package, eyes closed" and then beyond SOTA.
Two threads of background research first (competitive landscape + the algorithmic frontier),
sourced and verified, then execution — ROI-ordered, each feature parallelized to a background agent
on a disjoint file set, reviewed against the code, and gated (lint + strict types + tests + build)
before commit.

**Reach & parity (so it drops into anyone's stack):**

- **Any Redis client.** The store was `ioredis`-only; added `fromNodeRedis` / `fromUpstash` /
  `fromIoredis` adapters, so it now runs on the official node-redis client and the **Upstash REST**
  client — the serverless/edge audience (Cloudflare, Vercel, Deno, Bun) it previously couldn't reach.
  Proven bit-identical to the JS path on a live server via node-redis.
- **Four framework adapters** on a shared core (extracted from Express/fetch): **Hono, Next.js,
  Fastify, Koa** — ten subpath exports now, each an npm-search entry point.
- **Comparative benchmark** vs `rate-limiter-flexible` and `express-rate-limit` on one fair harness.
  It earned its keep immediately: it surfaced that async `check()` ran ~5× slower than `checkSync`
  for no structural reason on an in-memory store. Fixed it (a synchronous-store fast path that
  skips the async store frame + per-call closure) — **596.9k → 1.64M ops/s, a 2.7× win** — keeping
  `checkSync` allocation-free at ~3.2M. We own the sync path, tie on Redis, and report the async
  numbers honestly (the counter libs are faster there; we run GCRA over a bounded-memory store).
- **Trust + DX:** SECURITY policy, code of conduct, issue/PR templates, a resilience guide, a
  comparison table, migration guides (from the incumbents), and recipes.

**Beyond SOTA (the things no Node rate limiter ships):**

- **`sketchRateLimit`** — a Count-Min Sketch limiter that caps an *unbounded* key universe in
  **~7.4 KB total** (independent of key count), for DDoS / huge-cardinality shedding where per-key
  state is itself the exhaustion vector. Check-before-add over a never-underestimating sketch gives
  a *hard* never-over-admit guarantee; error is bounded early denial (`ε·N` w.p. ≥ `1−δ`).
- **`withAnalytics`** — zero-config, dependency-free allow/deny stats + bounded-memory top-K heavy
  hitters (Space-Saving), without an OTel backend.
- **`adaptiveThrottle` + `fairShare`** — Google-SRE client-side adaptive load-shedding (with
  priority) and an honest equal-share cross-tenant fairness splitter (its real limitations spelled
  out, not overstated).
- **A formally-verified leasing bound.** The two-tier `leased` overshoot bound went from
  property-tested to *proven*: a **TLA⁺ spec model-checked with TLC** (invariant holds across the
  full reachable state space; a counterexample shows it's *exact* at `Limit + N·(Batch−1)`), plus a
  Java-free exhaustive checker that reproduces it in CI — independently finding the same state
  counts. The spec models the real `src/twotier/index.ts` line-for-line.

**Status:** every gate green — **355 tests**, 96.9% lines / 86.4% branch, lint + strict types
clean, build emits all 10 subpaths (ESM + CJS + types), `publint` clean. All work pushed in many
small bisectable commits. **Released as `throttlekit@0.2.0`** — live on npm (`dist-tags.latest =
0.2.0`), 601 KB unpacked / 52 files (sourcemaps trimmed), published with provenance via the
tag-triggered Release workflow.

## 2026-05-26 — Published v0.1.0 to npm

`throttlekit@0.1.0` is live on npm (`dist-tags.latest = 0.1.0`), published by the tag-triggered
Release workflow with npm **provenance** via GitHub OIDC. Verified the published tarball is clean —
`dist/` (ESM + CJS + types for all six subpaths), README, CHANGELOG, LICENSE; no source or tests
leak. `npm i throttlekit` works. Added npm/CI/license/types badges to the README. (Sourcemaps make
up most of the ~994 KB unpacked size; a candidate trim for 0.1.1.)

## 2026-05-26 — Feature-complete, measured, and benchmarked

Landed the rest of the surface and proved it: the six strategies (GCRA, token bucket, fixed/
sliding window, sliding log, leaky-bucket shaper), the **two-tier engine** (strict / cached-deny /
leased with a property-tested `overshoot ≤ L×batch` bound), **multi-dimensional `all`/`any`** (a
single fused Lua round trip over k keys, conformance-checked against the atomic memory path),
**adaptive concurrency** (verified Gradient2 + AIMD with an O(1) monotonic-deque rolling-min),
Express + fetch/edge adapters, standards-compliant headers, proxy-correct IP with IPv6 /64
aggregation, OTel instrumentation, the store testkit, and the property/atomicity proofs
(**N=200 concurrent at K=50 ⇒ exactly 50 allowed**, on memory *and* Redis).

Parallelized aggressively with background agents on disjoint file sets (token bucket + fixed
window; adaptive concurrency; adapters/IP/headers; testkit/property/atomicity; OTel; README +
examples), reviewing each against the verified math. Kept ownership disjoint and re-ran the full
gate after each merge.

**The benchmark earned its keep.** Running `npm run bench` surfaced a real GCRA/leaky Lua
robustness bug: with an extreme limit the emission interval falls below the ULP of a large
epoch-ms `now`, so `new_tat − now` rounds to 0 and `SET … PX 0` errors. Guarded `ttl ≥ 1` on both
the JS and Lua persists (decisions are unaffected, so conformance still holds). Also optimized the
synchronous hot path (reuse one transform, skip the Lua-invocation allocation a sync store never
uses): `checkSync` went 955k → **3.13M ops/s (319 ns/op, ~5 B/op)** — sub-microsecond, essentially
allocation-free. Upgraded MemoryStore eviction from FIFO to a correct CLOCK (second-chance)
approximate-LRU with proper tombstone handling.

**Status:** every SCOREBOARD budget met and measured; coverage 96.8% lines; CI green on node
20/22/24 with a Redis service. Remaining: publish hygiene (package validation) and final polish.

## 2026-05-25 — Dual-path proven end-to-end

The central thesis is now demonstrated, not just claimed. Built the vertical slice
(`rateLimit` + `gcra` + `MemoryStore`), the `RedisStore` (atomic Lua via `EVALSHA` with an
`EVAL`/`NOSCRIPT` fallback and an OCC fallback for custom strategies), and a **conformance vector
suite** that runs each strategy through both the JS executor and the Redis-Lua executor across
40×25 generated timelines and asserts bit-identical decision streams — ~49k validated round trips
across GCRA, token bucket, and fixed window, all green.

Key engineering call that makes conformance exact: the TAT (and other fractional state) is stored
in Redis via `string.format('%.17g', x)` so it round-trips through Redis as the *exact* IEEE-754
double, and both paths derive every float from the same integer ARGV with identical operations.
A pleasant discovery: GCRA / token bucket / fixed window are all idempotent w.r.t. stale state
(a TAT in the logical past clamps to `now`; a long-elapsed token bucket refills to capacity), so
the Redis-PEXPIRE-vs-logical-clock mismatch can't cause divergence in the conformance harness.

Parallelized with background agents (research verification, then token bucket + fixed window) while
keeping file ownership disjoint. Test Redis runs on **6380** locally to avoid clobbering an
unrelated `sarva-redis` already on 6379.

## 2026-05-25 — Kickoff & foundations

**Goal for the session.** Stand up a production-grade, framework-agnostic rate-limiting
library from the design doc (`THROTTLEKIT.md`), with provable correctness and measured
performance. Many small, bisectable commits.

**Decisions**

- **Toolchain.** TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`),
  Vitest (unit + property + bench), `fast-check` (property tests), Biome (lint+format, fast),
  `tsup` (dual ESM+CJS+`.d.ts`), Docker Redis for integration/conformance. Node `>=18`.
- **Package shape.** Single package with subpath exports (`throttlekit`, `/redis`, `/express`,
  `/fetch`, `/testkit`, `/otel`). Optional peers: `ioredis`, `express`, `@opentelemetry/api`.
- **Verified the risky math up front** (two parallel research passes, sources in
  `docs/DESIGN-NOTES.md`) before writing a line of algorithm code:
  - GCRA `tau = T·burst` admits exactly `burst` instantaneous requests from cold — matches the
    spec. (Canonical `throttled` uses `T·(burst+1)`; documented difference.)
  - Netflix **Gradient2** exact update rule (gradient clamped `[0.5,1.0]`, smoothing `0.2`,
    tolerance `1.5`, don't-grow-while-under-50%-utilized). The spec's `√limit` headroom comes
    from the older `GradientLimit`; I keep it configurable.
  - IETF RateLimit headers: current draft **-11** uses structured fields
    (`RateLimit` + `RateLimit-Policy`), not the legacy triple. Supporting both, documented.
  - Redis: `EVALSHA`→`NOSCRIPT`→`EVAL` fallback; `{tag}` hash slots; server `TIME` as clock.

**Architecture refinement (vs. the doc).** The single storage primitive becomes
`apply(key, transform)` where `transform(state) -> { state, result, ttlMs }` — the dynamic TTL
moves into the transform result (GCRA needs `ttl = ceil(new_tat − now)`), which is strictly more
capable than a fixed `ttlMs` argument. The optional atomic Lua form rides along as a property on
the transform, so Redis can fast-path built-ins to one round trip while custom strategies fall
back to optimistic concurrency — all behind the same one method a backend author implements.

**Status.** Repo initialized; tooling scaffolded; dependency install + first green CI next.
