/**
 * ============================================================================
 *  GATE — Federated Weighted Fair Escrow (TK-1404, #176)
 *  "Does per-region WFE compose to a GLOBAL weighted-max-min guarantee?"
 * ============================================================================
 *
 * Run: npx tsx research/bigger-bets/federation/federated-wfe-gate.ts
 *
 * ----------------------------------------------------------------------------
 * THE QUESTION
 * ----------------------------------------------------------------------------
 * Pillar 4 (`weightedFairEscrow`) proves four in-region theorems (T1 safety,
 * T2 sharing-incentive, T3 work-conservation, T4 bounded unfairness) for ONE
 * budget L shared across tenants. PILLAR4-fairness.md closes with the open
 * item: "hierarchical/nested weights (tenants-within-regions) are a clean
 * extension, not modelled here." This gate models it and asks whether running
 * WFE independently per region — each region drawing from a global budget —
 * yields the same per-tenant allocation a *flat*, single-pool global WFE would.
 *
 * ----------------------------------------------------------------------------
 * WHAT THE LITERATURE SAYS (and why naive composition is NOT automatic)
 * ----------------------------------------------------------------------------
 * Hierarchical max-min fairness (HMM) is in GENERAL **not** flat max-min
 * fairness. The HLS round-robin scheduler (Saeed et al., "A Round-Robin Packet
 * Scheduler for Hierarchical Max-Min Fairness", arXiv:2108.09864) evaluates
 * fairness PER SIBLING-GROUP — which gives per-branch ISOLATION, deliberately
 * not global fairness ("the difference is by design, not a fundamental
 * limitation"). For federation that is the WRONG thing: a tenant must not be
 * penalised for which region it happens to live in. The regions are plumbing,
 * not a policy boundary.
 *
 * The collapse condition is the Parekh-Gallager GPS decomposition (ToN'93):
 * an internal node whose weight equals the SUM of its children's weights makes
 * the hierarchical allocation reproduce the flat one. Bennett-Zhang H-PFQ
 * (ToN'97) shows the packet/quantum approximation accumulates a bounded error
 * PER LEVEL (HLS Lemma 4/5: a leaf's deficit < one max request; an internal
 * node's deficit accumulates its descendants' quanta). So flat global fairness
 * IS achievable, with a quantified two-level residual — no impossibility.
 *
 * ----------------------------------------------------------------------------
 * THE THEOREM (what this gate verifies)
 * ----------------------------------------------------------------------------
 * Setup. Global integer budget L for a key. Tenants t with global weight w_t
 * and per-window demand d_t, distributed across regions r with regional demand
 * d_{t,r} (Σ_r d_{t,r} = d_t). "Leaf" (t,r) = tenant t's presence in region r.
 *
 * Construction (the mechanism).
 *   (1) WEIGHT-SPLIT: partition w_t across t's active regions, w_{t,r} ≥ 0 with
 *       Σ_r w_{t,r} = w_t. Policy that works: demand-proportional
 *       w_{t,r} = w_t · d_{t,r}/d_t.
 *   (2) Each region runs in-region WFE over its leaves with weights w_{t,r}.
 *   (3) The region draws budget from the global pool by leasing at a rate ∝ its
 *       currently-BACKLOGGED aggregate leaf weight, returning surplus when its
 *       leaves saturate (reclamation).
 *
 * Claim. The per-tenant global total a_t = Σ_r a_{t,r} equals the flat global
 * weighted-max-min allocation a*_t —
 *   (T-FED-1, safety)   Σ_t a_t ≤ L always (inherited window-coupling);
 *   (T-FED-2, exactness) EXACTLY in the fluid limit, for demand-proportional
 *                        split + dynamic backlogged-weight region rate;
 *   (T-FED-3, bound)    within a two-level DRR residual under discrete leasing:
 *       |a_t/w_t − a_s/w_s| ≤ q_L·(1/w_t+1/w_s) + q_R·(1/W_{r(t)}+1/W_{r(s)}).
 *
 * Proof of T-FED-2 (the crux). The streaming mechanism's fluid limit is a
 * SINGLE-level water-fill over the LEAVES (region rate ∝ backlogged leaf weight
 * ⟹ one global water level λ emerges). With demand-proportional split, the
 * flat per-tenant service a*_t = min(d_t, w_t λ*) distributes across regions as
 * s_{t,r} = a*_t·(d_{t,r}/d_t), and a short case split (demand- vs weight-
 * bottlenecked) gives s_{t,r} = min(d_{t,r}, w_{t,r} λ*) — exactly the leaf
 * water-fill term. Summing the leaf water-fill over all leaves at λ* yields
 * min(Σd, L), so the leaf water level IS λ*, and a_t = Σ_r min(d_{t,r}, w_{t,r}
 * λ*) = a*_t. ∎  (Full write-up: PILLAR4-fairness.md §"Federated composition".)
 *
 * ----------------------------------------------------------------------------
 * THE FAILURE BOUNDARY (four cells this gate must also light up)
 * ----------------------------------------------------------------------------
 *  F1  fixed/equal region weights (regions as isolation classes, à la HLS
 *      link-sharing)  →  per-region isolation, NOT flat. A lone tenant in a
 *      light region beats identical tenants crowded into another. Region weight
 *      MUST be the dynamic active aggregate.
 *  F2  full-weight replication of a region-spanning tenant (w_{t,r}=w_t in each
 *      region)  →  the tenant is counted k times, over-served ~k×. Weight MUST
 *      be split to sum to w_t.
 *  F3  STATIC two-level batch: treat a region as one node with CONSTANT
 *      aggregate weight W_r and demand D_r, water-fill regions then tenants  →
 *      fails whenever a region mixes demand-bottlenecked and weight-bottlenecked
 *      tenants (min-of-sums ≠ sum-of-mins). The region's top-level weight must
 *      track its BACKLOGGED mass, which the streaming lease/reclaim loop does
 *      automatically — motivating the streaming design over a batch one.
 *  F4  no cross-region reclamation (idle region's leased budget stranded)  →
 *      backlogged tenants can't use idle regions' surplus: work-conservation
 *      breaks, under-utilisation + unfairness vs flat.
 *
 * GO  iff: the mechanism (M1, demand-proportional split, dynamic aggregate
 * region weight, reclamation) reproduces flat global WFE within the predicted
 * two-level residual on every world AND the random sweep; AND each of F1..F4
 * produces a materially large deviation (proving they are real, necessary
 * design choices and not strawmen).
 *
 * ----------------------------------------------------------------------------
 * VERDICT (machine-checked below):  ✅ GO
 *   • fluid exactness EXACT (0) on 4 structured + 400 random worlds (T-FED-2);
 *   • Σ admitted ≤ L everywhere (T-FED-1);
 *   • discrete residual within span·(2·q_R+1), q_R-linear (worst 2→12→22 at
 *     q_R=1→8→16) — a pure DRR granularity slack, ~0.02% relative (T-FED-3);
 *   • F1 (fixed region weight, dev 268), F2 (weight double-count, 2×), F3
 *     (static batch, dev 14), F4 (no reclamation, dev 145) all light up.
 * ⟹ Per-region WFE DOES compose to a global weighted-max-min guarantee, given
 *   (i) demand-proportional weight-split, (ii) dynamic backlogged-aggregate
 *   region weight, (iii) global within-window reclamation. Build it.
 */

