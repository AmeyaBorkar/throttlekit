/**
 * TK-1316 — property-based safety proof for distributed adaptive concurrency.
 *
 * DESIGN §6 (the budget cap, D-DAC-17) + §11.3 (the property-test row) + §9.3
 * (shrink-drain). Fast-check generates random fleets (2-6 nodes), random
 * `acquire`/`release`/`heartbeat`/`land`/`depart` interleavings, then drives them
 * through a fully deterministic discrete-event simulation: a `ManualClock`, the
 * real `TestConcurrencyCoordinator`, and a per-node FAKE `HeartbeatScheduler` so
 * the driver fires heartbeats explicitly (no real timers). Crucially, heartbeat
 * grants land OUT OF ORDER: a thin latency-injecting wrapper around the
 * coordinator mutates fleet state synchronously at call time (the realistic
 * server-side processing) but defers + reorders the GRANT reply, so a node may
 * apply a stale (older-issued) share after a fresher one already landed.
 *
 * Two regimes, two strengths of claim — this is the crux of the finding-#1
 * regression guard:
 *
 *   (A) CONSTANT `lGlobal` (every node pinned to the SAME `lLocal`, so
 *       `aggregate(min|median)` is that constant for ANY live subset). Here we
 *       assert the HARD coordinator invariant `GlobalCap`:
 *
 *           Σ_{live} coordinator-committed share  ≤  lGlobal   at EVERY step,
 *
 *       read from the coordinator itself via `peek(KEY)` ({lGlobal, shares}) —
 *       NOT from a stateless re-split, and NOT from the guards' view. This is the
 *       exact property the bug violated: a stateless `⌊L/N⌋` split makes
 *       `Σ share` exceed `lGlobal` the instant a node joins (the incumbent still
 *       holds its larger pre-join share); the cap (`share = min(target,
 *       lGlobal − Σ others)`) keeps `Σ share ≤ lGlobal` under EVERY interleaving.
 *
 *   (B) VARYING `lGlobal` (per-node `lLocal` spans a range, so median/min over a
 *       shifting live set makes `lGlobal` genuinely move/shrink). `GlobalCap` is
 *       still true here, but `lGlobal` motion mixes the cap with shrink-drain, so
 *       this regime instead guards the WEAKER operational claim of §9.3:
 *
 *         per-node gate: a node's `inflight > share` only via NON-INCREASING debt
 *         (a fresh admit can never create it — the gate forbids it; only a `share`
 *         that drops UNDER existing in-flight, via a shrink or a peer-join cap,
 *         creates it, and it must then drain monotonically).
 *
 *       We do NOT assert `Σ inflight ≤ lGlobal` as a hard invariant: in-flight is
 *       non-revocable, so it transiently exceeds a freshly-shrunk budget and only
 *       drains monotonically (DESIGN §9.3 / D-DAC-14 — liveness, not safety).
 *
 *       FINDING #3 — this regime used to be VACUOUS. Random timelines generated
 *       by `varyingScenarioArb` (every guard instantiated and heartbeating from
 *       step 0, local-only cold start) NEVER enter debt at the committed config:
 *       the per-node `inflight > share` branch fired 0 times across all seeds. So
 *       the regime asserted a property whose precondition never held. The fix is
 *       two-fold: (i) `shrinkBiasedScenarioArb` PREFIXES every timeline with a
 *       deterministic shrink transient (`debtPrefix`: n0 fills a solo share, a
 *       lower-`lLocal` n1 joins so `lGlobal` drops, n0 re-heartbeats and is capped
 *       below its in-flight ⇒ debt) so the branch is reached; (ii) a coverage
 *       counter inside the `if` body, asserted `> 0` in an `afterAll`, FAILS the
 *       suite if a future regression silently stops reaching debt. The earlier
 *       SECOND, GLOBAL branch (`Σ inflight > Σ guard.share`) was DELETED as dead
 *       code: it is unreachable in this local-only cold-start harness (a single
 *       node's debt is always absorbed by the slack of the co-shrunk peers in the
 *       SUM, so the fleet total never exceeds the fleet share-sum), and it would
 *       have been a vacuous assertion. The deterministic third describe below
 *       independently CONSTRUCTS and asserts the same per-node transient end to
 *       end (solo ramp → peer join → cap → monotone drain).
 *
 * Mirrors the federation property test (`test/federation/property.test.ts`,
 * TK-908) in structure — generated adversarial timelines, deterministic seeds,
 * automatic shrinking to a minimal counterexample — but is always-on (no Redis):
 * the out-of-order coordinator landing replaces the dual-path Lua comparison.
 */

import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";

import type { Lease } from "../../src/concurrency/adaptive";
import { ManualClock } from "../../src/core/clock";
import {
  type ConcurrencyCoordinator,
  type ConcurrencyGrant,
  type ConcurrencyReport,
  type DistributedConcurrencyGuard,
  type HeartbeatScheduler,
  TestConcurrencyCoordinator,
  distributedAdaptiveConcurrency,
} from "../../src/index";

const NUM_RUNS = 150;
const KEY = "shared-backend";

/** Deterministic seeds: every `fc.assert` run below is reproducible to the seed. */
const SEEDS = [1, 7, 13, 42, 99, 1729];

/**
 * A fake {@link HeartbeatScheduler} that NEVER fires on its own — it just
 * captures the heartbeat callback so the simulation driver can invoke it
 * explicitly. This removes all wall-clock timing from the property test; every
 * heartbeat is a deliberate, ordered driver step.
 */
function captureScheduler(): { scheduler: HeartbeatScheduler; fire: () => void } {
  let captured: (() => void) | undefined;
  let cancelled = false;
  const scheduler: HeartbeatScheduler = {
    schedule(fn: () => void): { cancel(): void } {
      captured = fn;
      return {
        cancel(): void {
          cancelled = true;
        },
      };
    },
  };
  return {
    scheduler,
    fire(): void {
      if (!cancelled && captured !== undefined) captured();
    },
  };
}

