import { describe, expect, it } from "vitest";

/**
 * TK-1316 — JS BFS twin of MODULE GaleHeartbeatLeasing
 * (`spec/GaleHeartbeatLeasing.tla`, DESIGN §6/§9/§10, D-DAC-17).
 *
 * The CI-runnable, Java-free counterpart of TLC: walks the entire reachable
 * state space exhaustively and asserts the committed formal safety invariants
 * (`TypeOK`, `GlobalCap`) on every reachable state, pins the distinct-state
 * count, and witnesses the intentionally-FALSE `GlobalCapTight` to show the
 * global budget `L` is the LEAST upper bound (the staggered distributed
 * allocation loses no steady-state capacity).
 *
 * GaleHeartbeatLeasing models the REAL STAGGERED, budget-capped protocol: each
 * node heartbeats independently against whatever fleet snapshot the coordinator
 * holds at that instant. A stateless equal-split (share = floor(L/N) per node)
 * VIOLATES the global budget under that staggering — a joiner computes its small
 * share while an incumbent still holds its larger pre-join share, so Sum(share)
 * transiently exceeds L with L CONSTANT. This twin models the cap that fixes it:
 *
 *   - Reallocate(n): node n heartbeats and is (re)granted a share, CAPPED at the
 *                    budget no OTHER active node is currently HOLDING —
 *                    share'[n] = max(0, min(Target, L − Σ_others max(share,
 *                    inflight))), Target = ceil(L / |active|). The share term
 *                    keeps Σ share ≤ L (D-DAC-17); the inflight term keeps
 *                    Σ inflight ≤ L (D-DAC-18) for ANY interleaving. (The max(0,…)
 *                    clamp is required: the Held-sum over peers can exceed L.)
 *   - Join(n):       a new node enters holding share 0 until it reallocates, so
 *                    an incumbent's outstanding share is never double-counted.
 *   - Leave(n):      a node departs (|active| stays >= 1); its share leaves the
 *                    live sum (budget reclaimed) and its in-flight is gone.
 *   - Acquire(n):    admit one request — only while inflight[n] < share[n].
 *   - Release(n):    a request on node n completes (event-release).
 *
 * TWO committed safety properties, both HARD and both maintained by the one cap:
 *   GlobalCap   == Sum(share    over active) <= L — never over-COMMIT (D-DAC-17).
 *   InflightCap == Sum(inflight over active) <= L — never over-OCCUPY (D-DAC-18):
 * a peer's non-revocable in-flight is reserved (max(share, inflight)), so a
 * joiner cannot ramp into capacity an incumbent has not yet drained. Under the
 * earlier share-ONLY cap, Sum(inflight) reached 1.5×L on a reachable state (then
 * framed as DESIGN §9.3 / D-DAC-14 liveness); the occupancy cap makes it an
 * invariant. This twin asserts BOTH on every reachable state of the SYNCHRONOUS
 * model. NOTE — the async implementation does NOT inherit InflightCap as a hard
 * instantaneous bound: reply latency + reporting lag leave a bounded, self-draining
 * residual the model abstracts away (it has no committed-vs-applied distinction).
 * That residual is reproduced + pinned in the property suite's deterministic
 * "async reply-lag residual" test; see DESIGN §9.3 / D-DAC-18.
 *
 * NOTE — TLC parity is PENDING a Java environment. Until the TLC run is
 * recorded, THIS twin is the local source of truth for the distinct-state count
 * and the invariants; the pinned literal below guards the transition system
 * against regressions (the same role TK-905 plays for the federation twin).
 *
 * Matches the style of `test/gale/federated/leasing-model.test.ts` (the
 * federation BFS twin).
 */

/** Model parameters: the TLA⁺ CONSTANTs `Nodes` and `L`. */
interface Params {
  /** Node identities (the TLA⁺ CONSTANT `Nodes`). */
  readonly nodes: readonly string[];
  /** The constant global concurrency budget for this heartbeat epoch (`L`). */
  readonly l: number;
}

interface State {
  /** active: subset of Nodes currently in the fleet (heartbeating). */
  readonly active: ReadonlySet<string>;
  /** share[n]: node n's currently-granted ceiling (0 when inactive). */
  readonly share: Readonly<Record<string, number>>;
  /** inflight[n]: node n's current in-flight count. */
  readonly inflight: Readonly<Record<string, number>>;
}