/* eslint-disable no-console */

import { ManualClock } from "../../../src/core/clock";
import {
  federatedWeightedFairEscrow,
  regionFairPool,
} from "../../../src/twotier/federated-weighted-fair-escrow";

// ───────────────────────────── world model ─────────────────────────────────

/** Tenant t's presence in one region: global weight w_t, regional demand d_{t,r}. */
interface Leaf {
  tenant: string;
  region: string;
  globalWeight: number; // w_t (same across all of t's leaves)
  demand: number; // d_{t,r}
}

interface World {
  name: string;
  limit: number; // L
  leaves: Leaf[];
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** Aggregate leaves to per-tenant {weight, demand}. */
function tenants(world: World): { id: string; weight: number; demand: number }[] {
  const byId = new Map<string, { id: string; weight: number; demand: number }>();
  for (const lf of world.leaves) {
    const cur = byId.get(lf.tenant);
    if (cur) cur.demand += lf.demand;
    else byId.set(lf.tenant, { id: lf.tenant, weight: lf.globalWeight, demand: lf.demand });
  }
  return [...byId.values()];
}

// ───────────────────────── oracles (flat ground truth) ─────────────────────

/**
 * Continuous flat weighted max-min (water-filling). Mirrors test/gale/fair-escrow.ts
 * `waterfill` exactly so the gate's oracle is the shipped ideal.
 */
function waterfillFloat(demands: number[], weights: number[], limit: number): number[] {
  const n = demands.length;
  const alloc = new Array<number>(n).fill(0);
  const order = [...Array(n).keys()].sort(
    (a, b) => demands[a]! / weights[a]! - demands[b]! / weights[b]!,
  );
  let rem = limit;
  let activeWeight = sum(weights);
  for (let k = 0; k < n; k++) {
    const i = order[k]!;
    const w = weights[i]!;
    const d = demands[i]!;
    const level = activeWeight > 0 ? rem / activeWeight : 0;
    if (w * level >= d) {
      alloc[i] = d;
      rem -= d;
      activeWeight -= w;
    } else {
      for (let j = k; j < n; j++) alloc[order[j]!] = weights[order[j]!]! * level;
      break;
    }
  }
  return alloc;
}

/** Exact integer flat weighted max-min via unit drip. Mirrors `waterfillInt`. O(L·N). */
function waterfillInt(demands: number[], weights: number[], limit: number): number[] {
  const n = demands.length;
  const alloc = new Array<number>(n).fill(0);
  let budget = Math.floor(limit);
  while (budget > 0) {
    let best = -1;
    let bestRatio = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      if (alloc[i]! >= demands[i]!) continue;
      const ratio = alloc[i]! / weights[i]!;
      if (ratio < bestRatio) {
        bestRatio = ratio;
        best = i;
      }
    }
    if (best === -1) break;
    alloc[best]!++;
    budget--;
  }
  return alloc;
}

