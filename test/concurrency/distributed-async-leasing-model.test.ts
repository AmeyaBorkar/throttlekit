import { describe, expect, it } from "vitest";

/**
 * TK-1330 — JS BFS twin of the ASYNC acknowledged-handoff model (the gate for a
 * HARD instantaneous `Σ inflight ≤ L_global` bound). Sibling of the SYNCHRONOUS
 * twin `distributed-leasing-model.test.ts` (TK-1316), which proves the 0.10.0
 * occupancy cap (D-DAC-18) only in a synchronous model where the coordinator's
 * COMMITTED share and the guard's APPLIED share are the same variable.
 *
 * This twin models the async gap that 0.10.0 abstracts away, exhaustively, and
 * answers: what reserve rule makes `Σ inflight ≤ L` HARD in the async system?
 *
 *   committed vs applied — the coordinator COMMITS a share; the guard APPLIES the
 *     grant only when its reply LANDS (latency). `hist[n]` = the grant values the
 *     coordinator has issued to n, in issue (= sequence) order. `appliedIdx[n]` =
 *     the grant the guard currently enforces.
 *   MONOTONIC GUARD (the shipped issue-seq guard in distributed.ts): the guard
 *     only ever moves to a HIGHER-seq grant; an older grant that lands later is
 *     dropped. Modeled by `appliedIdx` only ever increasing. OUT-OF-ORDER delivery
 *     = `Deliver` may move appliedIdx to ANY higher index (a late OLD high grant
 *     lands at a low-but-still-ahead index).
 *   REPORTING LAG — the coordinator's view of a peer (`ackIdx`, `repInflight`)
 *     lags the guard; it advances only on a `Report` (a heartbeat).
 *   NON-REVOCABLE in-flight — a held slot drains only via `Release`; after a share
 *     is LOWERED, inflight can exceed the applied share during drain.
 *
 * THE RESULT (machine-checked below). Two reserve rules each drop ONE necessary
 * term and are REFUTED; their union is a HARD bound:
 *
 *   committed-snapshot   reserve_j = max(committed_j, reported_applied_j,
 *     (HARD-ASYNC §2)                   reported_inflight_j)
 *     → REFUTED. A grant the coordinator ISSUED but the peer has not yet applied
 *       or reported is invisible (committed is already the lowered value, the
 *       reports are stale-low); it lands late and fills past L. This is the
 *       1.5× residual 0.10.0 documents — the scoping doc's §2 proposal, refuted
 *       exactly as its §4 ("do not ship on the hand-argument") suspected.
 *
 *   grant-suffix-only    reserve_j = maxUnackedGrant_j
 *     → REFUTED. In-flight is non-revocable: after a node lowers AND acks its
 *       share (so the coordinator prunes the high grant from the un-acked suffix),
 *       the node still drains occupancy above the new share. Uncovered.
 *
 *   acknowledged-handoff reserve_j = max(maxUnackedGrant_j, reported_inflight_j)
 *     (THE VALIDATED RULE)  where maxUnackedGrant_j = max grant VALUE over grants
 *       issued to j at seq ≥ j's acknowledged-applied seq (hist[ackIdx..end]).
 *     → HARD (Σ inflight ≤ L on every reachable state) AND TIGHT (reaches L — no
 *       capacity lost) for every config + K below. The two terms are MINIMAL
 *       (each rule above drops one and fails) and the union is SUFFICIENT.
 *
 * WHY maxUnackedGrant beats committed/reported_applied (the crux): it reserves on
 * what the coordinator ITSELF ISSUED — lag-free knowledge — not on what the peer
 * REPORTED (laggy). A peer may acquire under a grant and not yet have reported it;
 * the coordinator still knows it issued that grant and that the peer has not acked
 * moving past it, so it reserves it. This closes the reporting-lag hole at its
 * root. (It cannot collapse to `max(committed, reported_applied)`: an intermediate
 * grant SPIKE — issue 4, then 6, then 3, peer acks the 4 — has un-acked-suffix max
 * 6 that neither committed=3 nor reported_applied=4 sees.)
 *
 * REQUIRED CONSTRAINTS surfaced by adversarial verification (3 skeptics) — encoded
 * as the `tornReport` NEGATIVE test below and enforced by the implementation:
 *   1. ATOMIC report snapshot. Each report carries (appliedSeq, inflight) sampled
 *      at the SAME instant; the coordinator advances its ack-floor and updates
 *      reported_inflight TRANSACTIONALLY from that one report. A TORN report
 *      (fresh seq + stale inflight) REOPENS the hole — see the `tornReport` test.
 *   2. maxUnackedGrant, not a committed scalar (the spike argument above).
 *   3. A missing/old field (mixed-version fleet) must default to the SAFE
 *      (over-reserve) direction, never 0. (Implementation concern; not modeled.)
 *
 * SCOPE / fidelity. K bounds the outstanding (un-trimmed) grant history per node;
 * K∈{2,3} agree on every verdict (the hazard saturates at 2 outstanding grants),
 * so the bounded model is not hiding a deeper counterexample. The exact
 * suffix-max reserve is modeled here; the implementation (TK-1330c) uses a
 * bounded over-approximation (≥ exact ⇒ still safe), checked by conformance tests.
 * TLC parity pending a Java env (see TK-1330b); this twin is the local oracle.
 */

