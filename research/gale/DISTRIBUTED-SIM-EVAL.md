# GALE at-scale evaluation — discrete-event simulator

Stress-tests GALE window-coupled leasing under a **realistic asynchronous model** the TLA⁺/BFS proof
does not cover: continuous-time Poisson arrivals with per-node skew, lease round-trip **latency**, and
network **partitions**, across **N → 512 nodes**. It is the part of the distributed evaluation that is
doable locally — a real multi-region cluster still needs cloud VMs (the remaining open systems work);
this is the credible simulator that anticipates it. Engine: [`../../test/gale/discrete-event-sim.ts`]
(gated by `discrete-event-sim.test.ts`). Reproduce:
`npx tsx research/gale/distributed-sim-eval.ts` (writes `distributed-sim-eval.json`).

**Headline:** the proven Pillar-1 overshoot bound (`windowCoupled ⇒ admitted ≤ L per window`) survives
asynchrony, latency, skew, and partitions **independent of N up to 512** — these degrade *utilisation*
and *coordination*, never *safety*. The reason is structural: the shared L2 budget is decremented
**atomically** per grant (modelling a Redis/Postgres atomic counter), so concurrent in-flight lease
requests serialise and the total granted per window never exceeds `L`.

## A. Safety & coordination vs N (windowCoupled, 3× overload, latency 5 ± 3 ms, B = 20)

| N | max overshoot Δ | utilisation | lease round trips | rt / window |
|---:|---:|---:|---:|---:|
| 2 | **0** | 0.808 | 810 | 41 |
| 8 | **0** | 1.000 | 2 542 | 127 |
| 32 | **0** | 1.000 | 6 750 | 338 |
| 128 | **0** | 0.844 | 18 392 | 920 |
| 256 | **0** | 0.700 | 27 223 | 1 361 |
| 512 | **0** | 0.387 | 38 164 | 1 908 |

- **Δ = 0 at every N** — the safety bound is fleet-size-independent under the async model, exactly as
  the single-window proof predicts.
- **Coordination grows with N** (round trips climb as more nodes lease) but stays bounded per window.
- **Utilisation collapses at large N with a *fixed* batch** (0.39 at N = 512): with `L = 1000, B = 20`
  only ~`L/B = 50` of the 512 nodes can lease per window, and each leaser strands the `B − used`
  credits it cannot spend. This is **not** a safety problem — it is the Pillar-2 lesson, *measured*:
  the safe batch is N-independent, the *efficient* batch is not, so `B` must shrink / be learned as the
  fleet grows (GALE Pillar 2, online lease sizing). The simulator makes the case for adaptive sizing
  concrete.

## B. windowCoupled vs carryover overshoot vs N (demand 30 < batch 50)

| N | windowCoupled Δ | carryover Δ | C·(B−1) envelope |
|---:|---:|---:|---:|
| 8 | **0** | 0 | 392 |
| 32 | **0** | 0 | 1 568 |
| 128 | **0** | **200** | 6 272 |
| 256 | **0** | **200** | 12 544 |

Window-coupling holds Δ = 0 throughout. Carryover (leased credits persist across the boundary) leaks
once the budget binds (N ≥ 128 here) — Δ > 0, within the proven `C·(B−1)` envelope — confirming, under
the async model, the contrast that the synchronous `test/cost/distributed-budget.ts` proves: expiring
credits at the window boundary is what buys the N-independent zero.

## C. Latency sensitivity (N = 64, windowCoupled)

| lease RTT (ms) | max overshoot Δ | utilisation |
|---:|---:|---:|
| 0 | **0** | 0.962 |
| 5 | **0** | 0.960 |
| 20 | **0** | 0.955 |
| 50 | **0** | 0.949 |

Safety is **invariant to latency** (a slow grant lands in a later window and draws *that* window's
budget — never an extra). Utilisation barely moves (0.962 → 0.949 across a 50 ms RTT): a node waiting on
a grant briefly idles, but the budget is still consumed.

## D. Partition (N = 64; 16 hot nodes cut from L2 for windows 5–12)

- **max overshoot Δ = 0** — safety survives the partition.
- **Cut nodes are starved (fail-closed):** their admissions fall `6160 → 4020` — a partitioned node
  serves only its existing credits, then sheds (it cannot lease).
- **The fleet reclaims the freed budget:** global utilisation `0.952 → 0.938` (barely down) — reachable
  nodes lease what the cut nodes cannot. A partition costs the cut node, not the budget, and never
  safety.

## Honest caveats

- **Simulation, not a cluster.** This is a single-process discrete-event simulation; the atomic L2 is a
  serialised counter (faithful to a Redis/Postgres atomic `INCR`, but not network hardware). A real
  multi-region deployment on cloud VMs remains the open systems work — this de-risks and predicts it.
- **Poisson arrivals.** Inter-arrivals are exponential with per-node skew; replaying real
  request-arrival traces would refine the *utilisation* numbers (not the *safety* result, which is
  distribution-free — it holds for any arrival pattern because grants are atomic).
- **The N = 512 utilisation dip is a fixed-B artifact**, addressed by Pillar-2 adaptive sizing; it is
  reported precisely because it is honest and it motivates the learned-sizing component.