/**
 * A latency-injecting {@link ConcurrencyCoordinator} wrapper around the real
 * {@link TestConcurrencyCoordinator}. The fleet state mutation (upsert + evict +
 * re-aggregate) happens synchronously at `heartbeat()` call time — modelling the
 * coordinator's server-side processing — but the GRANT reply is held in a
 * pending queue and only delivered when the driver calls {@link landGrants},
 * which delivers pending replies in a driver-chosen (possibly reordered) order.
 *
 * The result: a node can apply a stale grant (computed from an older fleet
 * snapshot) AFTER a fresher grant already landed — the "heartbeats land out of
 * order" hazard §11.3 requires. `leave`/`isHealthy` pass straight through.
 */
function latencyCoordinator(inner: TestConcurrencyCoordinator): {
  coordinator: ConcurrencyCoordinator;
  /** Deliver currently-pending grant replies, in the given index order (out-of-order when shuffled). */
  landGrants(order: number[]): void;
  /**
   * Snapshot the coordinator-COMMITTED budget + per-node shares for `key`, read
   * straight from the inner coordinator (the server-side authority), NOT from any
   * guard. State mutation happens synchronously at `heartbeat()` call time, so
   * this reflects every issued heartbeat regardless of whether its grant reply
   * has landed — exactly the surface the `GlobalCap` safety invariant is about.
   */
  peek(key: string): { lGlobal: number; nodes: number; shares: Record<string, number> };
} {
  interface Pending {
    grant: ConcurrencyGrant;
    resolve: (g: ConcurrencyGrant) => void;
  }
  let pending: Pending[] = [];

  const coordinator: ConcurrencyCoordinator = {
    async heartbeat(report: ConcurrencyReport): Promise<ConcurrencyGrant> {
      // Server-side processing happens now (synchronously, in issue order): the
      // coordinator upserts + evicts + re-aggregates against the current clock.
      const grant = await inner.heartbeat(report);
      // The REPLY is deferred: park it until the driver chooses to deliver it.
      return new Promise<ConcurrencyGrant>((resolve) => {
        pending.push({ grant, resolve });
      });
    },
    leave(args: { key: string; nodeId: string }): Promise<void> {
      return inner.leave(args);
    },
    isHealthy(): Promise<boolean> {
      return inner.isHealthy();
    },
  };

  return {
    coordinator,
    landGrants(order: number[]): void {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      // Deliver in the driver-chosen order over the captured batch. `order` is a
      // permutation source; map it onto the batch indices so replies can arrive
      // in a different order than they were issued.
      const n = batch.length;
      const seen = new Set<number>();
      const idxs: number[] = [];
      for (const raw of order) {
        const i = ((raw % n) + n) % n;
        if (!seen.has(i)) {
          seen.add(i);
          idxs.push(i);
        }
      }
      // Append any not covered by `order`, preserving issue order for the tail.
      for (let i = 0; i < n; i++) if (!seen.has(i)) idxs.push(i);
      for (const i of idxs) {
        const p = batch[i];
        if (p !== undefined) p.resolve(p.grant);
      }
    },
    peek(key: string) {
      return inner.peek(key);
    },
  };
}

/** A flush of all pending microtasks — lets every landed grant's `share = ...` assignment apply. */
const drainMicrotasks = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/** One node in the simulated fleet. */
interface Node {
  id: string;
  guard: DistributedConcurrencyGuard;
  fire: () => void;
  /** Outstanding leases that can still be released (drains debt). */
  held: Array<{ release(): void }>;
  /** Once true, the driver stops firing this node's heartbeat (it will lease-expire = depart). */
  departed: boolean;
}

/** A single simulation operation drawn by fast-check. */
type Op =
  | { kind: "acquire"; node: number }
  | { kind: "release"; node: number }
  | { kind: "heartbeat"; node: number }
  | { kind: "land"; order: number[] }
  | { kind: "advance"; ms: number }
  | { kind: "depart"; node: number };

const opArb = (numNodes: number): fc.Arbitrary<Op> =>
  fc.oneof(
    {
      weight: 5,
      arbitrary: fc.record({
        kind: fc.constant("acquire" as const),
        node: fc.integer({ min: 0, max: numNodes - 1 }),
      }),
    },
    {
      weight: 3,
      arbitrary: fc.record({
        kind: fc.constant("release" as const),
        node: fc.integer({ min: 0, max: numNodes - 1 }),
      }),
    },
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant("heartbeat" as const),
        node: fc.integer({ min: 0, max: numNodes - 1 }),
      }),
    },
    {
      weight: 4,
      arbitrary: fc.record({
        kind: fc.constant("land" as const),
        order: fc.array(fc.integer({ min: 0, max: numNodes * 2 }), {
          minLength: 0,
          maxLength: numNodes * 2,
        }),
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant("advance" as const),
        ms: fc.integer({ min: 0, max: 4000 }),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        kind: fc.constant("depart" as const),
        node: fc.integer({ min: 0, max: numNodes - 1 }),
      }),
    },
  );

interface Scenario {
  numNodes: number;
  /** Pinned per-node `lLocal`. */
  limits: number[];
  aggregate: "min" | "median";
  ops: Op[];
  /** Outage mode for every guard in the fleet. Default `"local-only"`. */
  outage?: "fail-closed" | "local-only";
}

