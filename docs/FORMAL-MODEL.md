# Formal model of the distributed leasing overshoot bound

ThrottleKit's `leased` two-tier mode trades a small, **bounded** global overshoot
for collapsing network cost from O(requests) to O(requests / batch). This document
records a *machine-checked proof* of that bound. It is a **bounded model check**:
we exhaustively verify the protocol's transition system for small constants, both
in TLA+ (TLC) and in a Java-free TypeScript checker that runs in CI.

- Spec: [`spec/DistributedLeasing.tla`](../spec/DistributedLeasing.tla)
- Config + run notes + captured TLC output: [`spec/README.md`](../spec/README.md)
- CI checker: [`test/twotier/leasing-model.test.ts`](../test/twotier/leasing-model.test.ts)
- Code under verification: [`src/twotier/index.ts`](../src/twotier/index.ts) (the `leased` branch)

## The bound

For the default `lowWater = 0` (purely lease-on-demand) and a per-request cost of
1, with `N` nodes contending on one key, the number of requests admitted within a
single L2 window satisfies the **tight** bound

```
admitted_per_window  <=  Limit + N * (Batch - 1)
```

- **`Limit`** is the L2 budget for the window (the configured rate limit).
- **`N`** is the number of nodes (leaseholders).
- **`Batch`** is the lease size.

Both the TLA+ model (checked with TLC) and the TypeScript checker confirm this
holds on *every* reachable state, and that it is **exact** — some reachable state
attains `Limit + N*(Batch - 1)`, so no smaller bound is valid (see "Tightness").

### Why the overshoot exists

The L2 tier (a fixed-window strategy) resets its budget to `Limit` at each window
boundary. But each node's **local leased credits carry over** that boundary — the
code never clears them on a roll. So at the start of a fresh window a node may
still hold up to `Batch - 1` unconsumed credits left from leases granted in the
previous window. Across `N` nodes that is up to `N * (Batch - 1)` "extra"
admissions that ride on top of the new full `Limit`. That carryover is the sole
source of overshoot — and the model isolates it as the `Roll` action that resets
`l2` and `admitted` while leaving `credits` unchanged.

Each lease grants `Batch` tokens but immediately spends one on the triggering
request, so a node can *carry* at most `Batch - 1` — which is why the per-node
term is `Batch - 1`, not `Batch`. With `Batch = 1` there is no carryover at all
and the leased mode degrades to exactly `Limit` per window (verified as a separate
case in the CI checker).

## Relationship to the library's documented `<= L × batch`

The README and `THROTTLEKIT.md` state the consistency model as: with `L` nodes
each holding at most `B` leased tokens, the global count can exceed the configured
limit by at most **`L × B`** within a refill interval. The proved bound is

```
admitted_per_window  <=  Limit + N * (Batch - 1)
                      =  Limit + (overshoot of N*(Batch-1))
```

so the **overshoot above `Limit` is `N * (Batch - 1)`**, which is `<= N * Batch`.
The formal result therefore *implies* the documented `≤ L × B` overshoot for the
default `lowWater = 0`, and in fact sharpens it by `N` (one token per node, the
one spent on the triggering request of each carried-over lease). The documented
`L × B` remains the correct headline figure as a simple, safe upper bound; the
model shows the realised worst case is one token-per-node tighter.

## The `lowWater > 0` generalization (noted, not modeled)

With `lowWater = 0`, refills happen strictly on demand: a node leases only when it
has exhausted its credits, so it never holds more than `Batch - 1` after the
admit. Setting `lowWater > 0` enables proactive (asynchronous, non-blocking)
refill — `maybeRefill` tops up while up to `lowWater` credits still remain. A node
can then hold up to `batch + lowWater - 1` credits, generalizing the per-window
bound to

```
admitted_per_window  <=  Limit + N * (batch + lowWater)
```

matching the code's JSDoc note that `lowWater > 0` gives a looser bound of
`≤ L × (batch + lowWater)`. The TLA+ spec models the tight `lowWater = 0` case;
extending it to proactive refill would add a `Refill` action enabled while
`credits[n] <= lowWater` and would raise the credit range to `0..(batch + lowWater - 1)`.
We note this rather than model it, since `lowWater = 0` is the default and yields
the bound the library advertises as tightest.

## Method and scope

This is a **bounded model check**, not a parametric proof for all `N`, `Limit`,
`Batch`. We exhaustively enumerate the reachable state space for fixed small
constants and verify the invariant on every state:

| Config | Bound | TLC distinct states | Result |
|---|---|---|---|
| `N=2, Limit=4, Batch=2` | 6 | 31 | `Overshoot` holds; tight (reaches 6) |
| `N=3, Limit=6, Batch=3` | 12 | 441 | `Overshoot` holds |

The state space is finite because `l2 ∈ 0..Limit`, `credits[n] ∈ 0..(Batch-1)`,
and `admitted` is bounded by the `Overshoot` range — so TLC terminates. The
[`spec/README.md`](../spec/README.md) has the raw TLC output, including exit codes
and state counts.

### Tightness

To show the bound is exact (not merely an over-approximation), the spec defines a
deliberately-too-strong invariant `OvershootTight == admitted <= MaxAdmitted - 1`.
Running TLC with it enabled produces a counterexample trace that reaches
`admitted = 6` for the first config — proving `Limit + N*(Batch-1)` is the least
upper bound. The trace banks one leftover credit on each of the two nodes across
two `Roll`s, then drains both on top of a fresh full window. The CI checker
asserts the dual property: the maximum admitted over all reachable states equals
`MaxAdmitted` exactly.

### Reproduced in CI without Java

[`test/twotier/leasing-model.test.ts`](../test/twotier/leasing-model.test.ts)
implements the identical transition system as a BFS over all reachable states and
asserts the same invariant — and finds the **same distinct-state counts** TLC
reports (31 and 441), an independent cross-check of both implementations. It runs
under vitest in ~150 ms with no Java dependency, so the proof's content is
exercised on every CI run while the TLA+ spec stands as the authoritative,
human-auditable model.