/** Which action produced a transition — used to assert Join is exercised. */
type Action = "Reallocate" | "Join" | "Leave" | "Acquire" | "Release";

interface Edge {
  readonly action: Action;
  readonly state: State;
}

/** SumOver(f, S): TLA⁺ recursive sum of f over the node set S. */
const sumOver = (f: Readonly<Record<string, number>>, nodes: Iterable<string>): number => {
  let acc = 0;
  for (const n of nodes) acc += f[n] ?? 0;
  return acc;
};

/** Min2(a, b) and Ceil(a, b) — the TLA⁺ operators, integer arithmetic. */
const min2 = (a: number, b: number): number => (a < b ? a : b);
const ceil = (a: number, b: number): number => Math.floor((a + b - 1) / b);

/** Allocation rule for the TARGET fed into the cap (D-DAC-9 / TK-1403). */
type Allocation = "equal-split" | "demand-proportional";

/** Target == Ceil(L, Cardinality(active)) — the per-node fair-share over-approx. */
const targetFor = (p: Params, active: ReadonlySet<string>): number => ceil(p.l, active.size);

/**
 * Demand-proportional TARGET (TK-1403), the exact model of
 * TestConcurrencyCoordinator.#targetFor: a SATISFIED node (inflight < share)
 * aspires to occupancy + 1 probe slot; HUNGRY nodes (inflight ≥ share) equal-split
 * the released budget, floor 1. Computed over the current active set's (share,
 * inflight). The CAP in Reallocate clamps it, so — like equal-split — it cannot
 * break GlobalCap/InflightCap; this run PROVES that exhaustively for the new rule.
 */
const targetDemandProportional = (p: Params, s: State, self: string): number => {
  const active = [...s.active].sort();
  const hungry: string[] = [];
  let reservedForSatisfied = 0;
  for (const id of active) {
    const inf = s.inflight[id] ?? 0;
    const sh = s.share[id] ?? 0;
    if (inf >= sh) hungry.push(id);
    else reservedForSatisfied += inf + 1;
  }
  const selfInf = s.inflight[self] ?? 0;
  const selfSh = s.share[self] ?? 0;
  if (selfInf < selfSh) return selfInf + 1;
  const H = hungry.length;
  if (H === 0) return selfInf + 1;
  const spare = Math.max(0, p.l - reservedForSatisfied);
  const base = Math.floor(spare / H);
  const rem = spare - base * H;
  const rank = hungry.indexOf(self);
  return Math.max(1, base + (rank < rem ? 1 : 0));
};

/** The TARGET for node `self` under the chosen allocation rule. */
const targetOf = (p: Params, s: State, self: string, allocation: Allocation): number =>
  allocation === "equal-split" ? targetFor(p, s.active) : targetDemandProportional(p, s, self);

/**
 * Held[n] = max(share[n], inflight[n]) — what node n is currently HOLDING: the
 * larger of its granted share and its non-revocable in-flight. The cap reserves
 * this for every peer (D-DAC-18), not just `share`, so a (re)grant never hands
 * out capacity a peer is still occupying.
 */
const heldOf = (p: Params, s: State): Record<string, number> => {
  const h: Record<string, number> = {};
  for (const n of p.nodes) h[n] = Math.max(s.share[n] ?? 0, s.inflight[n] ?? 0);
  return h;
};

/** Canonical state key for the visited set: active membership + share + inflight. */
const keyOf = (p: Params, s: State): string => {
  const act = p.nodes.map((n) => (s.active.has(n) ? "1" : "0")).join("");
  const sh = p.nodes.map((n) => s.share[n] ?? 0).join(",");
  const inf = p.nodes.map((n) => s.inflight[n] ?? 0).join(",");
  return `active=${act}|share=${sh}|inflight=${inf}`;
};

/**
 * All successor edges of `s` under
 * Next = ∃ n: Reallocate(n) ∨ Join(n) ∨ Leave(n) ∨ Acquire(n) ∨ Release(n).
 * Each edge is tagged with the action so the caller can witness that Join is
 * actually reachable/exercised.
 */
