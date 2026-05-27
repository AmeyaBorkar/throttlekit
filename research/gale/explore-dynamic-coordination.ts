/**
 * Stage 1 — exhaustive exploration of the DYNAMIC `≤ C`-message trilemma (the open problem left by
 * research/gale/TRILEMMA.md). Coordination is *dynamic and demand-driven*: a protocol pre-authorises a
 * local budget per node, holds the rest in a shared pool, and may issue at most `C` lease round-trips,
 * each granting a batch of up to `B` to whichever node is hot *now* — GALE leasing capped at C
 * round-trips. windowCoupled ⇒ overshoot Δ = 0; we characterise the residual U =
 * `min over pre-auth of max over demand of` under-utilisation, exactly, for small parameters.
 *
 * Solver kernel: test/gale/dynamic-coordination.ts (gated by dynamic-coordination.test.ts).
 * Run: npx tsx research/gale/explore-dynamic-coordination.ts
 */
import {
  dynamicLowerBoundU,
  dynamicUnitBatchU,
  optimalU,
} from "../../test/gale/dynamic-coordination";

console.log("C=0 recovers the static zero-coordination bound U = (N−1)L/N (uniform pre-auth L/N):");
for (const [N, L] of [
  [2, 8],
  [3, 9],
  [4, 8],
] as const) {
  const r = optimalU(N, L, 1, 0);
  console.log(`  N=${N} L=${L}: U*=${r.U}  (expected ${((N - 1) * L) / N})  bestB=[${r.bestB}]`);
}

console.log("\nDynamic frontier U*(N,L,B,C) (full pre-auth search; Δ=0 throughout):");
for (const [N, L] of [
  [2, 8],
  [3, 9],
] as const) {
  for (const B of [1, 2, 3, 4]) {
    const row: string[] = [];
    for (let C = 0; C <= N + 2; C++) row.push(`C=${C}:${optimalU(N, L, B, C).U}`);
    console.log(`  N=${N} L=${L} B=${B}:  ${row.join("  ")}`);
  }
}

console.log(
  "\nB=1 is tight to the closed form (N−1)(L−C)/N; B>1 exceeds the single-hot bound (strand):",
);
for (const [N, L, B, C] of [
  [3, 9, 1, 2],
  [3, 9, 3, 1],
  [3, 9, 3, 2],
  [4, 12, 3, 2],
] as const) {
  const u = optimalU(N, L, B, C).U;
  console.log(
    `  N=${N} L=${L} B=${B} C=${C}: U*=${u}  lowerBound=${dynamicLowerBoundU(N, L, B, C).toFixed(2)}` +
      `  B1-exact=${dynamicUnitBatchU(N, L, C)}  ${B === 1 ? (u === dynamicUnitBatchU(N, L, C) ? "(tight)" : "") : u > dynamicLowerBoundU(N, L, B, C) ? "(strand gap)" : ""}`,
  );
}

console.log("\nLarger N (uniform pre-auth, which the full search confirms optimal) — U*(N,L,B,C):");
for (const [N, L] of [
  [4, 12],
  [5, 10],
  [6, 6],
] as const) {
  for (const B of [1, 3]) {
    const row: string[] = [];
    for (let C = 0; C <= N + 1; C++) row.push(`C=${C}:${optimalU(N, L, B, C, true).U}`);
    console.log(`  N=${N} L=${L} B=${B}:  ${row.join("  ")}`);
  }
}
