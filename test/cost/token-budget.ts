/**
 * Cost-uncertainty kernel (TALE Layer 1) — token-budget admission under post-hoc costs.
 * Design + proofs: research/cost-uncertainty/PROPOSAL.md.
 *
 * A budget of `budget` tokens must be enforced over a fixed window of `rounds` ticks, across up to
 * `slots` concurrent streams drawn from an arrival queue of hidden output lengths (capped at
 * `maxTokens`). The cost of a request is revealed only as it streams. Three schemes:
 *
 *   - reserveMax       : reserve maxTokens at admission, refund the unused remainder on completion.
 *                        Never overshoots, but a big reservation blocks concurrency => low utilization.
 *   - admitThenCount   : admit while completed-charged < budget; charge the actual cost at completion.
 *                        Full utilization, but in-flight streams at the crossing overshoot by ~slots*maxTokens.
 *   - streaming(chunk) : meter the budget per produced chunk (atomic); stop at the boundary.
 *                        Overshoot <= chunk-1 (chunk=1 => 0), INDEPENDENT of maxTokens, utilization ~1.
 *
 * Pure and deterministic given the queue. Streaming uses an atomic per-chunk meter (single-gateway);
 * the distributed C-gateway meter is the GALE leased budget with tokens as the unit (see proposal).
 */

export type BudgetScheme = "reserveMax" | "admitThenCount" | "streaming";

export interface SimOptions {
  /** Token budget L for the window. */
  readonly budget: number;
  /** Max concurrent in-flight streams C. */
  readonly slots: number;
  /** Per-request output cap m (and reserveMax's reservation size). */
  readonly maxTokens: number;
  /** Streaming reconcile granularity g (tokens metered per debit); >= 1. */
  readonly chunk: number;
  /** Window length in ticks (one chunk produced per active slot per tick). */
  readonly rounds: number;
  readonly scheme: BudgetScheme;
}

export interface SimResult {
  /** Tokens actually produced/delivered over the window. */
  readonly served: number;
  /** Tokens charged to the budget beyond L (the overshoot Δ). */
  readonly overshoot: number;
  /** Budget utilization min(served, L)/L in [0,1]. */
  readonly utilization: number;
  readonly admitted: number;
}

interface Slot {
  produced: number;
  total: number;
}

export function simulate(queue: readonly number[], o: SimOptions): SimResult {
  const { budget: L, slots: C, maxTokens: m, scheme } = o;
  const g = Math.max(1, o.chunk);
  const slot = new Array<Slot | null>(C).fill(null);
  let qi = 0;
  let served = 0; // tokens produced
  let committed = 0; // tokens charged to budget at completion (admitThenCount)
  let reserved = 0; // outstanding reservations (reserveMax)
  let admitted = 0;

  const canAdmit = (): boolean => {
    if (scheme === "reserveMax") return reserved + m <= L;
    if (scheme === "admitThenCount") return committed < L;
    return served < L; // streaming: budget remains by produced count
  };
  const admit = (): void => {
    for (let s = 0; s < C; s++) {
      if (slot[s] !== null) continue;
      if (qi >= queue.length || !canAdmit()) return;
      const total = Math.min(queue[qi] as number, m);
      if (scheme === "reserveMax") reserved += m;
      slot[s] = { produced: 0, total };
      qi++;
      admitted++;
    }
  };

  admit();
  for (let r = 0; r < o.rounds; r++) {
    for (let s = 0; s < C; s++) {
      const sl = slot[s];
      if (!sl) continue;
      // Streaming atomic meter: stop producing once the budget is spent (abort at chunk boundary).
      if (scheme === "streaming" && served >= L) {
        slot[s] = null;
        continue;
      }
      const piece = Math.min(g, sl.total - sl.produced);
      sl.produced += piece;
      served += piece;
      if (sl.produced >= sl.total) {
        if (scheme === "reserveMax")
          reserved -= m - sl.total; // refund the unused reservation
        else if (scheme === "admitThenCount") committed += sl.total; // charge actual at completion
        slot[s] = null;
      }
    }
    admit();
  }

  const overshoot =
    scheme === "admitThenCount"
      ? Math.max(0, committed - L)
      : scheme === "streaming"
        ? Math.max(0, served - L)
        : 0; // reserveMax never exceeds L
  return { served, overshoot, utilization: Math.min(served, L) / L, admitted };
}

/**
 * Heavy-tailed output lengths (the empirically-reported shape): a log-normal-ish draw via the
 * seeded PRNG, clamped to [1, maxTokens]. `heavy` raises the tail weight.
 */
export function heavyTailLengths(
  n: number,
  median: number,
  maxTokens: number,
  seed: number,
  heavy = 1.4,
): number[] {
  let s = seed >>> 0;
  const rng = (): number => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    // exp(normal) with the normal approximated by summed uniforms; `heavy` stretches the tail.
    const u = (rng() + rng() + rng()) / 3 - 0.5; // ~N(0, .) approx, mean 0
    const draw = Math.round(median * Math.exp(heavy * (u * 4)));
    out.push(Math.max(1, Math.min(maxTokens, draw)));
  }
  return out;
}
