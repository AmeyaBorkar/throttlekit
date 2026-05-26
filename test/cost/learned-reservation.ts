/**
 * Cost-uncertainty kernel (TALE Layer 2) — online learned reservation.
 * Design + proofs: research/cost-uncertainty/PROPOSAL.md (§ Layer 2). The cost-axis sibling of GALE
 * Pillar 2 (test/gale/lease-sizer.ts).
 *
 * The streaming meter (Layer 1) bounds *overshoot* for any reservation, but admission still needs a
 * per-request reservation `r` committed *before* the true cost `c` is known: it both decides the 429
 * and paces concurrency. Over-reserve (`r = max_tokens`) and you needlessly reject admissible traffic
 * and starve concurrency; under-reserve and you over-admit, so the meter has to abort in-flight
 * streams at the budget boundary (wasted, half-finished generations). The per-request regret of a
 * reservation `r` against the realised cost `c` is the asymmetric **newsvendor / pinball** loss
 *   ℓ(r, c) = holdCost·(r − c)₊  +  overrunCost·(c − r)₊,
 * whose population minimiser is the **critical-fractile quantile** τ = overrunCost/(holdCost+overrunCost)
 * of the cost distribution (the textbook newsvendor critical ratio). We learn it online with
 * projected online gradient descent (Zinkevich) — full-information (the true cost is revealed when the
 * stream finishes), regret ≤ D·G·√T = O(√T) vs the best fixed reservation. The pinball loss has a
 * *bounded, constant-magnitude* subgradient (±holdCost / ∓overrunCost), which is exactly the setting
 * where vanilla OGD with the canonical η_t = D/(G√t) step is regret-optimal — so unlike Pillar 2
 * (whose *unbounded, smooth* EOQ gradient earns AdaGrad's adaptivity, learned in log-space), here the
 * right tool is plain OGD descending in reservation-space directly.
 *
 * Safety is NOT this module's concern: the streaming meter (Layer 1) caps production at the budget for
 * any reservation whatsoever, so no choice of `r` — learned, maximal, or zero — can breach `L`. This
 * module only governs the false-reject ⇆ abort trade-off.
 *
 * Pure and deterministic: no clock, no RNG (traces come from token-budget.ts's seeded generator).
 */

/** A reservation policy as an online learner: commit a reservation, then learn from the realised cost. */
export interface OnlineReservation {
  /** Integer reservation to commit for the next request (in [minReservation, maxReservation]). */
  reserve(): number;
  /** Feed the realised cost once a stream finishes; updates the reservation for subsequent requests. */
  observe(cost: number): void;
  /** The continuous internal reservation (before rounding/clamping), for introspection/tests. */
  readonly continuous: number;
}

export interface OnlineReservationOptions {
  /** Hold cost h: penalty per token reserved-but-unused (over-reservation ⇒ false rejects). */
  readonly holdCost: number;
  /** Overrun cost p: penalty per token of realised cost beyond the reservation (under ⇒ aborts). */
  readonly overrunCost: number;
  /** Upper clamp = max_tokens m; also the reservation-domain diameter for the scale-free step. */
  readonly maxReservation: number;
  /** Lower clamp on the reservation. Default 0 (0 ⇒ no admission gating, the greedy corner). */
  readonly minReservation?: number;
  /** Initial reservation. Default = the feasible midpoint (minR+maxR)/2, a neutral prior. */
  readonly initialReservation?: number;
  /** OGD step scale η₀ in step η₀/√t. Default = D/G = (maxR−minR)/max(holdCost,overrunCost). */
  readonly stepScale?: number;
}

const clampNum = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The critical-fractile quantile level τ = p/(h+p) — the cost quantile that minimises ℓ. */
export function criticalFractile(holdCost: number, overrunCost: number): number {
  return overrunCost / (holdCost + overrunCost);
}

/**
 * The asymmetric reservation (newsvendor / pinball) cost of committing `reservation` against the
 * realised `cost`: holdCost per token reserved-but-idle, overrunCost per token of overrun. Convex,
 * piecewise-linear in the reservation; minimised in expectation at the critical-fractile quantile.
 */
export function reservationCost(
  reservation: number,
  cost: number,
  holdCost: number,
  overrunCost: number,
): number {
  return reservation > cost ? holdCost * (reservation - cost) : overrunCost * (cost - reservation);
}