/** Flat per-tenant oracle (float) — the global weighted-max-min ground truth. */
function flatOracleFloat(world: World): Map<string, number> {
  const ts = tenants(world);
  const a = waterfillFloat(
    ts.map((t) => t.demand),
    ts.map((t) => t.weight),
    world.limit,
  );
  return new Map(ts.map((t, i) => [t.id, a[i]!]));
}

/** Flat per-tenant oracle (integer unit-drip) — the realised-credit ground truth. */
function flatOracleInt(world: World): Map<string, number> {
  const ts = tenants(world);
  const a = waterfillInt(
    ts.map((t) => t.demand),
    ts.map((t) => t.weight),
    world.limit,
  );
  return new Map(ts.map((t, i) => [t.id, a[i]!]));
}

// ──────────────────────────── weight-split policies ────────────────────────

type SplitPolicy = "demandProportional" | "fullReplication" | "homeRegion";

/** Assign each leaf its in-region weight w_{t,r} under `policy`. Returns leaf weights. */
function leafWeights(world: World, policy: SplitPolicy): number[] {
  // group leaf indices by tenant
  const idxByTenant = new Map<string, number[]>();
  world.leaves.forEach((lf, i) => {
    const arr = idxByTenant.get(lf.tenant) ?? [];
    arr.push(i);
    idxByTenant.set(lf.tenant, arr);
  });
  const w = new Array<number>(world.leaves.length).fill(0);
  for (const idxs of idxByTenant.values()) {
    const wt = world.leaves[idxs[0]!]!.globalWeight;
    const dTotal = sum(idxs.map((i) => world.leaves[i]!.demand));
    if (policy === "fullReplication") {
      // BUG (F2): every leaf gets the full global weight → tenant counted k times.
      for (const i of idxs) w[i] = wt;
    } else if (policy === "homeRegion") {
      // All weight on the highest-demand region; other leaves get ~0 weight.
      let home = idxs[0]!;
      for (const i of idxs) if (world.leaves[i]!.demand > world.leaves[home]!.demand) home = i;
      for (const i of idxs) w[i] = i === home ? wt : 1e-9;
    } else {
      // demand-proportional: w_{t,r} = w_t · d_{t,r}/d_t  (Σ_r = w_t).
      for (const i of idxs) {
        w[i] = dTotal > 0 ? (wt * world.leaves[i]!.demand) / dTotal : wt / idxs.length;
      }
    }
  }
  return w;
}

// ───────────── M1: joint-leaf water-fill (the mechanism's fluid limit) ──────

/**
 * The CORRECT mechanism's fluid limit: a single global water-fill over the
 * leaves with leaf weights w_{t,r}. Region rate ∝ backlogged leaf weight ⟹ one
 * global level λ emerges (no region-weight parameter appears — it is the Σ of
 * backlogged leaf weights at each level). Returns per-tenant totals.
 */
function mechanismFluid(world: World, split: SplitPolicy): Map<string, number> {
  const w = leafWeights(world, split);
  const a = waterfillFloat(
    world.leaves.map((l) => l.demand),
    w,
    world.limit,
  );
  return perTenant(world, a);
}

// ───────────── M2: STATIC two-level batch (the naive composition, F1/F3) ────

type RegionWeightPolicy = "aggregate" | "equalFixed";

/**
 * The NAIVE batch composition: water-fill REGIONS as single nodes with constant
 * weight W_r (policy) and demand D_r, then water-fill each region's L_r over its
 * leaves. This is what "just run WFE per region with a fixed regional quota"
 * does. F1 (equalFixed) and F3 (aggregate, but static) both live here.
 */
function staticTwoLevel(
  world: World,
  split: SplitPolicy,
  regionWeight: RegionWeightPolicy,
): Map<string, number> {
  const w = leafWeights(world, split);
  const regions = [...new Set(world.leaves.map((l) => l.region))];
  const idxByRegion = new Map<string, number[]>();
  world.leaves.forEach((lf, i) => {
    const arr = idxByRegion.get(lf.region) ?? [];
    arr.push(i);
    idxByRegion.set(lf.region, arr);
  });

  const Wr = regions.map((r) =>
    regionWeight === "equalFixed" ? 1 : sum(idxByRegion.get(r)!.map((i) => w[i]!)),
  );
  const Dr = regions.map((r) => sum(idxByRegion.get(r)!.map((i) => world.leaves[i]!.demand)));
  const Lr = waterfillFloat(Dr, Wr, world.limit);

  const leafAlloc = new Array<number>(world.leaves.length).fill(0);
  regions.forEach((r, ri) => {
    const idxs = idxByRegion.get(r)!;
    const inner = waterfillFloat(
      idxs.map((i) => world.leaves[i]!.demand),
      idxs.map((i) => w[i]!),
      Lr[ri]!,
    );
    idxs.forEach((i, k) => {
      leafAlloc[i] = inner[k]!;
    });
  });
  return perTenant(world, leafAlloc);
}