/**
 * A deterministic op PREFIX that provably drives node 0 into per-node debt
 * (`inflight > share`) — the §9.3 shrink-drain transient. It mirrors the
 * deterministic third-describe scenario, expressed as driver ops:
 *
 *   1. `heartbeat n0` + `land`  — n0 heartbeats SOLO, so `lGlobal = l0` (its own
 *      pinned `lLocal`, since it is the only live node) and its grant is the full
 *      solo budget; the grant lands so the guard caches a large `share`.
 *   2. `acquire n0` × `l0`      — n0 fills its whole solo share (in-flight = l0).
 *   3. `heartbeat n1` + `land`  — a SECOND node joins. Its pinned `lLocal = l1`
 *      is strictly BELOW n0's (see `shrinkBiasedScenarioArb`), so under BOTH
 *      `min` (= l1) and `median` (lower median of {l0,l1} = l1) the fleet
 *      `lGlobal` DROPS from l0 to l1.
 *   4. `heartbeat n0` + `land`  — n0 re-heartbeats in the now-2-node, lower-budget
 *      fleet: its equal-split target ≈ l1/2 and the cap give a share ≪ its
 *      in-flight of l0 ⇒ n0 is in debt (`inflight > share`). The per-node debt
 *      branch (regime B, assertion 1) FIRES here.
 *
 * The random `ops` tail then drains/perturbs that debt, exercising the
 * non-increasing-debt assertion as requests release. `acquire`/`heartbeat`/`land`
 * on a node index ≥ numNodes are no-ops in the driver, so the prefix is safe to
 * prepend to any fleet of ≥ 2 nodes.
 */
const debtPrefix = (l0: number): Op[] => [
  { kind: "heartbeat", node: 0 },
  { kind: "land", order: [] },
  ...Array.from({ length: l0 }, () => ({ kind: "acquire", node: 0 }) as Op),
  { kind: "heartbeat", node: 1 },
  { kind: "land", order: [] },
  { kind: "heartbeat", node: 0 },
  { kind: "land", order: [] },
];

/**
 * VARYING-`lGlobal` scenarios (regime B): per-node `lLocal` spans a range so
 * median/min over a shifting live set makes `lGlobal` genuinely move/shrink.
 */
const varyingScenarioArb: fc.Arbitrary<Scenario> = fc
  .integer({ min: 2, max: 6 })
  .chain((numNodes) =>
    fc.record({
      numNodes: fc.constant(numNodes),
      limits: fc.array(fc.integer({ min: 4, max: 24 }), {
        minLength: numNodes,
        maxLength: numNodes,
      }),
      aggregate: fc.constantFrom("min" as const, "median" as const),
      ops: fc.array(opArb(numNodes), { minLength: 1, maxLength: 80 }),
    }),
  );

/**
 * SHRINK-BIASED varying scenarios (regime B coverage, finding #3): like
 * `varyingScenarioArb`, but the limits are CONSTRUCTED so node 0's `lLocal` is
 * strictly the fleet maximum and node 1's is strictly the minimum, and every op
 * list is PREFIXED by {@link debtPrefix}. This guarantees the per-node debt
 * branch is reached — the random `varyingScenarioArb` never enters debt at the
 * committed config (the gate `min(share, local.limit)` forbids fresh admits from
 * creating it, and a cold-start fleet that heartbeats from step 0 never lands a
 * large solo share before a peer caps it). Running regime B over BOTH arbitraries
 * keeps all the random coverage AND makes the shrink transient observably fire.
 */
const shrinkBiasedScenarioArb: fc.Arbitrary<Scenario> = fc
  .integer({ min: 2, max: 6 })
  .chain((numNodes) =>
    fc
      .record({
        numNodes: fc.constant(numNodes),
        // n0 high, n1 low, the rest in between — so a solo n0 fills a big share
        // and the n1 join drops lGlobal (min AND lower-median) below it.
        l0: fc.integer({ min: 14, max: 24 }),
        l1: fc.integer({ min: 4, max: 8 }),
        mids: fc.array(fc.integer({ min: 4, max: 24 }), {
          minLength: Math.max(0, numNodes - 2),
          maxLength: Math.max(0, numNodes - 2),
        }),
        aggregate: fc.constantFrom("min" as const, "median" as const),
        tail: fc.array(opArb(numNodes), { minLength: 0, maxLength: 60 }),
      })
      .map(({ l0, l1, mids, aggregate, tail }) => ({
        numNodes,
        limits: [l0, l1, ...mids],
        aggregate,
        ops: [...debtPrefix(l0), ...tail],
      })),
  );

/**
 * CONSTANT-`lGlobal` scenarios (regime A): EVERY node is pinned to the SAME
 * `lLocal = c`, so `aggregate(min|median)` of any nonempty live subset is exactly
 * `c` — `lGlobal` is constant regardless of which nodes are live or how the live
 * set shifts under joins/departures. This isolates the budget cap from
 * shrink-drain so the HARD `GlobalCap` invariant can be asserted at every step.
 */
const constScenarioArb: fc.Arbitrary<Scenario> = fc.integer({ min: 2, max: 6 }).chain((numNodes) =>
  fc
    .record({
      numNodes: fc.constant(numNodes),
      c: fc.integer({ min: 4, max: 24 }),
      aggregate: fc.constantFrom("min" as const, "median" as const),
      ops: fc.array(opArb(numNodes), { minLength: 1, maxLength: 80 }),
    })
    .map(({ c, aggregate, ops }) => ({
      numNodes,
      // The pin: ALL nodes share the same lLocal, so lGlobal === c for every
      // live subset (median and min of a constant list is that constant).
      limits: Array.from({ length: numNodes }, () => c),
      aggregate,
      ops,
    })),
);

/**
 * Build a fleet of real `distributedAdaptiveConcurrency` guards over one shared
 * coordinator. Each node's private `adaptiveConcurrency` is pinned to a constant
 * `lLocal` via `minLimit === maxLimit === initialLimit`, so the reported
 * `lLocal` is deterministic and the effective gate is exactly `min(share,
 * lLocal)` (no RTT drift to reason about — this property isolates Mechanism 2).
 */
