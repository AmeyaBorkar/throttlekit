# Formal model: distributed leasing overshoot

`DistributedLeasing.tla` is a TLA+ model of ThrottleKit's **`leased`** two-tier
mode (`src/twotier/index.ts`). It is model-checked with TLC and proves the tight
per-window overshoot bound

```
admitted_per_window  <=  Limit + |Nodes| * (Batch - 1)
```

A CI-runnable, Java-free twin lives at `test/twotier/leasing-model.test.ts`: it
enumerates the identical transition system with a BFS and asserts the same
invariant (and the same distinct-state counts TLC reports).

See `docs/FORMAL-MODEL.md` for the prose writeup and the link back to the
library's documented `<= L × batch` bound.

## What the spec models

The model is the abstraction of the leased branch with the default
`lowWater = 0` (purely lease-on-demand) and a per-request `cost = 1`.

State:

- `l2 ∈ 0..Limit` — remaining L2 budget in the current window.
- `credits[n] ∈ 0..(Batch-1)` — node `n`'s unconsumed leased tokens.
- `admitted ∈ Nat` — requests admitted in the **current** L2 window.

`Next == ∃ n ∈ Nodes : Serve(n) ∨ Lease(n) ∨ Roll`.

## Exact correspondence to `src/twotier/index.ts`

The relevant code is the `check` returned by the leased branch (lines ~200–224):

```ts
const have = credits.get(fk) ?? 0;
if (have >= cost) {
  credits.set(fk, have - cost);
  maybeRefill(fk);              // no-op when lowWater <= 0
  return synthAllow(fk, now);   // admit
}
const leaseAmount = Math.max(batch, cost);            // = batch when cost = 1
const d = await l2.apply(fk, decisionTransform(strategy, clock.now(), leaseAmount));
if (d.allowed) {
  credits.set(fk, (credits.get(fk) ?? 0) + leaseAmount - cost);  // keep batch-1
  return synthAllow(fk, now);   // admit the triggering request
}
return d;                       // L2 globally exhausted: surface the denial
```

| Spec action | Code path | Notes |
|---|---|---|
| `Serve(n)` | the `have >= cost` fast path | Consume one local credit, admit, no L2 round trip. `maybeRefill` is a no-op because `lowWater = 0`. Guard `credits[n] >= 1` ⇔ `have >= cost` with `cost = 1`. |
| `Lease(n)` | the lease-on-demand path | Reached when `have < cost`, i.e. `have = 0` for `cost = 1`. `leaseAmount = max(batch, cost) = Batch`. L2's fixed-window strategy admits the lease **iff a whole Batch fits** in the remaining budget — modelled by the guard `l2 >= Batch`. On admit: `l2 -= Batch`, retain `Batch - 1` credits, admit the triggering request. |
| `Roll` | the L2 fixed window rolling over | L2 budget resets to `Limit` and the per-window admitted counter resets, **but local `credits` carry over** — the code never clears `credits` on a window boundary. This carryover is the **sole source of cross-window overshoot**. |

The overshoot is exactly the leftover credits that survive a `Roll`: each of the
`|Nodes|` nodes can carry up to `Batch - 1` credits across the boundary and then
serve them on top of a fresh full `Limit`.

### Modeling fidelity notes

- **`lowWater = 0`** (the default, and the tightest bound). With `lowWater > 0`,
  `maybeRefill` proactively tops up while up to `lowWater` credits remain, so a
  node can hold up to `batch + lowWater - 1` credits — generalizing the bound to
  `Limit + |Nodes| * (batch + lowWater)`. Noted in `docs/FORMAL-MODEL.md`, not
  modeled here.
- **`cost = 1`.** The library admits arbitrary positive costs; `cost = 1` is the
  canonical per-request case and keeps the credit range finite (`0..Batch-1`).
- **Per-key.** ThrottleKit limits per key `fk`; the model fixes one key (every
  node leases/serves the same key), which is where contention — and overshoot —
  occurs.
- **`returnIdleAfterMs`** (idle-credit reclaim) only ever *returns* credits early,
  which can only *lower* admissions; omitting it is sound for an upper bound.

## How to run TLC

Download `tla2tools.jar` (TLC) somewhere outside the repo, then point it at the
spec. The committed config (`DistributedLeasing.cfg`) uses
`Nodes = {n1, n2}, Limit = 4, Batch = 2`, so the bound is `4 + 2*(2-1) = 6`.

```sh
# Download TLC to a temp location (do NOT commit the jar):
curl -L -o "$TMPDIR/tla2tools.jar" \
  https://github.com/tlaplus/tlaplus/releases/latest/download/tla2tools.jar

# Model-check the committed (passing) config:
java -cp "$TMPDIR/tla2tools.jar" tlc2.TLC \
  -workers auto -config spec/DistributedLeasing.cfg spec/DistributedLeasing.tla
```