function successors(p: Params, s: State, allocation: Allocation = "equal-split"): Edge[] {
  const out: Edge[] = [];

  for (const n of p.nodes) {
    const inActive = s.active.has(n);
    const inf = s.inflight[n] ?? 0;
    const sh = s.share[n] ?? 0;

    // Reallocate(n): heartbeat (re)grant, CAPPED at L - Sum over others of
    // max(share, inflight) — reserve what each peer is HOLDING, not just its
    // share (D-DAC-18), so a joiner never ramps into capacity a peer still
    // occupies. The max(0, ...) clamp is required now: unlike the share-only
    // sum (<= L by GlobalCap), the Held-sum over peers can exceed L, so
    // `L - others` may be negative.
    if (inActive) {
      const others = sumOver(
        heldOf(p, s),
        [...s.active].filter((m) => m !== n),
      );
      const granted = Math.max(0, min2(targetOf(p, s, n, allocation), p.l - others));
      out.push({
        action: "Reallocate",
        state: { active: s.active, share: { ...s.share, [n]: granted }, inflight: s.inflight },
      });
    }

    // Join(n): a new node enters holding NO budget (share 0); inflight unchanged.
    if (!inActive) {
      const active = new Set(s.active);
      active.add(n);
      out.push({
        action: "Join",
        state: { active, share: { ...s.share, [n]: 0 }, inflight: s.inflight },
      });
    }

    // Leave(n): a node departs (active must stay nonempty); share + inflight reclaimed.
    if (inActive && s.active.size > 1) {
      const active = new Set(s.active);
      active.delete(n);
      out.push({
        action: "Leave",
        state: { active, share: { ...s.share, [n]: 0 }, inflight: { ...s.inflight, [n]: 0 } },
      });
    }

    // Acquire(n): admit one request — only while below the node's granted share.
    if (inActive && inf < sh) {
      out.push({
        action: "Acquire",
        state: { active: s.active, share: s.share, inflight: { ...s.inflight, [n]: inf + 1 } },
      });
    }

    // Release(n): a request on node n completes (event-release).
    if (inf > 0) {
      out.push({
        action: "Release",
        state: { active: s.active, share: s.share, inflight: { ...s.inflight, [n]: inf - 1 } },
      });
    }
  }

  return out;
}

/** Every nonempty subset of `nodes` — the `Init` choice of starting fleet. */
function nonemptySubsets(nodes: readonly string[]): Set<string>[] {
  const out: Set<string>[] = [];
  const total = 1 << nodes.length;
  for (let mask = 1; mask < total; mask++) {
    const s = new Set<string>();
    nodes.forEach((n, i) => {
      if (mask & (1 << i)) s.add(n);
    });
    out.push(s);
  }
  return out;
}

interface ExploreResult {
  /** Total distinct reachable states (matches TLC's "distinct states found"). */
  distinct: number;
  /** Largest `Sum(share over active)` observed (witness of GlobalCap tightness). */
  maxSumShare: number;
  /** Largest `Sum(inflight over active)` observed (witness of InflightCap tightness). */
  maxSumInflight: number;
  /** Whether at least one transition was a Join (membership-growth coverage). */
  joinExercised: boolean;
}

/**
 * Exhaustive BFS over the reachable state space. Asserts the committed TLA⁺
 * safety invariants (`TypeOK`, `GlobalCap`) on every reachable state — throws on
 * a violation with the offending state in the message, so a test sees which
 * state broke. `Init` enumerates every nonempty starting fleet with all shares
 * and in-flight zero (the cold start).
 */
