import type { LeaseSizer } from "./lease-sizer";

/** Per-window outcome of the multi-node window-coupled simulation. */
export interface WindowResult {
  /** Requests admitted across all nodes this window (must be <= limit). */
  readonly admitted: number;
  /** Total requests offered across all nodes this window. */
  readonly demand: number;
}

/**
 * Simulate one key under GALE window-coupled leasing across N nodes, driven by per-node lease
 * sizers, for the length of the supplied per-node demand traces.
 *
 * Each window: the L2 budget resets to `limit` and every node's local credits reset to 0 (they
 * EXPIRE at the boundary — window-coupling). Requests are processed round-robin across nodes; a
 * node serves from local credits, and when empty leases `min(sizer.size(), l2)` from L2 (a grant of
 * 0 means L2 is exhausted → the request is denied). At window close each sizer observes its node's
 * realised demand.
 *
 * The point of this simulation is Pillar 1 ⊕ Pillar 2: it exercises the learner's *varying* lease
 * sizes through the real mechanism and confirms the safety invariant `admitted <= limit` holds every
 * window, for any sizes the learners emit — learning governs efficiency, never safety.
 */
export function simulateWindowCoupled(
  nodeTraces: readonly (readonly number[])[],
  sizers: readonly LeaseSizer[],
  limit: number,
): WindowResult[] {
  const n = nodeTraces.length;
  const windows = nodeTraces[0]?.length ?? 0;
  const out: WindowResult[] = [];

  for (let w = 0; w < windows; w++) {
    let l2 = limit;
    const credits = new Array<number>(n).fill(0); // expire at the boundary (window-coupled)
    const remaining = nodeTraces.map((t) => t[w] ?? 0);
    let admitted = 0;
    let demand = 0;
    for (const r of remaining) demand += r;

    // Round-robin one request per node per pass until the window's arrivals are exhausted.
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
        const want = sizers[i]?.size() ?? 1;
        const grant = Math.min(want, l2);
        if (grant >= 1) {
          l2 -= grant;
          credits[i] = grant - 1; // one of the leased credits is consumed immediately
          admitted++;
        }
        // grant === 0 → L2 exhausted for this window → request denied (not admitted)
      }
    }

    out.push({ admitted, demand });
    for (let i = 0; i < n; i++) sizers[i]?.observe(nodeTraces[i]?.[w] ?? 0);
  }
  return out;
}