// ───────────── M1-discrete: the streaming mechanism (what ships) ────────────

interface StreamResult {
  perTenant: Map<string, number>;
  total: number; // Σ admitted (safety: ≤ L)
  coordinationRTT: number; // region↔coordinator leases (the q_R round trips)
}

/**
 * Faithful discrete realisation of the streaming mechanism.
 *
 *  - Global coordinator = one FCFS integer budget (the existing
 *    GlobalCoordinator.lease semantics: grant min(tokens, budget)).
 *  - Each round, the backlogged region with the smallest L_r / W_r^backlogged
 *    leases a chunk of q_R from the coordinator (region-level weighted DRR;
 *    region rate ∝ backlogged aggregate leaf weight) and unit-drips it to its
 *    own backlogged leaves by smallest a/w (in-region WFE, quantum q_L = 1).
 *  - reclaim=false strands a region's share (no cross-region surplus flow): the
 *    F4 foil. reclaim=true is the mechanism (idle region stops leasing; its
 *    budget stays in the global pool for backlogged regions).
 *
 * region rate policy: "aggregate" (correct) vs "equalFixed" (F1).
 */
function streamingMechanism(
  world: World,
  split: SplitPolicy,
  qR: number,
  opts: { regionWeight: RegionWeightPolicy; reclaim: boolean },
): StreamResult {
  const w = leafWeights(world, split);
  const regions = [...new Set(world.leaves.map((l) => l.region))];
  const idxByRegion = new Map<string, number[]>();
  world.leaves.forEach((lf, i) => {
    const arr = idxByRegion.get(lf.region) ?? [];
    arr.push(i);
    idxByRegion.set(lf.region, arr);
  });

  const alloc = new Array<number>(world.leaves.length).fill(0);
  const Lr = new Map<string, number>(regions.map((r) => [r, 0])); // leased+held by region
  const usedR = new Map<string, number>(regions.map((r) => [r, 0])); // served by region
  let budget = Math.floor(world.limit);
  let rtt = 0;

  // For F4 (no reclamation): pre-partition the budget by initial region share and
  // forbid a region from exceeding it (idle surplus is stranded, not pooled).
  const cap = new Map<string, number>();
  if (!opts.reclaim) {
    const Wr0 = regions.map((r) =>
      opts.regionWeight === "equalFixed" ? 1 : sum(idxByRegion.get(r)!.map((i) => w[i]!)),
    );
    const totW = sum(Wr0);
    regions.forEach((r, ri) => cap.set(r, Math.floor((Wr0[ri]! / totW) * world.limit)));
  }

  const backloggedWeight = (r: string): number =>
    opts.regionWeight === "equalFixed"
      ? idxByRegion.get(r)!.some((i) => alloc[i]! < world.leaves[i]!.demand)
        ? 1
        : 0
      : sum(
          idxByRegion
            .get(r)!
            .filter((i) => alloc[i]! < world.leaves[i]!.demand)
            .map((i) => w[i]!),
        );

  // A region's in-region water level = min a/w over its CURRENTLY-backlogged leaves
  // (saturated leaves excluded — their spent credits must NOT count against the region's
  // remaining backlogged leaves; that conflation was the bug that broke F3-in-the-large).
  // This is exactly the state the in-region WFE already tracks locally, so a region can
  // compute it without seeing any other region. Picking the globally-lowest level equalises
  // water levels across regions ⟹ the single global water-fill, within the q_R chunk.
  const regionWaterLevel = (r: string): number => {
    let lo = Number.POSITIVE_INFINITY;
    for (const i of idxByRegion.get(r)!) {
      if (alloc[i]! >= world.leaves[i]!.demand) continue; // saturated → excluded
      lo = Math.min(lo, alloc[i]! / w[i]!);
    }
    return lo;
  };

  for (let guard = 0; budget > 0 && guard < 10_000_000; guard++) {
    // lease the next q_R chunk to the most-starved backlogged region (lowest water level)
    let pick: string | null = null;
    let bestLevel = Number.POSITIVE_INFINITY;
    for (const r of regions) {
      if (backloggedWeight(r) <= 0) continue; // no backlogged leaf
      if (!opts.reclaim && usedR.get(r)! >= cap.get(r)!) continue; // F4: hit its static cap
      const level = regionWaterLevel(r);
      if (level < bestLevel) {
        bestLevel = level;
        pick = r;
      }
    }
    if (pick === null) break; // nobody can use more

    // lease a q_R chunk from the FCFS coordinator
    let chunk = Math.min(qR, budget);
    if (!opts.reclaim) chunk = Math.min(chunk, cap.get(pick)! - usedR.get(pick)!);
    if (chunk <= 0) break;
    rtt++;
    budget -= chunk;
    Lr.set(pick, Lr.get(pick)! + chunk);

    // unit-drip the chunk to the region's backlogged leaves (in-region WFE)
    const idxs = idxByRegion.get(pick)!;
    let held = chunk;
    while (held > 0) {
      let best = -1;
      let br = Number.POSITIVE_INFINITY;
      for (const i of idxs) {
        if (alloc[i]! >= world.leaves[i]!.demand) continue;
        const ratio = alloc[i]! / w[i]!;
        if (ratio < br) {
          br = ratio;
          best = i;
        }
      }
      if (best === -1) break; // region saturated mid-chunk
      alloc[best]!++;
      held--;
      usedR.set(pick, usedR.get(pick)! + 1);
    }
    // return the unused tail of the chunk to the global pool (reclamation within a round)
    budget += held;
    Lr.set(pick, Lr.get(pick)! - held);
  }

  return { perTenant: perTenant(world, alloc), total: sum(alloc), coordinationRTT: rtt };
}