/** Empirical τ-quantile of `samples` (nearest-rank) — the oracle reservation for a known distribution. */
export function quantile(samples: readonly number[], tau: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = clampNum(Math.ceil(tau * sorted.length) - 1, 0, sorted.length - 1);
  return sorted[idx] as number;
}

/** The projected-OGD online learner in reservation-space (the TALE Layer-2 policy). */
export function createOnlineReservation(options: OnlineReservationOptions): OnlineReservation {
  const h = options.holdCost;
  const p = options.overrunCost;
  if (!Number.isFinite(h) || h <= 0) throw new RangeError(`holdCost must be > 0, got ${h}`);
  if (!Number.isFinite(p) || p <= 0) throw new RangeError(`overrunCost must be > 0, got ${p}`);
  const maxR = options.maxReservation;
  const minR = options.minReservation ?? 0;
  if (!Number.isFinite(maxR) || maxR <= 0)
    throw new RangeError(`maxReservation must be > 0, got ${maxR}`);
  if (minR < 0 || minR > maxR)
    throw new RangeError(`minReservation must be in [0, maxR], got ${minR}`);
  // Zinkevich-optimal scale η₀ = D/G: diameter D = maxR−minR over subgradient bound G = max(h,p).
  const stepScale = options.stepScale ?? Math.max((maxR - minR) / Math.max(h, p), 1e-6);

  let r = clampNum(options.initialReservation ?? (minR + maxR) / 2, minR, maxR);
  let t = 0;

  return {
    reserve(): number {
      return Math.round(r);
    },
    observe(cost: number): void {
      // Subgradient of ℓ(r, c) w.r.t. r: +h if we over-reserved (r > c), −p if we under-reserved.
      // E[g] = h·F(r) − p·(1 − F(r)) = 0 ⇔ F(r) = p/(h+p) = τ, so OGD descends onto the τ-quantile.
      t += 1;
      const grad = r > cost ? h : -p;
      const step = stepScale / Math.sqrt(t);
      r = clampNum(r - step * grad, minR, maxR);
    },
    get continuous(): number {
      return r;
    },
  };
}

/** Run a learner over a realised-cost trace; return total pinball cost and the reservations it played. */
export function simulateReservation(
  trace: readonly number[],
  policy: OnlineReservation,
  holdCost: number,
  overrunCost: number,
): { cost: number; reservations: number[] } {
  let cost = 0;
  const reservations: number[] = [];
  for (const c of trace) {
    const r = policy.reserve(); // committed before observing this request's realised cost
    reservations.push(r);
    cost += reservationCost(r, c, holdCost, overrunCost);
    policy.observe(c);
  }
  return { cost, reservations };
}

/** Total cost of the best single fixed reservation in hindsight, searched over `candidates`. */
export function bestFixedReservationCost(
  trace: readonly number[],
  holdCost: number,
  overrunCost: number,
  candidates: readonly number[],
): { cost: number; reservation: number } {
  let best = Number.POSITIVE_INFINITY;
  let bestR = candidates[0] ?? 0;
  for (const r of candidates) {
    let cost = 0;
    for (const c of trace) cost += reservationCost(r, c, holdCost, overrunCost);
    if (cost < best) {
      best = cost;
      bestR = r;
    }
  }
  return { cost: best, reservation: bestR };
}

// ---------------------------------------------------------------------------------------------------
// Admission integration — the reservation paces admission while the Layer-1 streaming meter holds safety.
// ---------------------------------------------------------------------------------------------------

/**
 * A reservation rule used at admission. `reserve` is committed *before* the cost is known; only the
 * (non-implementable) oracle peeks at `trueCost`, and only the predictive policy (Layer 3) uses
 * `prediction`. `settle` feeds the realised cost back to any learner once the stream finishes.
 */
export interface ReservationPolicy {
  reserve(trueCost: number, prediction: number): number;
  settle(trueCost: number): void;
}

const noop = (): void => {};

/** Reserve the cap on every request (`r = max_tokens`): zero aborts, but starves concurrency. */
export function maxReservationPolicy(maxTokens: number): ReservationPolicy {
  return { reserve: () => maxTokens, settle: noop };
}

