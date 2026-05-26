import type { LeaseSizer } from "./lease-sizer";

/**
 * Unified multi-node, multi-window simulator for comparing distributed rate-limiting schemes on the
 * three trilemma axes. One L2 budget of `limit` per window is shared across N nodes; the scheme
 * decides how each node admits and when it talks to L2.
 *
 *  - strict     : every request consults L2 (lease size 1, no local credit) — exact, but C = #requests.
 *  - static     : each node pre-authorised `floor(limit/N)`, no runtime coordination, no carryover.
 *  - leasedFixed: lease a fixed `batch`; `windowCoupled=false` carries credits over (legacy → overshoot),
 *                 `true` expires them at the boundary (GALE Pillar 1 with a fixed size).
 *  - gale       : window-coupled + per-node adaptive lease sizing (Pillar 1 ⊕ Pillar 2).
 *
 * Metrics: coordination C (L2 round trips), overshoot Δ (max over windows of (admitted−limit)⁺), and
 * mean utilisation (admitted / min(demand, limit) per window).
 */
export type Scheme =
  | { readonly kind: "strict" }
  | { readonly kind: "static" }
  | { readonly kind: "leasedFixed"; readonly batch: number; readonly windowCoupled: boolean }
  | { readonly kind: "gale"; readonly sizers: readonly LeaseSizer[] };

export interface EvalMetrics {
  /** Total L2 round trips (lease attempts / strict consults) across the run. */
  readonly coordination: number;
  /** Worst-case per-window overshoot above the limit. */
  readonly overshoot: number;
  /** Mean per-window utilisation in [0,1] (1 = served all serveable demand). */
  readonly meanUtil: number;
}

export function evaluateScheme(
  nodeTraces: readonly (readonly number[])[],
  limit: number,
  scheme: Scheme,
): EvalMetrics {
  const n = nodeTraces.length;
  const windows = nodeTraces[0]?.length ?? 0;
  const credits = new Array<number>(n).fill(0);
  const share = Math.floor(limit / n);

  const leaseSizeOf = (i: number): number => {
    if (scheme.kind === "strict") return 1;
    if (scheme.kind === "static") return 0; // pre-authorised; never leases at runtime
    if (scheme.kind === "leasedFixed") return scheme.batch;
    return scheme.sizers[i]?.size() ?? 1; // gale
  };
  // Whether a window boundary clears local credits (no carryover).
  const expiresAtBoundary =
    scheme.kind === "strict" ||
    scheme.kind === "gale" ||
    (scheme.kind === "leasedFixed" && scheme.windowCoupled);

  let coordination = 0;
  let overshoot = 0;
  let utilSum = 0;

  for (let w = 0; w < windows; w++) {
    let l2 = limit;
    if (scheme.kind === "static") {
      for (let i = 0; i < n; i++) credits[i] = share;
    } else if (expiresAtBoundary) {
      for (let i = 0; i < n; i++) credits[i] = 0;
    } // else leasedFixed carryover: credits persist across the boundary

    const remaining = nodeTraces.map((t) => t[w] ?? 0);
    const demand = remaining.reduce((a, b) => a + b, 0);
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
        const size = leaseSizeOf(i);
        if (size <= 0) continue; // static with its share spent: deny locally, no round trip
        coordination++; // a lease attempt is one L2 round trip (granted or not)
        const grant = Math.min(size, l2);
        if (grant >= 1) {
          l2 -= grant;
          credits[i] = grant - 1; // one leased credit consumed now
          admitted++;
        }
      }
    }

    overshoot = Math.max(overshoot, Math.max(0, admitted - limit));
    const serveable = Math.min(demand, limit);
    utilSum += serveable > 0 ? admitted / serveable : 1;
    if (scheme.kind === "gale") {
      for (let i = 0; i < n; i++) scheme.sizers[i]?.observe(nodeTraces[i]?.[w] ?? 0);
    }
  }

  return { coordination, overshoot, meanUtil: utilSum / Math.max(1, windows) };
}