function buildFleet(
  scenario: Scenario,
  clock: ManualClock,
  coordinator: ConcurrencyCoordinator,
  heartbeatMs: number,
): Node[] {
  const nodes: Node[] = [];
  for (let i = 0; i < scenario.numNodes; i++) {
    const lLocal = scenario.limits[i] ?? 4;
    const { scheduler, fire } = captureScheduler();
    const guard = distributedAdaptiveConcurrency({
      coordinator,
      nodeId: `n${i}`,
      key: KEY,
      // Pin the private limit so lLocal is a controllable constant.
      local: { minLimit: lLocal, maxLimit: lLocal, initialLimit: lLocal, clock },
      heartbeatMs,
      onCoordinatorOutage: scenario.outage ?? "local-only",
      clock,
      scheduler,
    });
    nodes.push({ id: `n${i}`, guard, fire, held: [], departed: false });
  }
  return nodes;
}

/** Σ of the coordinator-COMMITTED shares for the live set (from `peek`). */
const sumCommitted = (shares: Record<string, number>): number =>
  Object.values(shares).reduce((acc, s) => acc + s, 0);

/**
 * The shared discrete-event driver: run `scenario.ops` against a freshly-built
 * fleet over an out-of-order `latencyCoordinator`, invoking `check(net, nodes,
 * label)` after every atomic step. The two regimes below differ ONLY in what
 * `check` asserts. The driver guarantees no timer/promise leaks across runs.
 */
async function runScenario(
  scenario: Scenario,
  check: (net: ReturnType<typeof latencyCoordinator>, nodes: Node[], label: string) => void,
): Promise<void> {
  const clock = new ManualClock(0);
  const inner = new TestConcurrencyCoordinator({ aggregate: scenario.aggregate, clock });
  const net = latencyCoordinator(inner);
  const heartbeatMs = 1000;
  const nodes = buildFleet(scenario, clock, net.coordinator, heartbeatMs);

  try {
    check(net, nodes, "init");
    for (let step = 0; step < scenario.ops.length; step++) {
      const op = scenario.ops[step];
      if (op === undefined) continue;
      switch (op.kind) {
        case "acquire": {
          const node = nodes[op.node];
          if (node !== undefined) {
            const lease = node.guard.acquire();
            if (lease.ok) node.held.push(lease);
          }
          check(net, nodes, `acquire n${op.node}`);
          break;
        }
        case "release": {
          const node = nodes[op.node];
          if (node !== undefined) {
            const lease = node.held.shift();
            if (lease !== undefined) lease.release();
          }
          check(net, nodes, `release n${op.node}`);
          break;
        }
        case "heartbeat": {
          const node = nodes[op.node];
          // A departed node stops heartbeating (it will lease-expire).
          if (node !== undefined && !node.departed) {
            node.fire();
          }
          // Firing only ISSUES the heartbeat (state mutates now); the grant reply
          // is parked until a `land` step. The coordinator-committed share is
          // already in place — `peek` reflects it immediately.
          await drainMicrotasks();
          check(net, nodes, `heartbeat n${op.node}`);
          break;
        }
        case "land": {
          // Deliver parked grant replies, possibly out of order.
          net.landGrants(op.order);
          await drainMicrotasks();
          check(net, nodes, "land");
          break;
        }
        case "advance": {
          clock.advance(op.ms);
          // Advancing time can lease-expire nodes; `peek` honors the same clock,
          // so the live set (and hence committed sum) reflects it immediately.
          check(net, nodes, `advance ${op.ms}`);
          break;
        }
        case "depart": {
          const node = nodes[op.node];
          if (node !== undefined) {
            node.departed = true;
            // Voluntary departure also reclaims the share now (coordinator.leave).
            await node.guard.close();
            await drainMicrotasks();
          }
          check(net, nodes, `depart n${op.node}`);
          break;
        }
      }
    }
  } finally {
    // Land anything still parked, then close every guard so no timer or pending
    // promise leaks across fast-check iterations.
    net.landGrants([]);
    await drainMicrotasks();
    for (const node of nodes) {
      if (!node.departed) await node.guard.close();
    }
    await drainMicrotasks();
  }
}

describe("distributed adaptive concurrency — GlobalCap (constant lGlobal, property, TK-1316)", () => {
  for (const aggregateFixed of ["min", "median"] as const) {
    for (const seed of SEEDS) {
      // REGIME A — the finding-#1 regression guard. Every node is pinned to the
      // SAME lLocal, so lGlobal is a constant for ANY live subset. Under that pin
      // the coordinator's CAP makes `Σ committed share ≤ lGlobal` a HARD invariant
      // at every step, for any heartbeat interleaving / join / departure. The
      // stateless `⌊L/N⌋` split (the bug) would BREAK this the instant a node
      // joins: the joiner computes its share while an incumbent still holds its
      // larger pre-join share, so `Σ share` exceeds lGlobal with lGlobal constant.
      it(`Σ committed share ≤ lGlobal at every step under out-of-order heartbeats [agg=${aggregateFixed}, seed=${seed}]`, async () => {
        await fc.assert(
          fc.asyncProperty(
            // Force the aggregate so each `it` block covers one policy; the rest of
            // the scenario (and the constant `c`) is still randomized.
            constScenarioArb.map((s) => ({ ...s, aggregate: aggregateFixed })),
            async (scenario) => {
              // Sanity: the pin really does make lLocal constant across the fleet.
              const c = scenario.limits[0] ?? 0;
              expect(scenario.limits.every((l) => l === c)).toBe(true);

              const check = (
                net: ReturnType<typeof latencyCoordinator>,
                _nodes: Node[],
                label: string,
              ): void => {
                // Read the coordinator's OWN committed budget + shares — NOT a
                // stateless re-split, NOT the guards' (possibly stale) view.
                const { lGlobal, shares } = net.peek(KEY);
                // While at least one node is live, lGlobal must equal the pin `c`
                // (median/min of a constant list). When the fleet is empty (all
                // lease-expired) lGlobal is 0 and there are no shares.
                if (Object.keys(shares).length > 0) {
                  expect(lGlobal, `[${label}] lGlobal must be the constant ${c}`).toBe(c);
                }
                const committed = sumCommitted(shares);
                // THE hard invariant (GlobalCap / D-DAC-17): the coordinator never
                // commits more than the global budget, at EVERY step.
                expect(
                  committed,
                  `[${label}] Σ committed share=${committed} must be ≤ lGlobal=${lGlobal} (shares=${JSON.stringify(shares)})`,
                ).toBeLessThanOrEqual(lGlobal);
              };

              await runScenario(scenario, check);
            },
          ),
          { numRuns: NUM_RUNS, seed },
        );
      });
    }
  }
});