// ────────────────────────────── helpers ────────────────────────────────────

function perTenant(world: World, leafAlloc: number[]): Map<string, number> {
  const m = new Map<string, number>();
  world.leaves.forEach((lf, i) => m.set(lf.tenant, (m.get(lf.tenant) ?? 0) + leafAlloc[i]!));
  return m;
}

/** max_t |a_t − oracle_t| over tenants. */
function maxDev(a: Map<string, number>, oracle: Map<string, number>): number {
  let m = 0;
  for (const [id, v] of oracle) m = Math.max(m, Math.abs((a.get(id) ?? 0) - v));
  return m;
}

/** Normalised-service spread max_t,s |a_t/w_t − a_s/w_s| over BACKLOGGED tenants. */
function normSpread(world: World, a: Map<string, number>): number {
  const ts = tenants(world);
  const vals: number[] = [];
  for (const t of ts) {
    const got = a.get(t.id) ?? 0;
    if (got < t.demand - 1e-9) vals.push(got / t.weight); // backlogged only
  }
  if (vals.length === 0) return 0;
  return Math.max(...vals) - Math.min(...vals);
}

// ──────────────────────────────── worlds ───────────────────────────────────

/** A: partitioned tenants; a heavy region and a light region. Foil for F1. */
const worldA: World = {
  name: "A: heavy region vs light region (partitioned)",
  limit: 1000,
  leaves: [
    // region us: one heavy tenant (w=10) + one medium (w=4), both backlogged hard
    { tenant: "whale", region: "us", globalWeight: 10, demand: 100000 },
    { tenant: "med", region: "us", globalWeight: 4, demand: 100000 },
    // region eu: two light tenants (w=1 each), backlogged hard
    { tenant: "min1", region: "eu", globalWeight: 1, demand: 100000 },
    { tenant: "min2", region: "eu", globalWeight: 1, demand: 100000 },
  ],
};

/** B: one tenant spans 3 regions; others local. Foil for F2 (double-count). */
const worldB: World = {
  name: "B: region-spanning tenant (foil for weight double-count)",
  limit: 1200,
  leaves: [
    { tenant: "spanner", region: "us", globalWeight: 3, demand: 100000 },
    { tenant: "spanner", region: "eu", globalWeight: 3, demand: 100000 },
    { tenant: "spanner", region: "ap", globalWeight: 3, demand: 100000 },
    { tenant: "localU", region: "us", globalWeight: 3, demand: 100000 },
    { tenant: "localE", region: "eu", globalWeight: 3, demand: 100000 },
    { tenant: "localA", region: "ap", globalWeight: 3, demand: 100000 },
  ],
};

/** C: a region MIXING a demand-bottlenecked tenant and a weight-bottlenecked one.
 *  Foil for F3 (static aggregate batch: min-of-sums ≠ sum-of-mins). */
const worldC: World = {
  name: "C: mixed-bottleneck region (foil for static two-level batch)",
  limit: 100,
  leaves: [
    // us: a small-demand tenant (saturates early) + a huge-demand tenant (weight-capped)
    { tenant: "sipper", region: "us", globalWeight: 1, demand: 5 },
    { tenant: "gulper", region: "us", globalWeight: 1, demand: 100000 },
    // eu: one ordinary backlogged tenant
    { tenant: "steady", region: "eu", globalWeight: 1, demand: 100000 },
  ],
};

/** D: an idle region holding weight; backlogged tenants elsewhere. Foil for F4. */
const worldD: World = {
  name: "D: idle region surplus (foil for no-reclamation)",
  limit: 900,
  leaves: [
    { tenant: "busy1", region: "us", globalWeight: 1, demand: 100000 },
    { tenant: "busy2", region: "us", globalWeight: 1, demand: 100000 },
    { tenant: "idle", region: "eu", globalWeight: 1, demand: 10 }, // barely demands
  ],
};

