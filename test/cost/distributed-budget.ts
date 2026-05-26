/**
 * Cost-uncertainty — the distributed instantiation (TALE × GALE unification).
 * Design: research/cost-uncertainty/PROPOSAL.md (§ Layer 1, distributed meter; § Capstone).
 *
 * A single token budget `L` (a TPM cap) shared across `C` gateways. Each gateway meters its own
 * streaming production locally and leases `leaseBatch` tokens at a time from the shared L2 budget —
 * one coordination round trip per `leaseBatch` tokens produced. This is **GALE leased two-tier with
 * the token as the unit**: a gateway is a leasing node, a lease is a batch of token budget, and the
 * streaming meter debits leased tokens as the model emits them. So the distributed TPM limiter
 * inherits GALE's overshoot results verbatim:
 *
 *   - **windowCoupled** — leased-but-unspent tokens EXPIRE at the TPM window boundary. Global tokens
 *     produced per window `≤ L`, **independent of the gateway count `C`** (GALE Pillar 1).
 *   - **carryover** — leased tokens persist into the next window. A gateway can enter a window holding
 *     up to `leaseBatch − 1` unspent leased tokens, so global production `≤ L + C·(leaseBatch − 1)` —
 *     the overshoot grows with the fleet size.
 *
 * The mechanism mirrors test/gale/window-coupled-sim.ts exactly (round-robin, lease `min(B, l2)`,
 * credits-expire); `simulateDistributedBudget(..., "windowCoupled")` is byte-identical to GALE's
 * `simulateWindowCoupled` fed the same per-window token demands (cross-checked in the test). Pure and
 * deterministic.
 */

export type LeaseMode = "windowCoupled" | "carryover";

export interface DistributedBudgetOptions {
  /** Shared token budget L per window (the TPM cap / L2 budget). */
  readonly budget: number;
  /** Number of gateways C sharing the budget. */
  readonly gateways: number;
  /** Tokens leased per L2 round trip (the coordination batch B). */
  readonly leaseBatch: number;
  /** windowCoupled (expire leased tokens at the boundary) or carryover (persist). */
  readonly mode: LeaseMode;
}

export interface DistributedWindowResult {
  /** Tokens produced globally this window (= leased credits consumed). */
  readonly produced: number;
  /** Tokens demanded globally this window. */
  readonly demand: number;
  /** Tokens produced beyond the budget (the overshoot Δ = max(0, produced − L)). */
  readonly overshoot: number;
}

/** The worst-case global overshoot bound for `carryover` leasing: `C·(leaseBatch − 1)` above L. */
export function carryoverBound(gateways: number, leaseBatch: number): number {
  return gateways * (leaseBatch - 1);
}

/**
 * Run a distributed token budget over `W` windows (W = the per-gateway demand-trace length).
 * `gatewayDemands[i][w]` is gateway `i`'s token demand in window `w`. One token is produced per
 * round-robin turn; a gateway with no local credits leases `min(leaseBatch, l2)` from the shared
 * budget (a grant of 0 means L2 is exhausted ⇒ the token is shed). Safety is structural: `l2` never
 * goes below 0, so within a window `produced ≤ L + carried`, where `carried = 0` under windowCoupled.
 */
export function simulateDistributedBudget(
  gatewayDemands: readonly (readonly number[])[],
  o: DistributedBudgetOptions,
): DistributedWindowResult[] {
  const { budget: L, gateways: C, leaseBatch: B, mode } = o;
  const windows = gatewayDemands[0]?.length ?? 0;
  const credits = new Array<number>(C).fill(0); // per-gateway leased-but-unspent tokens
  const out: DistributedWindowResult[] = [];

  for (let w = 0; w < windows; w++) {
    if (mode === "windowCoupled") credits.fill(0); // leased tokens expire at the boundary
    let l2 = L; // fresh shared budget each window
    const remaining = gatewayDemands.map((d) => d[w] ?? 0);
    const demand = remaining.reduce((a, b) => a + b, 0);
    let produced = 0;

    let active = true;
    while (active) {
      active = false;
      for (let i = 0; i < C; i++) {
        if ((remaining[i] ?? 0) <= 0) continue;
        active = true;
        remaining[i] = (remaining[i] ?? 0) - 1;
        if ((credits[i] ?? 0) >= 1) {
          credits[i] = (credits[i] ?? 0) - 1; // spend a carried/leased token (no round trip)
          produced++;
          continue;
        }
        const grant = Math.min(B, l2);
        if (grant >= 1) {
          l2 -= grant;
          credits[i] = grant - 1; // one leased token consumed immediately
          produced++;
        }
        // grant === 0 → shared budget exhausted this window → token shed
      }
      // Once nothing can be produced (budget spent and every credit drained), the rest is shed
      // deterministically — stop draining demand (does not change produced/overshoot).
      if (l2 < 1 && credits.every((c) => c < 1)) break;
    }
    out.push({ produced, demand, overshoot: Math.max(0, produced - L) });
  }
  return out;
}