describe("distributed adaptive concurrency — occupancy cap eliminates the SYNCHRONOUS overshoot (deterministic, TK-1318)", () => {
  // D-DAC-18, the part that is genuinely HARD. With grants applied synchronously
  // (each heartbeat's grant lands before the next admit — NO committed-vs-applied
  // gap), the occupancy cap holds `Σ inflight ≤ lGlobal` at every step through a
  // 1→2 rebalance, because a joiner is reserved its peer's max(share, inflight) and
  // so stays at share 0 until the incumbent physically DRAINS. This is precisely
  // the protocol-level overshoot the share-only cap could NOT hold (it would grant
  // the joiner L/2 while the incumbent still held L in flight ⇒ 1.5×). Proven
  // exhaustively in the synchronous spec + BFS twin; this is the readable witness.
  for (const aggregate of ["min", "median"] as const) {
    it(`B is held at share 0 until the incumbent DRAINS, so Σ inflight ≤ lGlobal throughout [agg=${aggregate}]`, async () => {
      const clock = new ManualClock(0);
      const coord = new TestConcurrencyCoordinator({ aggregate, clock });
      const local = { minLimit: 6, maxLimit: 6, initialLimit: 6, clock };
      const mk = (nodeId: string) =>
        distributedAdaptiveConcurrency({
          coordinator: coord,
          nodeId,
          key: KEY,
          local,
          onCoordinatorOutage: "fail-closed",
          clock,
          scheduler: captureScheduler().scheduler,
        });
      const a = mk("a");
      const b = mk("b");
      const heldA: Lease[] = [];
      const lG = () => coord.peek(KEY).lGlobal;
      const sumLive = () => {
        const { shares } = coord.peek(KEY);
        return ("a" in shares ? a.inflight : 0) + ("b" in shares ? b.inflight : 0);
      };

      await a.heartbeat(); // 1. a solo ⇒ share 6
      for (;;) {
        const l = a.acquire();
        if (!l.ok) break;
        heldA.push(l);
      }
      expect(a.inflight).toBe(6);
      expect(sumLive()).toBeLessThanOrEqual(lG());

      await b.heartbeat(); // 2. b joins ⇒ reserve a's max(share 6, inflight 6)=6 ⇒ share 0
      expect(b.stats().share).toBe(0);
      expect(sumLive()).toBeLessThanOrEqual(lG());

      await a.heartbeat(); // 3. a re-HB ⇒ share 3 (debt: inflight 6 > 3)
      expect(a.stats().share).toBe(3);
      expect(a.inflight).toBe(6);

      await b.heartbeat(); // 4. b re-HB ⇒ reserve a's max(share 3, inflight 6)=6 ⇒ STILL 0
      expect(b.stats().share, "occupancy cap holds B at 0 while A's in-flight is undrained").toBe(
        0,
      );
      expect(b.acquire().ok).toBe(false);
      // THE WIN: the share-only cap would grant B share 3 here ⇒ Σ inflight 6+3=9 (1.5×).
      expect(
        sumLive(),
        "Σ inflight stays ≤ lGlobal — no synchronous overshoot",
      ).toBeLessThanOrEqual(lG());

      while (heldA.length > 3) heldA.pop()!.release(); // 5. a drains to 3
      await a.heartbeat();
      await b.heartbeat(); // 6. b now earns share 3 as a has drained
      expect(b.stats().share).toBe(3);
      for (;;) {
        const l = b.acquire();
        if (!l.ok) break;
      }
      expect(sumLive()).toBeLessThanOrEqual(lG());

      await a.close();
      await b.close();
    });
  }
});