function explore(p: Params, allocation: Allocation = "equal-split"): ExploreResult {
  const zero: Record<string, number> = {};
  for (const n of p.nodes) zero[n] = 0;

  const inits: State[] = nonemptySubsets(p.nodes).map((active) => ({
    active,
    share: { ...zero },
    inflight: { ...zero },
  }));

  const visited = new Set<string>();
  const queue: State[] = [];
  let head = 0;
  for (const init of inits) {
    const k = keyOf(p, init);
    if (!visited.has(k)) {
      visited.add(k);
      queue.push(init);
    }
  }

  let maxSumShare = 0;
  let maxSumInflight = 0;
  let joinExercised = false;

  while (head < queue.length) {
    const s = queue[head++] as State;

    // TypeOK — active nonempty subset of Nodes; share/inflight in 0..L per node.
    if (s.active.size === 0) {
      throw new Error(`TypeOK violated at ${keyOf(p, s)}: active is empty`);
    }
    for (const n of p.nodes) {
      const sh = s.share[n] ?? 0;
      const inf = s.inflight[n] ?? 0;
      if (sh < 0 || sh > p.l) {
        throw new Error(`TypeOK violated at ${keyOf(p, s)}: share[${n}]=${sh} ∉ 0..${p.l}`);
      }
      if (inf < 0 || inf > p.l) {
        throw new Error(`TypeOK violated at ${keyOf(p, s)}: inflight[${n}]=${inf} ∉ 0..${p.l}`);
      }
    }

    // GlobalCap — the coordinator never COMMITS more than the global budget.
    // Asserted on `share` over `active` (NOT on inflight: in-flight is
    // non-revocable and may transiently exceed L during a rebalance, DESIGN §9.3).
    const sumShare = sumOver(s.share, s.active);
    if (sumShare > p.l) {
      throw new Error(
        `GlobalCap violated at ${keyOf(p, s)}: Sum(share over active)=${sumShare} > L=${p.l}`,
      );
    }
    if (sumShare > maxSumShare) maxSumShare = sumShare;

    // InflightCap — in-flight never exceeds the global budget either, a HARD
    // invariant OF THIS SYNCHRONOUS model (D-DAC-18): the occupancy term of the cap
    // (max(share, inflight)) reserves a peer's non-revocable in-flight, so a joiner
    // never ramps into occupied capacity. The share-only cap left this as a
    // transient overshoot (≤1.5× on a 1→2 scale-up); this assertion would FAIL under
    // that cap. (The async implementation does NOT inherit it as a hard instantaneous
    // bound — grant/report lag leaves a bounded residual the model abstracts away;
    // see the header NOTE + the property suite's async-residual regression test.)
    const sumInflight = sumOver(s.inflight, s.active);
    if (sumInflight > p.l) {
      throw new Error(
        `InflightCap violated at ${keyOf(p, s)}: Sum(inflight over active)=${sumInflight} > L=${p.l}`,
      );
    }
    if (sumInflight > maxSumInflight) maxSumInflight = sumInflight;

    for (const { action, state: next } of successors(p, s, allocation)) {
      if (action === "Join") joinExercised = true;
      const k = keyOf(p, next);
      if (!visited.has(k)) {
        visited.add(k);
        queue.push(next);
      }
    }
  }

  return { distinct: visited.size, maxSumShare, maxSumInflight, joinExercised };
}

describe("GALE distributed (heartbeat) leasing — exhaustive BFS twin (TK-1316)", () => {
  const params: Params = { nodes: ["n1", "n2"], l: 4 };

  it("TypeOK + GlobalCap + InflightCap hold on every reachable state — Nodes={n1,n2}, L=4", () => {
    // explore() throws if any reachable state violates TypeOK, GlobalCap, or
    // InflightCap. InflightCap (Σ inflight ≤ L) holding is the whole point of the
    // occupancy cap (D-DAC-18): under the old share-only cap a joiner could ramp
    // while an incumbent drained, so Σ inflight reached 6 (1.5×L) on a reachable
    // state — this assertion would have thrown.
    const { distinct } = explore(params);
    // Pinned literal: run the BFS once, read the count, hard-code it. Guards the
    // staggered occupancy-capped transition system against regressions. TLC
    // parity is pending a Java env; until then this twin is the local source of
    // truth for the count. (Was 64 under the share-only cap; the occupancy cap +
    // max(0,…) clamp make the draining transients additional distinct states.)
    expect(distinct).toBe(76);
  });

  it("GlobalCapTight is FALSE in at least one reachable state (L is the LEAST upper bound)", () => {
    // The dual of the intentionally-FALSE TLA⁺ `GlobalCapTight` invariant
    // (Sum(share over active) <= L - 1): there exists a reachable state with
    // Sum(share) = L, so `Sum(share) <= L - 1` fails — the staggered distributed
    // allocation loses no steady-state capacity. The witness is both nodes
    // active and each reallocated to its Target share (2 + 2 = L = 4).
    const { maxSumShare } = explore(params);
    expect(maxSumShare).toBe(params.l);
    expect(maxSumShare).toBeGreaterThan(params.l - 1);
  });

  it("InflightCapTight is FALSE in at least one reachable state (L is the LEAST in-flight upper bound)", () => {
    // The dual of the intentionally-FALSE TLA⁺ `InflightCapTight` invariant
    // (Sum(inflight over active) <= L - 1): there exists a reachable state with
    // Sum(inflight) = L, so the occupancy cap loses NO steady-state in-flight
    // capacity — it converts the rebalance overshoot into a ramp delay without
    // capping throughput below the budget. The witness is both nodes active, each
    // reallocated to its Target (2 + 2 = L), then each filling its share
    // (inflight 2 + 2 = L = 4).
    const { maxSumInflight } = explore(params);
    expect(maxSumInflight).toBe(params.l);
    expect(maxSumInflight).toBeGreaterThan(params.l - 1);
  });

  it("Join is reachable/exercised — membership growth is observably covered", () => {
    // At least one BFS transition is a Join(n): a single-node init fleet grows to
    // a two-node fleet, so the staggered double-counting scenario the cap guards
    // against is actually visited (not vacuously safe).
    const { joinExercised } = explore(params);
    expect(joinExercised).toBe(true);
  });

  // Generalization (adversarial): the committed config is small (n1,n2 / L=4).
  // A skeptic asks whether InflightCap holds because the OCCUPANCY CAP works or
  // merely because the config is tiny. So exhaustively re-check larger fleets and
  // budgets — explore() throws on ANY TypeOK/GlobalCap/InflightCap violation, so
  // a clean run is a full counterexample search over each whole state space. Each
  // also witnesses tightness (Σ inflight reaches L), proving no capacity is lost.
  it.each([
    { nodes: ["n1", "n2"], l: 6 },
    { nodes: ["n1", "n2", "n3"], l: 4 },
    { nodes: ["n1", "n2", "n3"], l: 6 },
  ])("InflightCap + GlobalCap hold exhaustively for Nodes=$nodes, L=$l", (cfg) => {
    const { maxSumInflight, maxSumShare, joinExercised } = explore({
      nodes: cfg.nodes,
      l: cfg.l,
    });
    // No throw ⇒ both caps held on every reachable state. Both bounds are tight
    // (reach L), and membership growth is exercised — so the invariant is a
    // property of the cap, not an artifact of the pinned 2-node/L=4 config.
    expect(maxSumInflight).toBe(cfg.l);
    expect(maxSumShare).toBe(cfg.l);
    expect(joinExercised).toBe(true);
  });
});