type Rule = "committed-snapshot" | "grant-suffix-only" | "acknowledged-handoff";

interface NodeState {
  readonly act: boolean;
  /** grant values in issue (sequence) order; index 0 = oldest still-relevant. */
  readonly hist: readonly number[];
  /** guard's enforced grant index; -1 = applied 0. Monotone up (monotonic guard). */
  readonly appliedIdx: number;
  /** in-flight at the guard; non-revocable (drains only via Release). */
  readonly inflight: number;
  /** coordinator's CONFIRMED applied index for this peer (≤ appliedIdx; lags). */
  readonly ackIdx: number;
  /** coordinator's last-reported in-flight for this peer (lags). */
  readonly repInflight: number;
}

type State = Readonly<Record<string, NodeState>>;

interface Params {
  readonly nodes: readonly string[];
  readonly l: number;
  readonly k: number;
  readonly rule: Rule;
  /** when true, split Report into independent seq/inflight updates (Skeptic 1). */
  readonly tornReport: boolean;
}

const min2 = (a: number, b: number): number => (a < b ? a : b);
const ceil = (a: number, b: number): number => Math.floor((a + b - 1) / b);
const appliedVal = (n: NodeState): number => (n.appliedIdx < 0 ? 0 : (n.hist[n.appliedIdx] ?? 0));
const activeNodes = (p: Params, s: State): string[] => p.nodes.filter((n) => s[n]?.act);
const targetFor = (p: Params, s: State): number => ceil(p.l, Math.max(1, activeNodes(p, s).length));

/** What the coordinator reserves for peer n under the chosen rule. */
function reserveOf(rule: Rule, n: NodeState): number {
  const committed = n.hist.length === 0 ? 0 : (n.hist[n.hist.length - 1] ?? 0);
  const repApplied = n.ackIdx < 0 ? 0 : (n.hist[n.ackIdx] ?? 0);
  let suffixMax = 0; // max un-acked grant = max over hist[ackIdx .. end]
  for (let i = Math.max(0, n.ackIdx); i < n.hist.length; i++)
    suffixMax = Math.max(suffixMax, n.hist[i] ?? 0);
  switch (rule) {
    case "committed-snapshot":
      return Math.max(committed, repApplied, n.repInflight);
    case "grant-suffix-only":
      return suffixMax;
    case "acknowledged-handoff":
      return Math.max(suffixMax, n.repInflight);
  }
}