describe("distributed adaptive concurrency — async reply-lag residual is BOUNDED and DRAINS (deterministic, TK-1318)", () => {
  // The HONEST scope of D-DAC-18: it eliminates the SYNCHRONOUS overshoot (above)
  // but does NOT make `Σ inflight ≤ lGlobal` a hard INSTANTANEOUS invariant of the
  // async system. Two lags the synchronous spec abstracts away leave a bounded,
  // draining residual:
  //   (1) committed-vs-applied — the guard admits against its CACHED (applied) grant,
  //       which lags the coordinator's committed share during reply latency;
  //   (2) reporting lag — the cap reserves a peer's LAST-REPORTED inflight.
  // This pins the residual (a reviewer-found counterexample) so the behavior is
  // documented and nobody re-introduces a false "hard end-to-end" claim. It asserts
  // the overshoot (a) occurs, (b) is bounded (≤ 2×, never a runaway), and (c) DRAINS
  // back to ≤ lGlobal once the parked reduction lands (the over-node then admits
  // nothing new — the excess can only drain). A hard instantaneous bound would need
  // per-request coordination or acknowledged handoff (DESIGN §9.3 / D-DAC-18).
  it("a parked share-reduction lets Σ inflight reach ~1.5× transiently, then can only drain", async () => {
    const clock = new ManualClock(0);
    const inner = new TestConcurrencyCoordinator({ aggregate: "median", clock });
    // Deferred-reply coordinator: COMMIT synchronously, PARK the reply; land per-node.
    const parked: Array<{ nodeId: string; resolve: () => void }> = [];
    const coord: ConcurrencyCoordinator = {
      async heartbeat(r: ConcurrencyReport): Promise<ConcurrencyGrant> {
        const g = await inner.heartbeat(r);
        return new Promise<ConcurrencyGrant>((resolve) =>
          parked.push({ nodeId: r.nodeId, resolve: () => resolve(g) }),
        );
      },
      leave: (args) => inner.leave(args),
      isHealthy: () => inner.isHealthy(),
    };
    const land = (nodeId: string): void => {
      for (let i = parked.length - 1; i >= 0; i--) {
        if (parked[i]!.nodeId === nodeId) {
          parked[i]!.resolve();
          parked.splice(i, 1);
        }
      }
    };
    const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
    const local = { minLimit: 6, maxLimit: 6, initialLimit: 6, clock };
    const mk = (nodeId: string) =>
      distributedAdaptiveConcurrency({
        coordinator: coord,
        nodeId,
        key: KEY,
        local,
        onCoordinatorOutage: "fail-closed",
        clock,
        scheduler: captureScheduler().scheduler,
      });
    const a = mk("a");
    const b = mk("b");
    const heldA: Lease[] = [];
    // fire a heartbeat, WAIT for it to commit+park, optionally deliver the reply.
    const hb = async (
      g: { heartbeat(): Promise<void> },
      id: string,
      landIt: boolean,
    ): Promise<void> => {
      void g.heartbeat();
      await flush();
      if (landIt) {
        land(id);
        await flush();
      }
    };
    const sumLive = (): number => {
      const { shares } = inner.peek(KEY);
      return ("a" in shares ? a.inflight : 0) + ("b" in shares ? b.inflight : 0);
    };

    await hb(a, "a", true); // a solo ⇒ share 6
    for (let i = 0; i < 8; i++) {
      const l = a.acquire();
      if (l.ok) heldA.push(l);
    }
    while (heldA.length > 2) heldA.pop()!.release(); // drain to inflight 2
    await hb(a, "a", true); // a re-HB solo (reports inflight 2) ⇒ share 6
    await hb(b, "b", true); // b joins ⇒ share 0
    await hb(a, "a", false); // a re-HB ⇒ committed 3, REPLY PARKED (applied stays 6)

    expect(inner.peek(KEY).shares.a, "coordinator committed the reduction").toBe(3);
    expect(a.stats().share, "but the guard still applies the stale-high grant — the gap").toBe(6);

    await hb(b, "b", true); // b re-HB ⇒ granted 3 (reserves a's committed 3 + stale-low report)
    for (let i = 0; i < 8; i++) b.acquire(); // b fills to 3
    for (let i = 0; i < 8; i++) {
      const l = a.acquire(); // a re-acquires vs its stale applied share 6
      if (l.ok) heldA.push(l);
    }

    const lG = inner.peek(KEY).lGlobal;
    const peak = sumLive();
    // (a) the residual is real; (b) bounded — never a runaway.
    expect(peak, "the documented async reply-lag residual (≈1.5×)").toBeGreaterThan(lG);
    expect(peak, "bounded — Σ inflight ≤ 2× the budget, not unbounded").toBeLessThanOrEqual(2 * lG);

    // (c) it can only DRAIN: once a's parked reduction lands, a applies share 3, is
    // in debt, and admits NOTHING new; releasing its excess in-flight lowers Σ.
    land("a");
    await flush();
    expect(a.stats().share, "applied share catches up once the reply lands").toBe(3);
    expect(a.acquire().ok, "in debt ⇒ no new admits; the overshoot can only drain").toBe(false);
    const beforeDrain = sumLive();
    heldA.pop()!.release();
    expect(sumLive(), "releasing in-flight strictly lowers Σ (monotone drain)").toBeLessThan(
      beforeDrain,
    );

    await a.close();
    await b.close();
  });
});

