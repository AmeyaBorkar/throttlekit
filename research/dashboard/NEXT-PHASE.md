# ThrottleKit — next phase (embedded-first: attribution + replay)

## Where we are
- Core (`throttlekit`) is stable at 1.2.x: rate, concurrency, cost, two-tier, weighted-fair-escrow, and
  **unified multi-axis admission**.
- The `throttlekit-server` `--tui` dashboard now has six tabs — Overview (live binding-axis attribution),
  Latency, Fairness, Capacity, Guarantee (headroom to the design-time overshoot ceiling), and the new
  **Cost Room** (per-tenant cost-axis burn-down). All server-confined and `@experimental`.

## The thing we sharpen
ThrottleKit's distinctive capability is the **in-process, unified, multi-axis admission decision** — and,
uniquely, **live binding-axis attribution**: *which constraint (rate / concurrency / cost) is throttling
this request right now, with the exact per-axis numbers.* A single-axis gateway/middlebox structurally
can't answer that. This is the front door.

The second pillar (in progress): **deterministic, bit-exact replay** of admission decisions — record a
bounded decision trace, replay it against a candidate policy with zero divergence. Reproducible admission
for CI / regression testing.

## Sequence
1. **Finish Replay** — the testkit recorder + replayer (library-only, no wire). See `replay-p1-plan.md`.
2. **Release** the experimental server surfaces (Cost Room + the monitor stack).
3. **Polish + document + distribute** the binding-axis attribution hero (README, a short demo, a
   dev-channel launch).

## Explicitly deferred
- **Distributed / fleet-global aggregation** — see `designs/FLEET-DEFERRED.md`. It reopens the frozen gRPC
  wire (the highest-cost, least-reversible surface) and needs multi-node infra to even demo; the
  embedded-library majority never exercises it. Single-node first; revisit on concrete demand.

Tracked: Replay #287–#290; Fleet #283 (deferred); release + distribution as new tasks.