/** Drop the dead common prefix of a node's hist; shift its pointers. Sound: an
 * index below BOTH the guard's appliedIdx and the coordinator's ackIdx can never
 * be applied (monotone) nor reserved (suffix starts at ackIdx). */
function normalizeNode(n: NodeState): NodeState {
  if (n.hist.length === 0) return n;
  const need = Math.min(n.appliedIdx < 0 ? 0 : n.appliedIdx, n.ackIdx < 0 ? 0 : n.ackIdx);
  if (need <= 0) return n;
  return {
    ...n,
    hist: n.hist.slice(need),
    appliedIdx: n.appliedIdx - need,
    ackIdx: n.ackIdx - need,
  };
}

const keyOf = (p: Params, s: State): string =>
  p.nodes
    .map((id) => {
      const n = s[id] as NodeState;
      return `${id}:${n.act ? 1 : 0}[${n.hist.join(",")}]a${n.appliedIdx}i${n.inflight}k${n.ackIdx}r${n.repInflight}`;
    })
    .join("|");

const sumInflight = (p: Params, s: State): number =>
  activeNodes(p, s).reduce((acc, id) => acc + (s[id]?.inflight ?? 0), 0);
const sumCommitted = (p: Params, s: State): number =>
  activeNodes(p, s).reduce((acc, id) => {
    const h = s[id]?.hist ?? [];
    return acc + (h.length === 0 ? 0 : (h[h.length - 1] ?? 0));
  }, 0);

function setNode(s: State, id: string, patch: Partial<NodeState>): State {
  return { ...s, [id]: normalizeNode({ ...(s[id] as NodeState), ...patch }) };
}

const COLD: NodeState = {
  act: false,
  hist: [],
  appliedIdx: -1,
  inflight: 0,
  ackIdx: -1,
  repInflight: 0,
};

function successors(p: Params, s: State): Array<{ action: string; state: State }> {
  const out: Array<{ action: string; state: State }> = [];
  const active = activeNodes(p, s);
  for (const id of p.nodes) {
    const n = s[id] as NodeState;

    // Reallocate(id): coordinator (re)grants, capped at L − Σ_others reserve.
    if (n.act && n.hist.length < p.k) {
      let others = 0;
      for (const j of active) if (j !== id) others += reserveOf(p.rule, s[j] as NodeState);
      const g = Math.max(0, min2(targetFor(p, s), p.l - others));
      out.push({
        action: `Reallocate(${id})=${g}`,
        state: setNode(s, id, { hist: [...n.hist, g] }),
      });
    }

    // Deliver(id, i): a grant lands at the guard (monotone; out-of-order ⇒ any i).
    if (n.act) {
      for (let i = n.appliedIdx + 1; i < n.hist.length; i++) {
        out.push({ action: `Deliver(${id})->idx${i}`, state: setNode(s, id, { appliedIdx: i }) });
      }
    }

    // Report(id): coordinator's view catches up. ATOMIC by default (one heartbeat
    // snapshots seq+inflight together); TORN splits them (the negative test).
    if (p.tornReport) {
      if (n.act && n.ackIdx !== n.appliedIdx)
        out.push({ action: `ReportSeq(${id})`, state: setNode(s, id, { ackIdx: n.appliedIdx }) });
      if (n.act && n.repInflight !== n.inflight)
        out.push({
          action: `ReportInf(${id})`,
          state: setNode(s, id, { repInflight: n.inflight }),
        });
    } else if (n.act && (n.ackIdx !== n.appliedIdx || n.repInflight !== n.inflight)) {
      out.push({
        action: `Report(${id})`,
        state: setNode(s, id, { ackIdx: n.appliedIdx, repInflight: n.inflight }),
      });
    }

    // Acquire(id): admit one — only while below the guard's applied share.
    if (n.act && n.inflight < appliedVal(n))
      out.push({ action: `Acquire(${id})`, state: setNode(s, id, { inflight: n.inflight + 1 }) });

    // Release(id): a request completes (drains non-revocable in-flight).
    if (n.inflight > 0)
      out.push({ action: `Release(${id})`, state: setNode(s, id, { inflight: n.inflight - 1 }) });

    // Join(id): enters holding no budget (committed 0 until it reallocates).
    if (!n.act) out.push({ action: `Join(${id})`, state: setNode(s, id, { ...COLD, act: true }) });

    // Leave(id): departs; budget + in-flight reclaimed (fleet stays nonempty).
    if (n.act && active.length > 1)
      out.push({ action: `Leave(${id})`, state: setNode(s, id, { ...COLD }) });
  }
  return out;
}