describe("distributed adaptive concurrency — acknowledged handoff makes Σ inflight ≤ L_global HARD (deterministic, TK-1330)", () => {
  // The FLIP of the residual test above. SAME deferred-reply harness, SAME 1.5×
  // interleaving — but the coordinator runs `acknowledgedHandoff: true` (D-DAC-19).
  // Now it reserves the incumbent at its MAX UN-ACKED grant (6) until the incumbent
  // ECHOES (via appliedGen) that it applied the LOWER share, so the joiner is HELD at
  // 0 through the exact window that overshot to 1.5×, and Σ inflight never exceeds
  // L_global. Proven hard + tight by GaleHeartbeatHandoff (TLC) + the BFS twin
  // (TK-1330); this drives the REAL guard + coordinator through the reviewer-found
  // counterexample and asserts the bound end-to-end — the overshoot becomes a ramp
  // DELAY (the joiner ramps once the incumbent acks AND drains), not a violation.
  it("the joiner is held until the incumbent acks the lower share — no overshoot, then ramps", async () => {
    const clock = new ManualClock(0);
    const inner = new TestConcurrencyCoordinator({
      aggregate: "median",
      clock,
      acknowledgedHandoff: true,
    });
    // Deferred-reply coordinator: COMMIT synchronously, PARK the reply; land per-node.
    const parked: Array<{ nodeId: string; resolve: () => void }> = [];
    const coord: ConcurrencyCoordinator = {
      async heartbeat(r: ConcurrencyReport): Promise<ConcurrencyGrant> {
        const g = await inner.heartbeat(r);
        return new Promise<ConcurrencyGrant>((resolve) =>
          parked.push({ nodeId: r.nodeId, resolve: () => resolve(g) }),
        );
      },
      leave: (args) => inner.leave(args),
      isHealthy: () => inner.isHealthy(),
    };
    const land = (nodeId: string): void => {
      for (let i = parked.length - 1; i >= 0; i--) {
        if (parked[i]!.nodeId === nodeId) {
          parked[i]!.resolve();
          parked.splice(i, 1);
        }
      }
    };
    const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
    const local = { minLimit: 6, maxLimit: 6, initialLimit: 6, clock };
    const mk = (nodeId: string) =>
      distributedAdaptiveConcurrency({
        coordinator: coord,
        nodeId,
        key: KEY,
        local,
        onCoordinatorOutage: "fail-closed",
        clock,
        scheduler: captureScheduler().scheduler,
      });
    const a = mk("a");
    const b = mk("b");
    const heldA: Lease[] = [];
    const hb = async (
      g: { heartbeat(): Promise<void> },
      id: string,
      landIt: boolean,
    ): Promise<void> => {
      void g.heartbeat();
      await flush();
      if (landIt) {
        land(id);
        await flush();
      }
    };
    const sumLive = (): number => {
      const { shares } = inner.peek(KEY);
      return ("a" in shares ? a.inflight : 0) + ("b" in shares ? b.inflight : 0);
    };

    await hb(a, "a", true); // a solo ⇒ share 6
    for (let i = 0; i < 8; i++) {
      const l = a.acquire();
      if (l.ok) heldA.push(l);
    }
    while (heldA.length > 2) heldA.pop()!.release(); // drain to inflight 2
    await hb(a, "a", true); // a re-HB (reports inflight 2 + acks its grant) ⇒ share 6
    await hb(b, "b", true); // b joins ⇒ share 0 (a's un-acked high 6 reserved)
    await hb(a, "a", false); // a re-HB ⇒ committed 3, REPLY PARKED (applied + appliedGen stay stale-high)

    expect(inner.peek(KEY).shares.a, "coordinator committed the reduction").toBe(3);
    expect(a.stats().share, "the guard still applies the stale-high grant — the gap").toBe(6);

    await hb(b, "b", true); // b re-HB ⇒ HELD AT 0 (a has not acked the drop)
    expect(
      b.stats().share,
      "the joiner is HELD at 0 until the incumbent acks — the flip vs the 1.5× residual",
    ).toBe(0);
    for (let i = 0; i < 8; i++) b.acquire(); // b can admit nothing (share 0)
    for (let i = 0; i < 8; i++) {
      const l = a.acquire(); // a re-acquires vs its stale applied share 6
      if (l.ok) heldA.push(l);
    }

    const lG = inner.peek(KEY).lGlobal;
    expect(
      sumLive(),
      "Σ inflight never exceeds L_global — the HARD async bound (was 1.5× without handoff)",
    ).toBeLessThanOrEqual(lG);

    // RAMP DELAY, not a deadlock: once a's reduction lands, a DRAINS to ≤ its new
    // share, and a re-reports (acking the gen + low in-flight), the freed budget is
    // handed to b — and Σ stays ≤ L_global throughout.
    land("a");
    await flush();
    expect(a.stats().share, "applied share catches up once the reply lands").toBe(3);
    while (heldA.length > 3) heldA.pop()!.release(); // a drains to ≤ 3
    await hb(a, "a", true); // a re-HB: acks gen + reports inflight ≤ 3 ⇒ reserve floor resets
    await hb(b, "b", true); // b re-HB ⇒ now granted the freed budget
    expect(
      b.stats().share,
      "after the incumbent acks AND drains, the joiner ramps (liveness — a delay, not a deadlock)",
    ).toBeGreaterThan(0);
    expect(sumLive(), "still ≤ L_global throughout the ramp").toBeLessThanOrEqual(lG);

    await a.close();
    await b.close();
  });
});