describe("GALE distributed leasing — demand-proportional TARGET is exhaustively safe (TK-1403)", () => {
  // The §6/§9.4 claim is that BOTH safety bounds depend ONLY on the cap, never on the
  // target. TK-1403 swaps the equal-split target for demand-proportional; this re-runs the
  // SAME exhaustive BFS with that target and asserts TypeOK/GlobalCap/InflightCap hold on
  // every reachable state — a full counterexample search proving the new allocation can't
  // over-commit or over-occupy. explore() throws on any violation, so a clean run is the proof.
  it("TypeOK + GlobalCap + InflightCap hold on every reachable state — Nodes={n1,n2}, L=4", () => {
    const { distinct, maxSumShare, maxSumInflight, joinExercised } = explore(
      { nodes: ["n1", "n2"], l: 4 },
      "demand-proportional",
    );
    // No throw ⇒ both caps held under the demand-proportional target. Both bounds remain
    // TIGHT (reach L — no steady-state capacity lost: balanced load makes both nodes hungry
    // and they split L), and membership growth is exercised.
    expect(maxSumShare).toBe(4);
    expect(maxSumInflight).toBe(4);
    expect(joinExercised).toBe(true);
    // Pinned distinct-state count for the demand-proportional transition system (guards it
    // against regressions, like the equal-split 76 above). Larger than equal-split's 76
    // because the target — and thus the set of reachable share vectors — is richer.
    expect(distinct).toBe(112);
  });

  it.each([
    { nodes: ["n1", "n2"], l: 6 },
    { nodes: ["n1", "n2", "n3"], l: 4 },
    { nodes: ["n1", "n2", "n3"], l: 6 },
    { nodes: ["n1", "n2", "n3"], l: 2 }, // L < N: probe floors can't all be honored, caps still hold
  ])("demand-proportional: caps hold exhaustively for Nodes=$nodes, L=$l", (cfg) => {
    const { maxSumShare, maxSumInflight, joinExercised } = explore(
      { nodes: cfg.nodes, l: cfg.l },
      "demand-proportional",
    );
    // No throw ⇒ GlobalCap + InflightCap held on every reachable state under demand-
    // proportional, across larger fleets/budgets — the bound is the cap's, not the target's.
    expect(maxSumShare).toBe(cfg.l);
    expect(maxSumInflight).toBe(cfg.l);
    expect(joinExercised).toBe(true);
  });
});
