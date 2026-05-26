import type { LeaseSizer } from "./lease-sizer";
import type { PredictiveLeaseSizer } from "./predictive-sizer";

/** Per-window outcome of a multi-node window-coupled simulation. */
export interface WindowResult {
  /** Requests admitted across all nodes this window (must be <= limit). */
  readonly admitted: number;
  /** Total requests offered across all nodes this window. */
  readonly demand: number;
}

/**
 * Run one window-coupled window across `n` nodes. Credits start at 0 (they EXPIRE at the boundary —
 * window-coupling), the L2 budget starts at `limit`. Requests are processed round-robin; a node
 * serves from local credits, and when empty leases `min(sizeOf(node), l2)` from L2 (a grant of 0
 * means L2 is exhausted → the request is denied). `remaining` is mutated to empty. Returns admitted.
 *
 * Safety is structural: l2 is never driven below 0, and admitted = credits consumed <= total
 * granted <= limit — for ANY sizes `sizeOf` returns.
 */
function runWindow(remaining: number[], limit: number, sizeOf: (node: number) => number): number {
  const n = remaining.length;
  const credits = new Array<number>(n).fill(0);
  let l2 = limit;
  let admitted = 0;
  let active = true;
  while (active) {
    active = false;
    for (let i = 0; i < n; i++) {
      if ((remaining[i] ?? 0) <= 0) continue;
      active = true;
      remaining[i] = (remaining[i] ?? 0) - 1;
      if ((credits[i] ?? 0) >= 1) {
        credits[i] = (credits[i] ?? 0) - 1;
        admitted++;
        continue;
      }
      const grant = Math.min(sizeOf(i), l2);
      if (grant >= 1) {
        l2 -= grant;
        credits[i] = grant - 1; // one leased credit consumed immediately
        admitted++;
      }
      // grant === 0 → L2 exhausted this window → request denied (not admitted)
    }
  }
  return admitted;
}

/**
 * Simulate one key under GALE window-coupled leasing across N nodes driven by per-node lease sizers.
 * Exercises Pillar 1 ⊕ Pillar 2: the learners' *varying* sizes flow through the real mechanism and
 * `admitted <= limit` must hold every window, for any sizes — learning governs efficiency, not safety.
 */
export function simulateWindowCoupled(
  nodeTraces: readonly (readonly number[])[],
  sizers: readonly LeaseSizer[],
  limit: number,
): WindowResult[] {
  const windows = nodeTraces[0]?.length ?? 0;
  const out: WindowResult[] = [];
  for (let w = 0; w < windows; w++) {
    const remaining = nodeTraces.map((t) => t[w] ?? 0);
    const demand = remaining.reduce((a, b) => a + b, 0);
    const admitted = runWindow(remaining, limit, (i) => sizers[i]?.size() ?? 1);
    out.push({ admitted, demand });
    for (let i = 0; i < nodeTraces.length; i++) sizers[i]?.observe(nodeTraces[i]?.[w] ?? 0);
  }
  return out;
}

/**
 * As {@link simulateWindowCoupled}, but each node uses a prediction-augmented sizer (Pillar 3) fed a
 * per-node predicted demand each window. The point: even with adversarially-wrong predictions, the
 * hard cap `admitted <= limit` still holds — predictions can only affect efficiency, never safety.
 */
export function simulateWindowCoupledPredictive(
  nodeTraces: readonly (readonly number[])[],
  nodePredictions: readonly (readonly number[])[],
  sizers: readonly PredictiveLeaseSizer[],
  limit: number,
): WindowResult[] {
  const windows = nodeTraces[0]?.length ?? 0;
  const out: WindowResult[] = [];
  for (let w = 0; w < windows; w++) {
    const remaining = nodeTraces.map((t) => t[w] ?? 0);
    const demand = remaining.reduce((a, b) => a + b, 0);
    const admitted = runWindow(
      remaining,
      limit,
      (i) => sizers[i]?.size(nodePredictions[i]?.[w] ?? 0) ?? 1,
    );
    out.push({ admitted, demand });
    for (let i = 0; i < nodeTraces.length; i++) sizers[i]?.observe(nodeTraces[i]?.[w] ?? 0);
  }
  return out;
}