/** Reserve nothing (`r = 0`): admit greedily into any free slot — this is Layer-1 streaming. */
export const greedyReservationPolicy: ReservationPolicy = { reserve: () => 0, settle: noop };

/** Reserve exactly the realised cost (the non-implementable clairvoyant ceiling): full util, no aborts. */
export const oracleReservationPolicy: ReservationPolicy = {
  reserve: (trueCost) => trueCost,
  settle: noop,
};

/** Wrap an online learner as an admission policy: reserve its current value, learn on completion. */
export function learnedReservationPolicy(online: OnlineReservation): ReservationPolicy {
  return { reserve: () => online.reserve(), settle: (trueCost) => online.observe(trueCost) };
}

export interface AdmissionOptions {
  /** Token budget L for the window. */
  readonly budget: number;
  /** Max concurrent in-flight streams C. */
  readonly slots: number;
  /** Per-request output cap m (true costs are clamped to it). */
  readonly maxTokens: number;
  /** Streaming reconcile granularity g (tokens produced per active slot per tick). */
  readonly chunk: number;
  /** Window length in ticks. */
  readonly rounds: number;
}

export interface AdmissionResult {
  /** Requests admitted over the window. */
  readonly admitted: number;
  /** Requests that finished within the budget. */
  readonly completed: number;
  /** Requests preempted by the meter at the budget boundary (= admitted − completed). */
  readonly aborts: number;
  /** Tokens produced over the window (completed + wasted-on-abort), capped by the meter at L. */
  readonly served: number;
  /** Budget utilization min(served, L)/L in [0,1]. */
  readonly utilization: number;
  /** Tokens charged beyond L (the overshoot Δ) — ≤ chunk·(slots) for any policy; 0 at chunk=1. */
  readonly overshoot: number;
}

interface Slot {
  produced: number;
  total: number;
  reserved: number;
}

/**
 * Reservation-gated admission over the streaming meter. A request is admitted into a free slot only
 * while budget remains (`served < L`) *and* its reservation fits (`reservedΣ + r ≤ L`); the meter then
 * produces `g` tokens per active slot per tick and aborts any in-flight stream once `served ≥ L`.
 * The reservation governs *how many* run concurrently; the meter governs *how much* is produced.
 * Overshoot is therefore meter-bounded (≤ slots·chunk; 0 at chunk=1) for every reservation policy —
 * the unconditional-safety property reused from Layer 1.
 */
export function simulateAdmission(
  queue: readonly number[],
  policy: ReservationPolicy,
  o: AdmissionOptions,
  predictions: readonly number[] = [],
): AdmissionResult {
  const { budget: L, slots: C, maxTokens: m } = o;
  const g = Math.max(1, o.chunk);
  const slot = new Array<Slot | null>(C).fill(null);
  let qi = 0;
  let served = 0;
  let reserved = 0;
  let admitted = 0;
  let completed = 0;

  const admit = (): void => {
    for (let s = 0; s < C; s++) {
      if (slot[s] !== null) continue;
      if (qi >= queue.length || served >= L) return;
      const trueCost = Math.min(queue[qi] as number, m);
      const r = Math.max(0, policy.reserve(trueCost, predictions[qi] ?? 0));
      if (reserved + r > L) return; // reservation does not fit — hold the head of line (FCFS)
      slot[s] = { produced: 0, total: trueCost, reserved: r };
      reserved += r;
      qi++;
      admitted++;
    }
  };

  admit();
  for (let round = 0; round < o.rounds; round++) {
    for (let s = 0; s < C; s++) {
      const sl = slot[s];
      if (!sl) continue;
      if (served >= L) {
        // Budget spent: preempt this in-flight stream at its chunk boundary (an abort).
        reserved -= sl.reserved;
        slot[s] = null;
        continue;
      }
      const piece = Math.min(g, sl.total - sl.produced);
      sl.produced += piece;
      served += piece;
      if (sl.produced >= sl.total) {
        reserved -= sl.reserved;
        completed++;
        policy.settle(sl.total);
        slot[s] = null;
      }
    }
    admit();
  }

  return {
    admitted,
    completed,
    aborts: admitted - completed,
    served,
    utilization: Math.min(served, L) / L,
    overshoot: Math.max(0, served - L),
  };
}