// ───────────────────────── deterministic RNG (resume-safe) ──────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomWorld(rng: () => number, idx: number): World {
  const nRegions = 2 + Math.floor(rng() * 3); // 2..4
  const nTenants = 3 + Math.floor(rng() * 6); // 3..8
  const regions = Array.from({ length: nRegions }, (_, i) => `r${i}`);
  const leaves: Leaf[] = [];
  for (let t = 0; t < nTenants; t++) {
    const wt = 1 + Math.floor(rng() * 8);
    const spans = 1 + Math.floor(rng() * nRegions); // tenant active in 1..nRegions regions
    const chosen = [...regions].sort(() => rng() - 0.5).slice(0, spans);
    for (const r of chosen) {
      // mix of demand-bottlenecked (small) and weight-bottlenecked (huge) leaves
      const d = rng() < 0.4 ? 1 + Math.floor(rng() * 30) : 5000 + Math.floor(rng() * 100000);
      leaves.push({ tenant: `t${t}`, region: r, globalWeight: wt, demand: d });
    }
  }
  const totalDemand = sum(leaves.map((l) => l.demand));
  const limit = Math.max(10, Math.floor(totalDemand * (0.1 + rng() * 0.6))); // force contention
  return { name: `rand#${idx}`, limit, leaves };
}

// ──────────────────────────────── runner ───────────────────────────────────

let failures = 0;
const check = (cond: boolean, msg: string): void => {
  console.log(`   ${cond ? "✓" : "✗ FAIL"}  ${msg}`);
  if (!cond) failures++;
};

console.log("═".repeat(78));
console.log(" GATE — Federated Weighted Fair Escrow (TK-1404):  WFE∘WFE ?= flat global WFE");
console.log("═".repeat(78));

// ---- Part 1: fluid exactness (T-FED-2) on the four structured worlds --------
console.log("\n── Part 1: FLUID EXACTNESS — mechanism (demand-prop split) == flat oracle ──");
for (const world of [worldA, worldB, worldC, worldD]) {
  const oracle = flatOracleFloat(world);
  const mech = mechanismFluid(world, "demandProportional");
  const dev = maxDev(mech, oracle);
  check(dev < 1e-6, `${world.name}: max |a_t − a*_t| = ${dev.toExponential(2)} (want ≈0)`);
}

// ---- Part 2: safety (T-FED-1) — Σ admitted ≤ L (discrete streaming) ---------
console.log("\n── Part 2: SAFETY — Σ admitted ≤ L (discrete streaming mechanism) ──");
for (const world of [worldA, worldB, worldC, worldD]) {
  const r = streamingMechanism(world, "demandProportional", 8, {
    regionWeight: "aggregate",
    reclaim: true,
  });
  check(r.total <= world.limit, `${world.name}: Σ=${r.total} ≤ L=${world.limit}`);
}

// ---- Part 3: the four FAILURE cells must light up --------------------------
console.log("\n── Part 3: FAILURE BOUNDARY — naive variants must deviate materially ──");

// F1: fixed/equal region weights → HLS isolation. World A: identical light tenants in
// 'eu' must each get LESS normalised service than the 'us' tenants under isolation.
{
  const oracle = flatOracleFloat(worldA);
  const good = staticTwoLevel(worldA, "demandProportional", "aggregate");
  const bad = staticTwoLevel(worldA, "demandProportional", "equalFixed");
  const devGood = maxDev(good, oracle);
  const devBad = maxDev(bad, oracle);
  check(
    devBad > 50 && devGood < 1e-6,
    `F1 equal-region-weight isolation: dev_bad=${devBad.toFixed(1)} ≫ dev_good=${devGood.toExponential(1)}`,
  );
  const spreadBad = normSpread(worldA, bad);
  check(
    spreadBad > 1,
    `F1 makes normalised-service spread large (${spreadBad.toFixed(2)}) — isolation, not flat`,
  );
}

// F2: full-weight replication double-counts the spanner in World B.
{
  const oracle = flatOracleFloat(worldB);
  const good = mechanismFluid(worldB, "demandProportional");
  const bad = mechanismFluid(worldB, "fullReplication");
  const spannerStar = oracle.get("spanner")!;
  const spannerBad = bad.get("spanner")!;
  check(
    maxDev(good, oracle) < 1e-6,
    `F2 demand-prop split is exact (dev=${maxDev(good, oracle).toExponential(1)})`,
  );
  check(
    spannerBad > spannerStar * 1.5,
    `F2 full-replication over-serves spanner: ${spannerBad.toFixed(0)} vs fair ${spannerStar.toFixed(0)} (≥1.5×)`,
  );
}

// F3: static aggregate batch fails the mixed-bottleneck region C; the streaming
// mechanism (dynamic backlogged weight) gets it right.
{
  const oracle = flatOracleFloat(worldC);
  const batch = staticTwoLevel(worldC, "demandProportional", "aggregate"); // static W_r,D_r
  const mech = mechanismFluid(worldC, "demandProportional"); // dynamic backlogged weight
  const devBatch = maxDev(batch, oracle);
  const devMech = maxDev(mech, oracle);
  check(
    devBatch > 1 && devMech < 1e-6,
    `F3 static-batch dev=${devBatch.toFixed(2)} ≫ streaming-mechanism dev=${devMech.toExponential(1)}`,
  );
}

