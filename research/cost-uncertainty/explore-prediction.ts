/**
 * Calibration harness for TALE Layer 3 (predictions-with-safety). Prints the exact seeded numbers
 * asserted by test/cost/predicted-reservation.test.ts. Run: `npx tsx research/cost-uncertainty/explore-prediction.ts`.
 * Reproducible record of the chosen thresholds (cf. GALE's research/gale/explore-all.ts).
 */
import {
  bestFixedReservationCost,
  createOnlineReservation,
  criticalFractile,
  greedyReservationPolicy,
  reservationCost,
  simulateAdmission,
  simulateReservation,
} from "../../test/cost/learned-reservation";
import {
  createPredictiveReservation,
  predictAdversarial,
  predictByRank,
  predictPerfect,
  predictiveReservationPolicy,
  simulatePredictiveReservation,
} from "../../test/cost/predicted-reservation";
import { heavyTailLengths } from "../../test/cost/token-budget";

const H = 1;
const P = 4;
const M = 512;
const CAND = Array.from({ length: M + 1 }, (_u, i) => i);
const trace = heavyTailLengths(3000, 120, M, 11);

const robustOnly = simulateReservation(
  trace,
  createOnlineReservation({ holdCost: H, overrunCost: P, maxReservation: M }),
  H,
  P,
).cost;
const bestFixed = bestFixedReservationCost(trace, H, P, CAND).cost;
console.log(
  `τ=${criticalFractile(H, P)} robustOnly=${robustOnly.toFixed(0)} bestFixed=${bestFixed.toFixed(0)} clairvoyant=0`,
);

const pureFollow = (preds: readonly number[]): number => {
  let cost = 0;
  for (let t = 0; t < trace.length; t++)
    cost += reservationCost(Math.max(0, Math.min(M, preds[t] ?? 0)), trace[t] ?? 0, H, P);
  return cost;
};

for (const eta of [1e-2, 1e-3, 1e-4]) {
  console.log(`\n=== Hedge η=${eta} ===`);
  const mk = () =>
    createPredictiveReservation({
      holdCost: H,
      overrunCost: P,
      maxReservation: M,
      learningRate: eta,
    });
  const cases: ReadonlyArray<readonly [string, number[]]> = [
    ["perfect    ", predictPerfect(trace)],
    ["good(rn.1) ", predictByRank(trace, 0.1, 21)],
    ["good(rn.3) ", predictByRank(trace, 0.3, 21)],
    ["adversarial", predictAdversarial(trace)],
  ];
  for (const [name, preds] of cases) {
    const sizer = mk();
    const { cost } = simulatePredictiveReservation(trace, preds, sizer, H, P);
    const [wf, wr] = sizer.weights;
    console.log(
      `  ${name}: predictive=${cost.toFixed(0)} (vs robust ${(cost / robustOnly).toFixed(3)}, pureFollow ${pureFollow(preds).toFixed(0)}) ` +
        `weights[follow,robust]=[${wf.toFixed(3)},${wr.toFixed(3)}]`,
    );
  }
}

// ---- Safety: overshoot under good AND adversarial predictions ------------------------------------
console.log("\n=== admission safety (L=1000, C=16, g=1) ===");
const opts = { budget: 1000, slots: 16, maxTokens: M, chunk: 1, rounds: 400 };
const q = heavyTailLengths(400, 120, M, 7);
const mkPol = (preds: number[]) => {
  const pr = createPredictiveReservation({
    holdCost: H,
    overrunCost: P,
    maxReservation: M,
    learningRate: 1e-3,
  });
  for (const c of heavyTailLengths(3000, 120, M, 99)) pr.observe(c); // warm
  return { pol: predictiveReservationPolicy(pr), preds };
};
for (const [name, preds] of [
  ["good   ", predictByRank(q, 0.1, 21)],
  ["adversarial", predictAdversarial(q)],
] as const) {
  const { pol, preds: pp } = mkPol(preds as number[]);
  const r = simulateAdmission(q, pol, opts, pp);
  console.log(
    `  ${name}: util=${r.utilization.toFixed(3)} admitted=${r.admitted} aborts=${r.aborts} overshoot=${r.overshoot}`,
  );
}
// greedy/chunked overshoot reference at g=8
const r8 = simulateAdmission(q, greedyReservationPolicy, { ...opts, chunk: 8 });
console.log(`  greedy g=8 (overshoot ref): overshoot=${r8.overshoot} (<= C*g-ish)`);
