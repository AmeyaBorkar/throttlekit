import {
  type ReservationPolicy,
  bestFixedReservationCost,
  createOnlineReservation,
  criticalFractile,
  greedyReservationPolicy,
  learnedReservationPolicy,
  maxReservationPolicy,
  oracleReservationPolicy,
  quantile,
  reservationCost,
  simulateAdmission,
  simulateReservation,
} from "../../test/cost/learned-reservation";
/**
 * Calibration harness for TALE Layer 2 (online learned reservation). Prints the exact seeded numbers
 * that test/cost/learned-reservation.test.ts asserts. Run: `npx tsx research/cost-uncertainty/explore-reservation.ts`.
 * Not part of the gated suite — a reproducible record of how the thresholds were chosen (cf. GALE's
 * research/gale/explore-regret.ts).
 */
import { heavyTailLengths } from "../../test/cost/token-budget";

const H = 1;
const P = 4;
const TAU = criticalFractile(H, P);
console.log(`critical fractile τ = p/(h+p) = ${P}/${H + P} = ${TAU}`);

// ---- 1. No-regret signature on a stationary heavy-tail cost stream -------------------------------
console.log("\n[1] static regret (stationary, median 120, m=512, seed 7):");
const M_REG = 512;
const CAND = Array.from({ length: M_REG + 1 }, (_u, i) => i); // fixed reservations 0..512, step 1
for (const T of [100, 400, 1600, 6400]) {
  const trace = heavyTailLengths(T, 120, M_REG, 7);
  const learner = createOnlineReservation({ holdCost: H, overrunCost: P, maxReservation: M_REG });
  const { cost } = simulateReservation(trace, learner, H, P);
  const best = bestFixedReservationCost(trace, H, P, CAND);
  const regret = cost - best.cost;
  console.log(
    `  T=${T}: learner=${cost.toFixed(0)} best-fixed=${best.cost.toFixed(0)} (r*=${best.reservation}) ` +
      `regret=${regret.toFixed(0)} avg=${(regret / T).toFixed(4)}`,
  );
}

// ---- 2. Converges to the oracle critical-fractile quantile ---------------------------------------
console.log("\n[2] convergence to the oracle τ-quantile (T=6400):");
{
  const trace = heavyTailLengths(6400, 120, M_REG, 7);
  const learner = createOnlineReservation({ holdCost: H, overrunCost: P, maxReservation: M_REG });
  simulateReservation(trace, learner, H, P);
  const oracleQ = quantile(trace, TAU);
  const best = bestFixedReservationCost(trace, H, P, CAND);
  console.log(
    `  learner.continuous=${learner.continuous.toFixed(2)} oracleQuantile(τ)=${oracleQ} best-fixed r*=${best.reservation}`,
  );
}

// ---- 3. Adapts under a distribution shift (regime change in output lengths) ----------------------
console.log("\n[3] adapt under shift (median 80 → 300, m=512):");
{
  const a = heavyTailLengths(2000, 80, M_REG, 21);
  const b = heavyTailLengths(2000, 300, M_REG, 22);
  const trace = [...a, ...b];
  const learner = createOnlineReservation({ holdCost: H, overrunCost: P, maxReservation: M_REG });
  const { cost } = simulateReservation(trace, learner, H, P);
  const best = bestFixedReservationCost(trace, H, P, CAND);
  console.log(
    `  online=${cost.toFixed(0)} best-fixed=${best.cost.toFixed(0)} (r*=${best.reservation}) ratio=${(cost / best.cost).toFixed(3)}`,
  );
}

// ---- 4. Admission: the false-reject ⇆ abort trade-off, safety unconditional -----------------------
console.log("\n[4] admission (L=1000, m=512, g=1):");
function warmedLearner(): ReservationPolicy {
  const l = createOnlineReservation({ holdCost: H, overrunCost: P, maxReservation: 512 });
  for (const c of heavyTailLengths(3000, 120, 512, 99)) l.observe(c); // pre-train to steady state
  return learnedReservationPolicy(l);
}
for (const C of [8, 16]) {
  const opts = { budget: 1000, slots: C, maxTokens: 512, chunk: 1, rounds: 400 };
  const q = heavyTailLengths(400, 120, 512, 7);
  const policies: ReadonlyArray<readonly [string, ReservationPolicy]> = [
    ["greedy   (r=0)", greedyReservationPolicy],
    ["reserveMx(r=m)", maxReservationPolicy(512)],
    ["learned  (τ) ", warmedLearner()],
    ["oracle   (r=c)", oracleReservationPolicy],
  ];
  console.log(`  C=${C}:`);
  for (const [name, pol] of policies) {
    const r = simulateAdmission(q, pol, opts);
    console.log(
      `    ${name}  util=${r.utilization.toFixed(3)} admitted=${r.admitted} completed=${r.completed} ` +
        `aborts=${r.aborts} served=${r.served} overshoot=${r.overshoot}`,
    );
  }
}

// ---- 5. Sanity: pinball cost / critical fractile -------------------------------------------------
console.log("\n[5] cost-model sanity:");
console.log(
  `  reservationCost(100, 60, 1, 4) = ${reservationCost(100, 60, H, P)} (over by 40 ⇒ 40·h=40)`,
);
console.log(
  `  reservationCost(60, 100, 1, 4) = ${reservationCost(60, 100, H, P)} (under by 40 ⇒ 40·p=160)`,
);