// F4: no reclamation strands the idle region's surplus in World D.
{
  const oracleInt = flatOracleInt(worldD);
  const withRecl = streamingMechanism(worldD, "demandProportional", 4, {
    regionWeight: "aggregate",
    reclaim: true,
  });
  const noRecl = streamingMechanism(worldD, "demandProportional", 4, {
    regionWeight: "aggregate",
    reclaim: false,
  });
  const devWith = maxDev(withRecl.perTenant, oracleInt);
  const devNo = maxDev(noRecl.perTenant, oracleInt);
  check(
    devNo > 50 && devWith <= 8,
    `F4 no-reclaim dev=${devNo.toFixed(0)} ≫ reclaim dev=${devWith.toFixed(0)} (idle surplus stranded)`,
  );
  check(
    withRecl.total > noRecl.total,
    `F4 reclamation lifts utilisation: ${withRecl.total} > ${noRecl.total} admitted`,
  );
}

// ---- Part 4: discrete two-level DRR bound (T-FED-3) on random worlds --------
console.log("\n── Part 4: DISCRETE BOUND — |a_t − a*_t| ≤ span(t)·(2·q_R+1), random sweep ──");
{
  const rng = mulberry32(0x0fedcafe);
  const TRIALS = 400;
  // Snapshot the worlds once so every q_R runs the identical sweep (resume-safe, comparable).
  const worlds = Array.from({ length: TRIALS }, (_, i) => randomWorld(rng, i));

  // 4a: fluid exactness (the theorem) — q_R-independent, check once.
  let fluidExactViolations = 0;
  for (const world of worlds) {
    if (maxDev(mechanismFluid(world, "demandProportional"), flatOracleFloat(world)) > 1e-6) {
      fluidExactViolations++;
    }
  }
  check(
    fluidExactViolations === 0,
    `fluid exactness held on all ${TRIALS} random worlds (violations=${fluidExactViolations})`,
  );

  // span(t) = number of distinct regions tenant t is active in (its hierarchy depth-1 fan-out).
  const tenantSpan = (world: World): Map<string, number> => {
    const m = new Map<string, Set<string>>();
    for (const lf of world.leaves)
      (m.get(lf.tenant) ?? m.set(lf.tenant, new Set()).get(lf.tenant)!).add(lf.region);
    return new Map([...m].map(([t, rs]) => [t, rs.size]));
  };

  // 4b: discrete streaming within span·(2·q_R+1) at three quanta — proves the residual is a
  // q_R-linear DRR slack, not a structural error. Per leaf: ≤ q_R/W_r^bk region-scheduling
  // overshoot + ≤ q_R/W_r^bk budget-boundary slack + 1 in-region drip, in NORMALISED units;
  // ×w_leaf and using w_leaf ≤ W_r^bk gives ≤ 2·q_R+1 credits per leaf, so a tenant spanning k
  // regions accumulates ≤ k·(2·q_R+1) (the two-level analog of HLS Lemma 5's deficit accrual).
  let worstByQ = "";
  for (const qR of [1, 8, 16]) {
    let safetyViolations = 0;
    let boundViolations = 0;
    let worstAbsDev = 0;
    let worstRatio = 0; // observed deviation / its span·(2·q_R+1) envelope
    for (const world of worlds) {
      const oracleI = flatOracleInt(world);
      const span = tenantSpan(world);
      const r = streamingMechanism(world, "demandProportional", qR, {
        regionWeight: "aggregate",
        reclaim: true,
      });
      if (r.total > world.limit) safetyViolations++;
      for (const [id, star] of oracleI) {
        const dev = Math.abs((r.perTenant.get(id) ?? 0) - star);
        const bound = (span.get(id) ?? 1) * (2 * qR + 1);
        if (dev > bound) boundViolations++;
        worstAbsDev = Math.max(worstAbsDev, dev);
        worstRatio = Math.max(worstRatio, dev / bound);
      }
    }
    check(safetyViolations === 0, `qR=${qR}: safety Σ≤L on all ${TRIALS} worlds`);
    check(
      boundViolations === 0,
      `qR=${qR}: every tenant within span·(2·qR+1) (violations=${boundViolations}, worst dev/bound=${worstRatio.toFixed(2)})`,
    );
    worstByQ += `  qR=${qR}→${worstAbsDev}`;
  }
  console.log(
    `   ·  worst per-tenant |a_t − a*_t|:${worstByQ}  (q_R-linear ⟹ pure DRR granularity, not structural)`,
  );
}