interface ExploreResult {
  distinct: number;
  maxSumInflight: number;
  maxSumCommitted: number;
  /** first reachable state with Σ inflight > L (a refutation), with its trace. */
  violation: { key: string; sum: number; trace: string[] } | null;
}

/** Exhaustive BFS over the reachable async state space. `earlyExit` stops at the
 * first Σ inflight > L (a refutation needs only one witness). */
function explore(p: Params, earlyExit = false): ExploreResult {
  const inits: State[] = [];
  const total = 1 << p.nodes.length;
  for (let mask = 1; mask < total; mask++) {
    const s: Record<string, NodeState> = {};
    p.nodes.forEach((id, i) => {
      s[id] = mask & (1 << i) ? { ...COLD, act: true } : { ...COLD };
    });
    inits.push(s);
  }
  const visited = new Set<string>();
  const parent = new Map<string, { pk: string | null; action: string }>();
  const queue: State[] = [];
  for (const init of inits) {
    const k = keyOf(p, init);
    if (!visited.has(k)) {
      visited.add(k);
      parent.set(k, { pk: null, action: "init" });
      queue.push(init);
    }
  }
  let head = 0;
  let maxSumInflight = 0;
  let maxSumCommitted = 0;
  let violationKey: string | null = null;
  while (head < queue.length) {
    const s = queue[head++] as State;
    const si = sumInflight(p, s);
    const sc = sumCommitted(p, s);
    if (si > maxSumInflight) maxSumInflight = si;
    if (sc > maxSumCommitted) maxSumCommitted = sc;
    if (si > p.l && !violationKey) {
      violationKey = keyOf(p, s);
      if (earlyExit) break;
    }
    for (const { action, state: next } of successors(p, s)) {
      const k = keyOf(p, next);
      if (!visited.has(k)) {
        visited.add(k);
        parent.set(k, { pk: keyOf(p, s), action });
        queue.push(next);
      }
    }
  }
  let violation: ExploreResult["violation"] = null;
  if (violationKey) {
    const trace: string[] = [];
    let cur: string | null = violationKey;
    while (cur) {
      const e = parent.get(cur);
      if (!e) break;
      if (e.action !== "init") trace.unshift(e.action);
      cur = e.pk;
    }
    violation = { key: violationKey, sum: maxSumInflight, trace };
  }
  return { distinct: visited.size, maxSumInflight, maxSumCommitted, violation };
}

