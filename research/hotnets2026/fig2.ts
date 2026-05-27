/**
 * Fig 2 generator — "the thesis in one plot": worst-case budget overshoot vs the quantity that
 * determines it, on BOTH axes, for the corner heuristic vs window-coupled escrow.
 *
 * Regenerated from the real simulators (no hand-copied numbers):
 *   - placement: test/gale/evaluate.ts (legacy carryover vs window-coupled leasing), Δ vs N
 *   - cost:      test/cost/token-budget.ts (admit-then-count vs streaming g=1), Δ vs max_tokens
 *
 * Two adversarial traces that *realize* the worst-case bounds:
 *   - placement: a 2-window trace — window 0 demand 1/node (each leases batch B, holds B-1), window 1
 *     heavy (each spends its B-1 carryover ON TOP of a fresh full budget) ⇒ legacy overshoot = N(B-1).
 *   - cost: a cap-hitting queue (every request runs to max_tokens) ⇒ admit-then-count overshoot =
 *     C·m − L at the boundary (the C completing streams charge m each).
 *
 * Emits fig2-data.csv and a dependency-free two-panel fig2.svg.
 * Run: npx tsx research/hotnets2026/fig2.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { simulate } from "../../test/cost/token-budget";
import { evaluateScheme } from "../../test/gale/evaluate";

// ---------------------------------------------------------------- placement axis: Δ vs N
const B = 10;
const L_PLACE = 200; // ≥ max(N)·B so the warm-up window can lease a full batch per node
const NS = [2, 4, 8, 16] as const;

const placement = NS.map((n) => {
  // window 0: demand 1 per node (lease B, use 1, hold B-1); window 1: heavy (spend carryover + fresh L)
  const traces: number[][] = Array.from({ length: n }, () => [1, L_PLACE * 4]);
  const legacy = evaluateScheme(traces, L_PLACE, {
    kind: "leasedFixed",
    batch: B,
    windowCoupled: false,
  });
  const coupled = evaluateScheme(traces, L_PLACE, {
    kind: "leasedFixed",
    batch: B,
    windowCoupled: true,
  });
  return { x: n, corner: legacy.overshoot, coupled: coupled.overshoot };
});

// ---------------------------------------------------------------- cost axis: Δ vs max_tokens
const L_COST = 1000;
const C = 4;
const MS = [256, 512, 1024, 2048] as const;

const cost = MS.map((m) => {
  const queue: number[] = new Array(C * 8).fill(m); // cap-hitting: every request runs to m (worst case)
  const rounds = L_COST + m + 10; // enough to exhaust the budget and drain in-flight streams
  const base = { budget: L_COST, slots: C, maxTokens: m, chunk: 1, rounds } as const;
  const atc = simulate(queue, { ...base, scheme: "admitThenCount" });
  const stream = simulate(queue, { ...base, scheme: "streaming" });
  return { x: m, corner: atc.overshoot, coupled: stream.overshoot };
});

// ---------------------------------------------------------------- report + CSV
const fmt = (rows: { x: number; corner: number; coupled: number }[], L: number) =>
  rows
    .map(
      (r) =>
        `  x=${r.x}\tcorner Δ=${r.corner} (${(r.corner / L).toFixed(3)}·L)\twindow-coupled Δ=${r.coupled}`,
    )
    .join("\n");

console.log("Fig 2 — worst-case overshoot Δ (regenerated from the real simulators)\n");
console.log(
  `PLACEMENT (Δ vs N; batch B=${B}, L=${L_PLACE}); expect corner = N·(B−1) = 9N, coupled 0:`,
);
console.log(fmt(placement, L_PLACE));
console.log(
  `\nCOST (Δ vs max_tokens; C=${C}, L=${L_COST}, g=1); expect corner = C·m−L, coupled 0:`,
);
console.log(fmt(cost, L_COST));

const csv = [
  "panel,scheme,x,overshoot,overshoot_over_L",
  ...placement.flatMap((r) => [
    `placement,corner(legacy),${r.x},${r.corner},${(r.corner / L_PLACE).toFixed(4)}`,
    `placement,window-coupled,${r.x},${r.coupled},${(r.coupled / L_PLACE).toFixed(4)}`,
  ]),
  ...cost.flatMap((r) => [
    `cost,corner(admit-then-count),${r.x},${r.corner},${(r.corner / L_COST).toFixed(4)}`,
    `cost,window-coupled(streaming),${r.x},${r.coupled},${(r.coupled / L_COST).toFixed(4)}`,
  ]),
].join("\n");

// ---------------------------------------------------------------- dependency-free two-panel SVG
type Pt = { x: number; y: number };
const W = 760;
const H = 320;

function panel(
  ox: number,
  title: string,
  xlabel: string,
  rows: { x: number; corner: number; coupled: number }[],
  L: number,
): string {
  const pw = 300;
  const ph = 210;
  const oy = 50;
  const xs = rows.map((r) => r.x);
  const xmin = Math.min(...xs);
  const xmax = Math.max(...xs);
  const ymax = Math.max(1, ...rows.map((r) => r.corner / L)) * 1.1;
  const px = (x: number) => ox + ((x - xmin) / (xmax - xmin)) * pw;
  const py = (y: number) => oy + ph - (y / ymax) * ph;
  const line = (sel: (r: { corner: number; coupled: number }) => number, color: string) => {
    const pts: Pt[] = rows.map((r) => ({ x: px(r.x), y: py(sel(r) / L) }));
    const poly = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const dots = pts
      .map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="${color}"/>`)
      .join("");
    return `<polyline points="${poly}" fill="none" stroke="${color}" stroke-width="2"/>${dots}`;
  };
  const xticks = rows
    .map(
      (r) =>
        `<text x="${px(r.x).toFixed(1)}" y="${oy + ph + 16}" font-size="11" text-anchor="middle">${r.x}</text>`,
    )
    .join("");
  return `
  <text x="${ox + pw / 2}" y="${oy - 24}" font-size="13" font-weight="bold" text-anchor="middle">${title}</text>
  <line x1="${ox}" y1="${oy}" x2="${ox}" y2="${oy + ph}" stroke="#333"/>
  <line x1="${ox}" y1="${oy + ph}" x2="${ox + pw}" y2="${oy + ph}" stroke="#333"/>
  <text x="${ox - 34}" y="${oy + 6}" font-size="11">${ymax.toFixed(1)}·L</text>
  <text x="${ox - 16}" y="${oy + ph}" font-size="11">0</text>
  <text x="${ox + pw / 2}" y="${oy + ph + 34}" font-size="12" text-anchor="middle">${xlabel}</text>
  ${line((r) => r.corner, "#c0392b")}
  ${line((r) => r.coupled, "#1565c0")}
  ${xticks}`;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="sans-serif">
  <rect width="${W}" height="${H}" fill="white"/>
  <text x="${W / 2}" y="22" font-size="15" font-weight="bold" text-anchor="middle">Worst-case overshoot Δ/L vs. the quantity that determines it</text>
  ${panel(70, "(a) placement axis", "fleet size N", placement, L_PLACE)}
  ${panel(430, "(b) cost axis", "max_tokens", cost, L_COST)}
  <g transform="translate(${W / 2 - 150},${H - 14})" font-size="11">
    <rect x="0" y="-9" width="12" height="3" fill="#c0392b"/><text x="18" y="-4">admit-then-count (corner)</text>
    <rect x="170" y="-9" width="12" height="3" fill="#1565c0"/><text x="188" y="-4">window-coupled escrow</text>
  </g>
</svg>`;

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, "fig2-data.csv"), `${csv}\n`);
writeFileSync(join(here, "fig2.svg"), svg);
console.log(`\nwrote fig2-data.csv and fig2.svg to ${here}`);