// ---- Part 5: SHIPPED-CODE validation — the real exports realize the theorem -
// Parts 1-4 prove the fluid composition THEOREM + failure boundary on abstract models. The shipped
// `regionFairPool` + `federatedWeightedFairEscrow` is the STREAMING realization: a two-level WFE
// (cross-region reservation-borrow ∘ in-region tenant WFE). It reproduces the flat oracle EXACTLY in
// the all-backlogged regime (below); under mixed saturation it inherits weightedFairEscrow's T3
// reserve gap (a saturated participant's guarantee is held until the window rolls), exactly like the
// flat streaming WFE it composes — NOT the clairvoyant fluid oracle, which no streaming limiter can
// match without a demand oracle. This part drives the ACTUAL code so the gate validates what ships.
console.log(
  "\n── Part 5: SHIPPED-CODE — real regionFairPool∘federatedWFE vs flat oracle (all-backlogged) ──",
);
{
  // Drive every region's tenants round-robin until the global budget is exhausted; all demands huge.
  const driveShipped = (
    L: number,
    perRegion: Record<string, Record<string, number>>, // region -> tenant -> weight
  ): Map<string, number> => {
    const clock = new ManualClock(0);
    const pool = regionFairPool({ limit: L, windowMs: 60_000, clock });
    const limiters = Object.entries(perRegion).map(([region, weights]) => ({
      region,
      tenants: Object.keys(weights),
      lim: federatedWeightedFairEscrow({ region, pool, weightOf: (t) => weights[t] ?? 1 }),
    }));
    const got = new Map<string, number>();
    for (let i = 0; i < 20_000; i++) {
      for (const { tenants: ts, lim } of limiters) {
        for (const t of ts) {
          if (lim.checkSync(t, 1).allowed) got.set(t, (got.get(t) ?? 0) + 1);
        }
      }
    }
    return got;
  };

  // S1: region-local tenants, varied weights — us{a:3,b:1}, eu{c:1}, ap{d:2}.
  {
    const L = 700;
    const got = driveShipped(L, { us: { a: 3, b: 1 }, eu: { c: 1 }, ap: { d: 2 } });
    const star = waterfillInt([1e9, 1e9, 1e9, 1e9], [3, 1, 1, 2], L); // flat over a,b,c,d
    const ids = ["a", "b", "c", "d"];
    let dev = 0;
    ids.forEach((id, i) => {
      dev = Math.max(dev, Math.abs((got.get(id) ?? 0) - (star[i] as number)));
    });
    const total = ids.reduce((s, id) => s + (got.get(id) ?? 0), 0);
    check(
      dev <= 4 && total <= L,
      `S1 region-local varied weights: max dev=${dev} (≤4), Σ=${total} ≤ ${L}`,
    );
  }

  // S2: a region-spanning tenant with demand-proportional split (equal demand ⇒ split weight/2 each).
  {
    const L = 600;
    // 'spanner' w=4 split across us,eu (equal demand ⇒ 2 each); localU w=4 (us), localE w=4 (eu).
    const got = driveShipped(L, { us: { spanner: 2, localU: 4 }, eu: { spanner: 2, localE: 4 } });
    const spanner = got.get("spanner") ?? 0;
    const star = waterfillInt([1e9, 1e9, 1e9], [4, 4, 4], L); // flat over spanner(4), localU(4), localE(4)
    const total = spanner + (got.get("localU") ?? 0) + (got.get("localE") ?? 0);
    check(
      Math.abs(spanner - (star[0] as number)) <= 6 && total <= L,
      `S2 spanning tenant (demand-prop split): spanner=${spanner} vs fair ${star[0]} (±6), Σ=${total} ≤ ${L}`,
    );
  }

  // S3: SAFETY under the shipped code — Σ admitted ≤ L across regions, several weights.
  {
    const L = 500;
    const got = driveShipped(L, { us: { a: 5 }, eu: { b: 3 }, ap: { c: 1 }, sa: { d: 1 } });
    const total = ["a", "b", "c", "d"].reduce((s, id) => s + (got.get(id) ?? 0), 0);
    check(total <= L, `S3 shipped Σ admitted = ${total} ≤ L=${L}`);
  }
}

// ──────────────────────────────── verdict ──────────────────────────────────
console.log(`\n${"═".repeat(78)}`);
if (failures === 0) {
  console.log(" VERDICT: ✅ GO — federated WFE (WFE∘WFE) reproduces flat global weighted-max-min.");
  console.log(
    "   • THEOREM (Parts 1-4): EXACT in the fluid limit with demand-proportional weight-",
  );
  console.log("     split + dynamic backlogged-weight region rate + reclamation (T-FED-2); Σ ≤ L");
  console.log("     always (T-FED-1); discrete error within span·(2·q_R+1) (T-FED-3); and F1-F4");
  console.log(
    "     (fixed region weight / weight double-count / static batch / no reclamation) each",
  );
  console.log("     deviate materially — the design choices are necessary, not cosmetic.");
  console.log("   • SHIPPED CODE (Part 5): the real regionFairPool∘federatedWFE matches the flat");
  console.log("     oracle within a few credits all-backlogged and never over-admits. Under mixed");
  console.log("     saturation it inherits weightedFairEscrow's T3 reserve gap (held until window");
  console.log("     roll) — the realizable streaming target, honestly NOT the clairvoyant oracle.");
} else {
  console.log(
    ` VERDICT: ❌ NO-GO — ${failures} check(s) failed; the composition does not hold as modelled.`,
  );
}
console.log("═".repeat(78));
process.exit(failures === 0 ? 0 : 1);