describe("GALE async acknowledged-handoff — exhaustive BFS twin (TK-1330)", () => {
  // ── MINIMALITY: each rule drops one necessary term and is REFUTED ──────────
  // Each finds a REACHABLE state with Σ inflight > L. early-exit (one witness).

  it("committed-snapshot rule is REFUTED — a late-landing un-acked grant overshoots (the 0.10.0 1.5× residual)", () => {
    for (const cfg of [
      { nodes: ["A", "B"], l: 4, k: 3 },
      { nodes: ["A", "B"], l: 6, k: 3 },
    ]) {
      // early-exit ⇒ the FIRST (shallowest) violating state, Σ = L+1; the refutation
      // is the existence of any reachable Σ inflight > L. (Peak magnitude pinned below.)
      const r = explore({ ...cfg, rule: "committed-snapshot", tornReport: false }, true);
      expect(r.violation).not.toBeNull();
      expect(r.maxSumInflight).toBeGreaterThan(cfg.l);
    }
  });

  it("grant-suffix-only rule is REFUTED — non-revocable in-flight drains below a lowered+acked share", () => {
    for (const cfg of [
      { nodes: ["A", "B"], l: 4, k: 3 },
      { nodes: ["A", "B"], l: 6, k: 3 },
    ]) {
      const r = explore({ ...cfg, rule: "grant-suffix-only", tornReport: false }, true);
      expect(r.violation).not.toBeNull();
      expect(r.maxSumInflight).toBeGreaterThan(cfg.l);
    }
  });

  it("the committed-snapshot residual peaks at exactly 1.5×L (Nodes={A,B} L=4, exhaustive)", () => {
    // Exhaustive (no early-exit) ⇒ the true PEAK overshoot. A fills its old share 4
    // while B fills the 2 the coordinator wrongly freed → Σ inflight = 6 = 1.5·L,
    // the documented 0.10.0 residual magnitude on a 1→2 scale-up.
    const r = explore({
      nodes: ["A", "B"],
      l: 4,
      k: 2,
      rule: "committed-snapshot",
      tornReport: false,
    });
    expect(r.maxSumInflight).toBe(6);
  });

  // ── SUFFICIENCY: the union rule is HARD (Σ inflight ≤ L) and TIGHT ──────────

  it("acknowledged-handoff is a HARD bound (Σ inflight ≤ L) + TIGHT — pinned, Nodes={A,B} L=4 K=2", () => {
    const r = explore({
      nodes: ["A", "B"],
      l: 4,
      k: 2,
      rule: "acknowledged-handoff",
      tornReport: false,
    });
    expect(r.violation).toBeNull(); // no reachable state over-occupies
    expect(r.maxSumInflight).toBe(4); // TIGHT: reaches L ⇒ no steady-state capacity lost
    expect(r.maxSumCommitted).toBeLessThanOrEqual(4); // GlobalCap holds throughout
    // Pinned distinct-state count: guards the async transition system + reserve
    // rule against regressions (the role TK-1316's 76 plays for the sync twin).
    expect(r.distinct).toBe(12387);
  });

  it.each([
    { nodes: ["A", "B"], l: 4, k: 3 }, // K=3 vs K=2 agree ⇒ hazard saturates at 2 outstanding grants
    { nodes: ["A", "B"], l: 6, k: 2 },
  ])("acknowledged-handoff holds + tight exhaustively for Nodes=$nodes L=$l K=$k", (cfg) => {
    const r = explore({ ...cfg, rule: "acknowledged-handoff", tornReport: false });
    expect(r.violation).toBeNull();
    expect(r.maxSumInflight).toBe(cfg.l); // tight
    expect(r.maxSumCommitted).toBeLessThanOrEqual(cfg.l);
  });

  // ── REQUIRED CONSTRAINT (Skeptic 1): the report MUST be an atomic snapshot ──

  it("acknowledged-handoff REQUIRES an atomic (seq, inflight) report — a TORN report reopens the overshoot", () => {
    // Negative test / regression guard. If a heartbeat advances the acked seq
    // WITHOUT atomically updating reported in-flight (or vice versa), the
    // coordinator prunes maxUnackedGrant while reported_inflight is stale-low —
    // under-reserving a node still draining its old occupancy. This is the exact
    // refutation adversarial review found; it pins the implementation invariant
    // that the wire report + coordinator update must be transactional.
    const r = explore(
      { nodes: ["A", "B"], l: 4, k: 3, rule: "acknowledged-handoff", tornReport: true },
      true,
    );
    expect(r.violation).not.toBeNull();
    expect(r.maxSumInflight).toBeGreaterThan(4);
  });
});
