# Decision: defer distributed / fleet-global aggregation (#283)

## Decision
Park fleet-global aggregation. Build single-node first; revisit **only** on a concrete distributed-demand
signal.

## Why
- **It reopens the frozen wire.** Cross-node merge needs the gRPC wire (`wire/throttlekit.proto`) to carry
  fleet state — the highest-cost, least-reversible surface in the repo. Once external clients depend on an
  evolved wire, it can't be changed freely.
- **High demo friction.** Fleet needs multiple nodes + a transport to even show value; the
  embedded-library and single-node-server majority never exercises it.
- **Lower marginal value than what's already built.** A third aggregation surface is worth less than
  finishing replay, releasing the monitor stack, and distributing the attribution hero.

## What we keep instead (the seams are already in place)
- The Cost Room snapshot types carry `scope: "single-node"` (literal) and `fairShareReliable: boolean` —
  adding `"fleet"` later is purely additive.
- The Guarantee tab already renders single-node "headroom to the design-time overshoot ceiling," so the
  proven bound is visible without fleet.

## Trigger to revisit
Concrete pull — multiple users asking for cross-node fair-share, or a design partner who needs it. Then
reopen the wire deliberately, once, with a frozen contract.