> TLC writes scratch files (`states/`, `*.toolbox`) into its working directory.
> Run it from a temp dir (copy the two spec files there) to keep the repo clean,
> or clean up afterward.

## Captured results

TLC 2.19, JDK 17, 24 workers (`-workers auto`).

### 1. Committed config — bound holds (no violation)

`Nodes = {n1, n2}, Limit = 4, Batch = 2`; invariants `TypeOK`, `Overshoot`
(`admitted <= 6`).

```
Model checking completed. No error has been found.
113 states generated, 31 distinct states found, 0 states left on queue.
The depth of the complete state graph search is 10.
```

Exit code 0 — **`Overshoot` holds on all 31 reachable states.**

### 2. Tightness — TLC reports a violation reaching admitted = 6

To prove the bound is *exact* (not loose), add a deliberately-too-strong
invariant `OvershootTight == admitted <= MaxAdmitted - 1` (i.e. `admitted <= 5`)
and re-run. (`OvershootTight` is defined in the `.tla`; it is intentionally left
out of the committed `.cfg` so the committed config passes. To reproduce, add
`OvershootTight` under `INVARIANTS` in a scratch copy of the config.)

```
Error: Invariant OvershootTight is violated.
Error: The behavior up to this point is:
State 1: <Initial predicate>
/\ credits = (n1 :> 0 @@ n2 :> 0)
/\ l2 = 4
/\ admitted = 0

State 2: <Lease ...>
/\ credits = (n1 :> 1 @@ n2 :> 0)
/\ l2 = 2
/\ admitted = 1

State 3: <Roll ...>
/\ credits = (n1 :> 1 @@ n2 :> 0)
/\ l2 = 4
/\ admitted = 0

State 4: <Lease ...>
/\ credits = (n1 :> 1 @@ n2 :> 1)
/\ l2 = 2
/\ admitted = 1

State 5: <Roll ...>
/\ credits = (n1 :> 1 @@ n2 :> 1)
/\ l2 = 4
/\ admitted = 0

State 6: <Serve ...>
/\ credits = (n1 :> 1 @@ n2 :> 0)
/\ l2 = 4
/\ admitted = 1

State 7: <Serve ...>
/\ credits = (n1 :> 0 @@ n2 :> 0)
/\ l2 = 4
/\ admitted = 2

State 8: <Lease ...>
/\ credits = (n1 :> 1 @@ n2 :> 0)
/\ l2 = 2
/\ admitted = 3

State 9: <Serve ...>
/\ credits = (n1 :> 0 @@ n2 :> 0)
/\ l2 = 2
/\ admitted = 4

State 10: <Lease ...>
/\ credits = (n1 :> 1 @@ n2 :> 0)
/\ l2 = 0
/\ admitted = 5

State 11: <Serve ...>
/\ credits = (n1 :> 0 @@ n2 :> 0)
/\ l2 = 0
/\ admitted = 6
```

Exit code 12. The trace is the overshoot mechanism in miniature: across two
`Roll`s the two nodes each bank one leftover credit (states 2–5), and in the
third window those 2 banked credits are served (states 6–7) **on top of** the
full budget of 4 (states 8–11), reaching `admitted = 6 = Limit + N*(Batch-1)`.
This witnesses that `Overshoot` is tight. `Overshoot` itself (`admitted <= 6`)
is *not* violated by this trace — only the off-by-one `OvershootTight`.

### 3. Larger config — bound holds

`Nodes = {n1, n2, n3}, Limit = 6, Batch = 3`; bound `6 + 3*(3-1) = 12`;
invariants `TypeOK`, `Overshoot`.

```
Model checking completed. No error has been found.
2458 states generated, 441 distinct states found, 0 states left on queue.
The depth of the complete state graph search is 18.
```

Exit code 0 — **`Overshoot` holds on all 441 reachable states.**

## Cross-check against the JS model checker

`test/twotier/leasing-model.test.ts` enumerates the identical transition system
in TypeScript and finds **exactly 31** distinct states for config 1 and
**exactly 441** for config 3 — the same numbers TLC reports — while asserting
`Overshoot` on every state and that the bound is attained (tightness). It runs in
CI (no Java) in ~150 ms.

## Related specs in this directory

- `GaleWindowCoupledLeasing.tla` — the GALE refinement: credits expire on the L2
  window boundary, collapsing per-window overshoot to zero **independent of
  fleet size N**. JS twin: `test/gale/leasing-variants.test.ts`.
- `GaleFederatedLeasing.tla` — the cross-cluster federation lift of
  `GaleWindowCoupledLeasing` (`Nodes → Regions`, `credits → escrow`,
  `l2 → globalBudget`); proves `admitted ≤ Limit` **independent of region
  count K**. Design + counts:
  `research/bigger-bets/federation/DESIGN.md`. JS twin lands in TK-905.
