/**
 * Solver kernel for the DYNAMIC `≤ C`-message trilemma (research/gale/TRILEMMA.md § Partial
 * coordination — dynamic). Coordination is demand-driven leasing: the protocol pre-authorises a local
 * budget per node, holds the rest in a shared pool, and issues at most `C` lease round-trips, each
 * granting a batch of up to `B` to whichever node is hot *now* (the GALE leasing model capped at C
 * round-trips). windowCoupled ⇒ overshoot Δ = 0 by construction (admitted ≤ Σ pre-auth + pool = L); we
 * characterise the residual under-utilisation U.
 *
 * The online tension the cap exposes: pre-auth strands on idle nodes; a reactive lease strands up to
 * B−1 when a node leases then stops (a "barely-hot-then-starve" adversary). Pure & deterministic.
 */

/** Under-utilisation of pre-auth `b` (Σb ≤ L) against demand `d`, with ≤C batch-B reactive leases. */
export function underUtil(
  d: readonly number[],
  L: number,
  b: readonly number[],
  B: number,
  C: number,
): number {
  const N = d.length;
  const credits = [...b];
  const remaining = [...d];
  let pool = L - b.reduce((a, x) => a + x, 0);
  let leases = 0;
  let produced = 0;
  let active = true;
  while (active) {
    active = false;
    for (let i = 0; i < N; i++) {
      if ((remaining[i] ?? 0) <= 0) continue;
      if ((credits[i] ?? 0) >= 1) {
        credits[i] = (credits[i] as number) - 1;
        remaining[i] = (remaining[i] as number) - 1;
        produced++;
        active = true;
        continue;
      }
      if (leases < C && pool >= 1) {
        const grant = Math.min(B, pool);
        pool -= grant;
        credits[i] = (credits[i] as number) + grant - 1; // grant a batch, consume one now
        remaining[i] = (remaining[i] as number) - 1;
        leases++;
        produced++;
        active = true;
      }
      // else: node i cannot be served (no credit, no lease left / empty pool) — demand shed
    }
  }
  return (
    Math.min(
      d.reduce((a, x) => a + x, 0),
      L,
    ) - produced
  );
}

/** All integer demand vectors d ∈ {0..L}^N. */
export function* demands(N: number, L: number): Generator<number[]> {
  const d = new Array<number>(N).fill(0);
  for (;;) {
    yield d;
    let i = 0;
    while (i < N) {
      const v = (d[i] ?? 0) + 1;
      if (v <= L) {
        d[i] = v;
        break;
      }
      d[i] = 0;
      i++;
    }
    if (i === N) return;
  }
}

/** All integer pre-auth vectors b ≥ 0 with Σ b ≤ L. */
export function preauths(N: number, L: number): number[][] {
  if (N === 0) return [[]];
  const out: number[][] = [];
  for (let v = 0; v <= L; v++) for (const rest of preauths(N - 1, L - v)) out.push([v, ...rest]);
  return out;
}

/** `U*(N,L,B,C) = min_pre-auth max_demand U`, exact; returns the achieving pre-auth & worst demand. */
export function optimalU(
  N: number,
  L: number,
  B: number,
  C: number,
  uniformOnly = false,
): { U: number; bestB: number[]; worstD: number[] } {
  const bs = uniformOnly
    ? Array.from({ length: Math.floor(L / N) + 1 }, (_u, beta) => new Array<number>(N).fill(beta))
    : preauths(N, L);
  let best = Number.POSITIVE_INFINITY;
  let bestB: number[] = [];
  let worstDForBest: number[] = [];
  for (const b of bs) {
    let worst = -1;
    let worstD: number[] = [];
    for (const d of demands(N, L)) {
      const u = underUtil(d, L, b, B, C);
      if (u > worst) {
        worst = u;
        worstD = [...d];
      }
    }
    if (worst < best) {
      best = worst;
      bestB = [...b];
      worstDForBest = worstD;
    }
  }
  return { U: best, bestB, worstD: worstDForBest };
}

/**
 * The proved dynamic lower bound (single-hot-node adversary, all C leases to one node):
 * `Δ + N·U ≥ (N−1)·(L − C·B)`, i.e. the U-floor below. Valid for every B; **tight at B = 1**.
 */
export function dynamicLowerBoundU(N: number, L: number, B: number, C: number): number {
  return Math.max(0, ((N - 1) * (L - C * B)) / N);
}

/**
 * Exact optimum at unit batch (B = 1, no stranding): `min_β [ L − β − min(C, L − Nβ) ]`,
 * which equals `(N−1)(L−C)/N` for integer β — coordination buys back the static floor linearly.
 */
export function dynamicUnitBatchU(N: number, L: number, C: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let beta = 0; beta <= Math.floor(L / N); beta++) {
    best = Math.min(best, L - beta - Math.min(C, L - N * beta));
  }
  return best;
}