describe("distributed adaptive concurrency — shrink-drain (varying lGlobal, property, TK-1316)", () => {
  // Coverage counter (finding #3): how many times the per-node debt branch
  // (`inflight > share`) actually fired across EVERY property run in this
  // describe. The `afterAll` below asserts it is > 0 — so if a future change
  // (to the gate, the cap, or the generators) silently stops reaching the §9.3
  // shrink transient, this suite FAILS instead of passing vacuously.
  let perNodeDebtFires = 0;

  afterAll(() => {
    // The regime is only meaningful if its debt precondition is reached. The
    // `shrinkBiasedScenarioArb` prefix guarantees it; this asserts it observably.
    expect(
      perNodeDebtFires,
      "regime B is VACUOUS: the per-node debt branch (inflight > share) never fired — " +
        "the §9.3 shrink-drain transient was not exercised (finding #3)",
    ).toBeGreaterThan(0);
  });

  for (const aggregateFixed of ["min", "median"] as const) {
    for (const seed of SEEDS) {
      // REGIME B — varying lGlobal. lGlobal genuinely moves/shrinks as the live
      // set shifts, mixing the cap with shrink-drain. So we assert only the WEAKER
      // operational claim of §9.3 — and crucially NOT a safety bound:
      //   per-node: `inflight > share` only via NON-INCREASING debt. The reference
      //   is each guard's OWN current share — the value its gate actually enforces
      //   — NOT the coordinator-committed sum: under local-only cold start a node's
      //   gate is `local.limit` BEFORE its first grant lands (DESIGN §12), so its
      //   admits are bounded by its own share, which the coordinator has not yet
      //   committed. (The hard, coordinator-committed `Σ share ≤ lGlobal` safety
      //   bound is asserted in the CONSTANT-lGlobal regime above, via peek() —
      //   never here.)
      // We deliberately do NOT assert `Σ inflight ≤ lGlobal` as a hard invariant —
      // in-flight is non-revocable and transiently exceeds a freshly-shrunk budget,
      // draining monotonically (liveness, not safety; DESIGN §9.3 / D-DAC-14).
      // We also do NOT assert a GLOBAL `Σ inflight > Σ share` debt branch: it is
      // unreachable in this local-only cold-start harness (one node's debt is
      // always covered by the co-shrunk peers' slack in the SUM), so asserting it
      // would be vacuous — finding #3. The per-node branch is the real guard, and
      // `shrinkBiasedScenarioArb` makes it fire deterministically.
      it(`per-node debt is non-increasing under out-of-order heartbeats [agg=${aggregateFixed}, seed=${seed}]`, async () => {
        await fc.assert(
          fc.asyncProperty(
            // Run over BOTH the random varying timelines (broad coverage) AND the
            // shrink-biased ones (which provably reach the debt branch). Random
            // alone never enters debt at this config (finding #3); the union keeps
            // all the random coverage and makes the transient observably fire.
            fc
              .oneof(varyingScenarioArb, shrinkBiasedScenarioArb)
              .map((s) => ({ ...s, aggregate: aggregateFixed })),
            async (scenario) => {
              const prevInflight = new Map<string, number>();
              const check = (
                _net: ReturnType<typeof latencyCoordinator>,
                nodes: Node[],
                label: string,
              ): void => {
                // Per-node gate. The reference is each guard's CURRENT share (its
                // last-landed grant, or the cold-start local.limit): a fresh admit
                // respects `min(share, local.limit)`, so `inflight > share` can
                // only be draining debt — never a fresh admit.
                for (const n of nodes) {
                  const { share, inflight } = n.guard.stats();
                  const before = prevInflight.get(n.id) ?? 0;
                  if (inflight > share) {
                    perNodeDebtFires++;
                    expect(
                      inflight,
                      `[${label}] n=${n.id} inflight=${inflight} > share=${share} must be non-increasing debt, was ${before}`,
                    ).toBeLessThanOrEqual(before);
                  }
                  prevInflight.set(n.id, inflight);
                }
              };

              await runScenario(scenario, check);
            },
          ),
          { numRuns: NUM_RUNS, seed },
        );
      });
    }
  }
});

describe("distributed adaptive concurrency — shrink-drain branch FIRES (deterministic, TK-1316)", () => {
  // The §9.3 shrink-drain transient is only meaningfully guarded if it can
  // actually OCCUR. This deterministic scenario constructs it end-to-end and
  // asserts the debt branch fires: node A fills a large SOLO share, a peer B then
  // joins, A re-heartbeats and its share is CAPPED below its in-flight ⇒ A is in
  // debt (`inflight > share`), and that debt drains non-increasingly as A releases.
  it("a solo node ramps, a peer joins, the first node's share is capped below its in-flight (debt), then drains", async () => {
    const clock = new ManualClock(0);
    // median over a 2-node fleet of equal lLocal=8 ⇒ lGlobal=8; solo ⇒ lGlobal=8.
    const coord = new TestConcurrencyCoordinator({ aggregate: "median", clock });
    const local = { minLimit: 8, maxLimit: 8, initialLimit: 8, clock };

    const a = distributedAdaptiveConcurrency({
      coordinator: coord,
      nodeId: "node-a",
      key: KEY,
      local,
      onCoordinatorOutage: "local-only",
      clock,
      scheduler: captureScheduler().scheduler,
    });
    const b = distributedAdaptiveConcurrency({
      coordinator: coord,
      nodeId: "node-b",
      key: KEY,
      local,
      onCoordinatorOutage: "local-only",
      clock,
      scheduler: captureScheduler().scheduler,
    });

    // 1. A heartbeats SOLO ⇒ share = lGlobal = 8 (B not yet present).
    await a.heartbeat();
    expect(a.stats().share).toBe(8);

    // 2. A fills its full solo share — 8 in-flight.
    const held: Lease[] = [];
    for (;;) {
      const l = a.acquire();
      if (!l.ok) break;
      held.push(l);
    }
    expect(a.inflight).toBe(8);
    expect(a.inflight).toBeLessThanOrEqual(a.stats().share); // not yet debt

    // 3. B joins (first heartbeat): B sees others=A.share=8, target=4, so the cap
    //    gives B share = min(4, 8−8) = 0. GlobalCap holds (8+0 ≤ 8); B is starved
    //    until A re-heartbeats down.
    await b.heartbeat();
    expect(b.stats().share).toBe(0);
    expect(
      coord.peek(KEY).shares["node-a"]! + coord.peek(KEY).shares["node-b"]!,
    ).toBeLessThanOrEqual(8);

    // 4. A re-heartbeats in the now-2-node fleet: target=4, others=B.share=0, so
    //    A.share = min(4, 8−0) = 4 — CAPPED below A's in-flight of 8. THE DEBT.
    await a.heartbeat();
    expect(a.stats().share).toBe(4);
    expect(a.inflight).toBe(8);
    expect(a.inflight).toBeGreaterThan(a.stats().share); // debt branch FIRED
    // The committed sum is still within budget even though in-flight overshoots.
    expect(
      coord.peek(KEY).shares["node-a"]! + coord.peek(KEY).shares["node-b"]!,
    ).toBeLessThanOrEqual(8);

    // 5. A admits NOTHING new while in debt (the gate `min(share, local.limit)=4`
    //    is below in-flight), and the debt drains non-increasingly as A releases.
    expect(a.acquire().ok).toBe(false);
    let prev = a.inflight;
    for (const l of held) {
      l.release();
      expect(a.inflight).toBeLessThanOrEqual(prev); // monotone drain
      prev = a.inflight;
    }
    expect(a.inflight).toBe(0);

    await a.close();
    await b.close();
  });
});
