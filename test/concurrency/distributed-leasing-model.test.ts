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
 *                    budget not committed to OTHER active nodes —
 *                    share'[n] = min(Target, L - Sum(share over active\{n})),
 *                    Target = ceil(L / |active|). The cap is what keeps the
 *                    committed sum <= L for ANY interleaving (D-DAC-17).
 *   - Join(n):       a new node enters holding share 0 until it reallocates, so
 *                    an incumbent's outstanding share is never double-counted.
 *   - Leave(n):      a node departs (|active| stays >= 1); its share leaves the
 *                    live sum (budget reclaimed) and its in-flight is gone.
 *   - Acquire(n):    admit one request — only while inflight[n] < share[n].
 *   - Release(n):    a request on node n completes (event-release).
 *
 * GlobalCap == Sum(share over active) <= L is the committed safety property:
 * the coordinator never COMMITS more than the global budget. Sum(inflight) <= L
 * is deliberately NOT an invariant (in-flight is non-revocable and drains
 * monotonically after a rebalance, DESIGN §9.3 / D-DAC-14), so this twin asserts
 * GlobalCap on `share`, not on `inflight`.
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

/** Target == Ceil(L, Cardinality(active)) — the per-node fair-share over-approx. */
const targetFor = (p: Params, active: ReadonlySet<string>): number => ceil(p.l, active.size);

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
function successors(p: Params, s: State): Edge[] {
  const out: Edge[] = [];

  for (const n of p.nodes) {
    const inActive = s.active.has(n);
    const inf = s.inflight[n] ?? 0;
    const sh = s.share[n] ?? 0;

    // Reallocate(n): heartbeat (re)grant, CAPPED at L - Sum(share over others).
    if (inActive) {
      const others = sumOver(
        s.share,
        [...s.active].filter((m) => m !== n),
      );
      const granted = min2(targetFor(p, s.active), p.l - others);
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
function explore(p: Params): ExploreResult {
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

    for (const { action, state: next } of successors(p, s)) {
      if (action === "Join") joinExercised = true;
      const k = keyOf(p, next);
      if (!visited.has(k)) {
        visited.add(k);
        queue.push(next);
      }
    }
  }

  return { distinct: visited.size, maxSumShare, joinExercised };
}

describe("GALE distributed (heartbeat) leasing — exhaustive BFS twin (TK-1316)", () => {
  const params: Params = { nodes: ["n1", "n2"], l: 4 };

  it("TypeOK + GlobalCap hold on every reachable state — Nodes={n1,n2}, L=4", () => {
    // explore() throws if any reachable state violates TypeOK or GlobalCap.
    const { distinct } = explore(params);
    // Pinned literal: run the BFS once, read the count, hard-code it. Guards the
    // staggered budget-capped transition system against regressions. TLC parity
    // is pending a Java env; until then this twin is the local source of truth
    // for the count.
    expect(distinct).toBe(64);
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

  it("Join is reachable/exercised — membership growth is observably covered", () => {
    // At least one BFS transition is a Join(n): a single-node init fleet grows to
    // a two-node fleet, so the staggered double-counting scenario the cap guards
    // against is actually visited (not vacuously safe).
    const { joinExercised } = explore(params);
    expect(joinExercised).toBe(true);
  });
});
