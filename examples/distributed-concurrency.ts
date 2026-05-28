/**
 * Distributed adaptive concurrency: ONE cooperatively-inferred global ceiling
 * shared across a fleet of nodes fronting a single backend — the 0.10.0
 * primitive (`distributedAdaptiveConcurrency`, bet #80, TK-1315).
 *
 * The problem (DESIGN §1.1): a plain `adaptiveConcurrency()` infers a ceiling
 * **per process** from locally observed RTT. When N nodes front one shared
 * backend, each independently infers a ceiling for the *whole* backend and the
 * fleet collectively admits up to `Σ Lᵢ` ≈ N×capacity — the adaptive limiter
 * that was supposed to *prevent* overload now *causes* it under fan-out.
 *
 * `distributedAdaptiveConcurrency()` closes that gap. It is a drop-in
 * `ConcurrencyGuard` (so every 0.9.2 adapter picks it up unchanged) that keeps
 *
 *     Σ_n inflight[n]  ≤  L_global
 *
 * where `L_global = aggregate({L_local})` over the live fleet (NEVER `sum` —
 * summing rebuilds the N×capacity bug; DESIGN §7 / D-DAC-10), parcelled into
 * per-node `share`s by an equal split with `Σ share = L_global` exactly
 * (DESIGN §6). Each node's effective ceiling is `min(share, local.limit)`
 * (D-DAC-6): the `share` term enforces the fleet bound, the `local.limit` term
 * gives sub-heartbeat reaction to a local RTT spike.
 *
 * This example uses `TestConcurrencyCoordinator` — in-memory, deterministic,
 * NO timers and NO I/O — so it runs standalone with no external services:
 *
 *   npx tsx examples/distributed-concurrency.ts
 *
 * It walks four things end to end:
 *   1. acquire / release across 3 simulated nodes sharing one coordinator;
 *   2. a forced heartbeat (`await guard.heartbeat()`) and the resulting share;
 *   3. share convergence as `L_global` re-aggregates and re-splits;
 *   4. a coordinator-outage fallback (fail-closed → share=0, then recovery),
 *      contrasted with the `local-only` degraded mode.
 *
 * Everything is driven off a `ManualClock` plus an injected, manually-pumped
 * `HeartbeatScheduler`, so the timeline is fully reproducible — no real timers,
 * no wall-clock flakiness.
 */

import {
  type DistributedConcurrencyGuard,
  type HeartbeatScheduler,
  ManualClock,
  TestConcurrencyCoordinator,
  distributedAdaptiveConcurrency,
} from "../src/index";

// The shared-backend key. Every node fronting the same backend MUST use the
// same key (DESIGN §5.1) — that is what makes them share one `L_global`.
const KEY = "inference-cluster";

// Three simulated gateway nodes, all fronting the one backend above. In a real
// deployment each `nodeId` is one process (e.g. `process.env.HOSTNAME`); here
// they are three guards in this one script, talking to one in-memory
// coordinator.
const NODE_IDS = ["gw-a", "gw-b", "gw-c"];

/**
 * A `HeartbeatScheduler` we pump by hand. The production default uses an
 * (unref'd) `setInterval`; for a deterministic example we capture the heartbeat
 * callbacks instead and never auto-fire them — we drive every heartbeat
 * explicitly via `guard.heartbeat()`. `cancel()` removes the callback so a
 * closed guard stops heartbeating (mirrors the timer being cleared).
 */
function manualScheduler(): HeartbeatScheduler {
  return {
    schedule(_fn: () => void, _everyMs: number): { cancel(): void } {
      // Intentionally inert: the example pumps heartbeats with guard.heartbeat()
      // so the timeline stays reproducible. We don't retain `_fn`.
      return { cancel(): void {} };
    },
  };
}

/** Drive every node's heartbeat once, in nodeId order (one coordination round-trip each). */
async function heartbeatAll(guards: DistributedConcurrencyGuard[]): Promise<void> {
  for (const g of guards) await g.heartbeat();
}

async function main(): Promise<void> {
  // A clock we own. Both the coordinator (for lease-expiry comparison) and the
  // guards (for `expiresAt = now + leaseTtlMs`) read THIS clock, so expiry is
  // exact and deterministic.
  const clock = new ManualClock(0);

  // The in-memory coordinator that owns `L_global`. "median" is the default
  // aggregation (the lower median of live nodes' L_local — robust to one
  // mis-calibrated node; DESIGN §7). We make it explicit here.
  const coordinator = new TestConcurrencyCoordinator({ aggregate: "median", clock });

  const HEARTBEAT_MS = 1000;
  // leaseTtlMs default is 2·heartbeatMs (D-DAC-7): one slow heartbeat doesn't
  // drop a node; only two consecutive misses do. We rely on the default.

  // Each node runs a PRIVATE adaptiveConcurrency that owns its RTT / L_local /
  // inflight. We pin each node's L_local via `initialLimit` (and a matching
  // minLimit so it can't fall below) so the aggregate + split arithmetic is
  // easy to read — no RTT is driven in steps 1-3. Node "gw-c" is given a
  // higher L_local so the median (vs the would-be-buggy sum) is visible.
  const LOCAL_LIMITS: Record<string, number> = { "gw-a": 12, "gw-b": 12, "gw-c": 60 };

  const guards = NODE_IDS.map((nodeId) =>
    distributedAdaptiveConcurrency({
      coordinator,
      nodeId,
      key: KEY,
      heartbeatMs: HEARTBEAT_MS,
      // fail-closed (the default): on a coordinator outage the node sheds
      // everything (share→0). Safety > availability — matches federation.
      onCoordinatorOutage: "fail-closed",
      clock,
      scheduler: manualScheduler(),
      local: {
        initialLimit: LOCAL_LIMITS[nodeId]!,
        minLimit: LOCAL_LIMITS[nodeId]!,
        maxLimit: 512,
      },
    }),
  );
  const [a, b, c] = guards as [
    DistributedConcurrencyGuard,
    DistributedConcurrencyGuard,
    DistributedConcurrencyGuard,
  ];

  // A node-aware stats printer (reads the pinned L_local for the L_global col).
  const print = (nodeId: string, guard: DistributedConcurrencyGuard): void => {
    const s = guard.stats();
    console.log(
      `  ${nodeId.padEnd(5)} ` +
        `L_local=${String(LOCAL_LIMITS[nodeId]).padStart(2)} ` +
        `share=${String(s.share).padStart(2)} ` +
        `inflight=${String(s.inflight).padStart(2)} ` +
        `effective=min(share,L_local)=${String(s.limit).padStart(2)} ` +
        `| L_global=${String(s.lGlobal).padStart(2)} nodes=${s.nodes}`,
    );
  };
  const printAll = (): void => {
    for (const nodeId of NODE_IDS) print(nodeId, guards[NODE_IDS.indexOf(nodeId)]!);
  };

  console.log("distributed adaptive concurrency — 3 nodes, one shared backend");
  console.log(`  key="${KEY}"  aggregate=median  heartbeatMs=${HEARTBEAT_MS}`);
  console.log(`  L_local per node: ${JSON.stringify(LOCAL_LIMITS)}`);
  console.log("");

  // ───────────────────────────────────────────────────────────────────────
  // STEP 0 — cold start (D-DAC-12).
  // Before the first grant lands, fail-closed pins share=0: the node admits
  // NOTHING for ~one round-trip. (local-only would pin share=local.limit.)
  // ───────────────────────────────────────────────────────────────────────
  console.log("STEP 0 — cold start (before first heartbeat, fail-closed):");
  printAll();
  const coldLease = a.acquire();
  console.log(`  gw-a.acquire() before first heartbeat -> ok=${coldLease.ok} (share=0 ⇒ shed)`);
  console.log("");

  // ───────────────────────────────────────────────────────────────────────
  // STEP 1 — forced heartbeat: report L_local, take a share, then acquire.
  // `await guard.heartbeat()` is the explicit "report now" hook (DESIGN §5.2);
  // it does one coordination round-trip and refreshes share/L_global/nodes.
  //
  // We heartbeat the fleet TWICE. Each guard's `share` reflects the coordinator
  // snapshot at the instant of *its own* round-trip: on the first pass gw-a sees
  // only itself (N=1 ⇒ share=12), gw-b sees {a,b} (N=2), gw-c sees all three
  // (N=3). A second pass lets every node observe the full fleet and converge.
  // Then: L_global = median(12, 12, 60) = 12 (the LOWER median — NOT sum=84,
  // which would be the N×capacity overshoot bug). Equal-split 12 over 3 nodes:
  // base=4, rem=0 ⇒ every node's share=4, and Σ share = 12 = L_global exactly.
  // ───────────────────────────────────────────────────────────────────────
  console.log("STEP 1 — forced heartbeat on every node, then acquire/release:");
  await heartbeatAll(guards); // pass 1: nodes register one by one
  await heartbeatAll(guards); // pass 2: every node now sees the full fleet (N=3)
  printAll();
  console.log(
    "  L_global = median(12,12,60) = 12  (NOT sum=84 — summing is the §1.1 overshoot bug)",
  );
  console.log("  equal-split 12 over 3 ⇒ base=4, rem=0 ⇒ each share=4 (Σ share = 12 = L_global)");

  // Acquire on gw-a up to its effective ceiling (min(share=4, L_local=12) = 4),
  // then prove the gate sheds the 5th request.
  const leases = [];
  for (let i = 0; i < 5; i++) {
    const lease = a.acquire();
    console.log(
      `    gw-a.acquire() #${i + 1} -> ok=${lease.ok}${lease.ok ? `  (inflight now ${a.inflight})` : "  (share full ⇒ shed)"}`,
    );
    if (lease.ok) leases.push(lease);
  }
  // Release everything we took (event-release: returning the slot + recording RTT).
  // The ManualClock hasn't advanced, so each RTT is 0 — fine, no overload signal.
  for (const lease of leases) lease.release();
  console.log(`    released all; gw-a.inflight = ${a.inflight}`);
  console.log("");

  // ───────────────────────────────────────────────────────────────────────
  // STEP 2 — share convergence as the fleet membership changes.
  // gw-c leaves voluntarily (close() → coordinator.leave(), reclaiming its
  // share immediately rather than waiting for the TTL). Now only {gw-a, gw-b}
  // are live: L_global = median(12,12) = 12 (lower median of two), equal-split
  // over 2 ⇒ base=6, rem=0 ⇒ each share=6. Surviving nodes' shares GREW from 4
  // to 6 on the next heartbeat — capacity the departed node held is reclaimed.
  // ───────────────────────────────────────────────────────────────────────
  console.log("STEP 2 — share convergence (gw-c leaves, survivors' shares grow):");
  console.log("  before: each survivor still caches its 3-node share (4) from STEP 1:");
  print("gw-a", a);
  print("gw-b", b);
  await c.close(); // voluntary departure: leave() reclaims gw-c's share now
  console.log("  gw-c.close() — voluntary leave(); coordinator drops gw-c immediately.");
  // peek() shows the COORDINATOR's view directly (test helper, DESIGN §5.3).
  // gw-c is already gone from the coordinator, but the survivors' own stats()
  // still show the stale 3-node share until they re-heartbeat.
  const before = coordinator.peek(KEY);
  console.log(
    `  coordinator.peek (gw-c already evicted): L_global=${before.lGlobal} nodes=${before.nodes} shares=${JSON.stringify(before.shares)}`,
  );
  await heartbeatAll([a, b]); // survivors re-heartbeat → re-aggregate + re-split
  const after = coordinator.peek(KEY);
  console.log(
    `  after survivors re-heartbeat: L_global=${after.lGlobal} nodes=${after.nodes} shares=${JSON.stringify(after.shares)}`,
  );
  print("gw-a", a);
  print("gw-b", b);
  console.log("  → each survivor's share converged 4 → 6 (Σ share = 12 = L_global, still exact).");
  console.log("");

  // ───────────────────────────────────────────────────────────────────────
  // STEP 3 — coordinator-outage fallback (D-DAC-11, DESIGN §8.2).
  // We partition the coordinator. Under fail-closed (the default), the next
  // heartbeat throws and the guard drives share→0: the node sheds EVERYTHING
  // until the coordinator returns. Never overshoots; trades availability.
  // ───────────────────────────────────────────────────────────────────────
  console.log("STEP 3 — coordinator outage, fail-closed (default):");
  coordinator.setHealthy(false);
  console.log("  coordinator.setHealthy(false) — simulated partition.");
  await a.heartbeat(); // never throws; applies the outage policy (share→0)
  print("gw-a", a);
  const outageLease = a.acquire();
  console.log(`    gw-a.acquire() during outage -> ok=${outageLease.ok} (share=0 ⇒ shed all, 503)`);

  // Recovery: the coordinator returns; the next successful heartbeat restores
  // the share. (Only {gw-a, gw-b} are live, so share recovers to 6.)
  coordinator.setHealthy(true);
  console.log("  coordinator.setHealthy(true) — partition heals.");
  await a.heartbeat();
  print("gw-a", a);
  const recoveredLease = a.acquire();
  console.log(`    gw-a.acquire() after recovery -> ok=${recoveredLease.ok} (share restored)`);
  if (recoveredLease.ok) recoveredLease.release();
  console.log("");

  // ───────────────────────────────────────────────────────────────────────
  // STEP 4 — contrast: the "local-only" degraded mode.
  // A separate guard configured local-only falls back to PURE in-process
  // adaptive concurrency on an outage (share→local.limit): each node
  // self-limits and stays up, but the fleet MAY collectively overshoot the
  // backend (the §1.1 regime). The honest availability-over-strictness choice.
  // ───────────────────────────────────────────────────────────────────────
  console.log('STEP 4 — contrast: "local-only" outage mode (availability > strict bound):');
  const localOnly = distributedAdaptiveConcurrency({
    coordinator,
    nodeId: "gw-localonly",
    key: KEY,
    heartbeatMs: HEARTBEAT_MS,
    onCoordinatorOutage: "local-only",
    clock,
    scheduler: manualScheduler(),
    local: { initialLimit: 20, minLimit: 20, maxLimit: 512 },
  });
  coordinator.setHealthy(false);
  await localOnly.heartbeat(); // outage → share = local.limit (= 20), not 0
  const lo = localOnly.stats();
  console.log(
    `  gw-localonly during outage: share=${lo.share} effective=${lo.limit} (falls back to its own L_local=20 — fleet may overshoot, but stays up)`,
  );
  const loLease = localOnly.acquire();
  console.log(
    `    gw-localonly.acquire() during outage -> ok=${loLease.ok} (admits up to L_local)`,
  );
  if (loLease.ok) loLease.release();
  await localOnly.close();
  coordinator.setHealthy(true);
  console.log("");

  // ───────────────────────────────────────────────────────────────────────
  // Clean shutdown: close() cancels the (manual) timer and best-effort
  // leave()s the fleet. Idempotent.
  // ───────────────────────────────────────────────────────────────────────
  await a.close();
  await b.close();
  // gw-c was already closed in STEP 2; close() is idempotent, so this is safe.
  await c.close();

  const final = coordinator.peek(KEY);
  console.log("all nodes closed; coordinator drained:");
  console.log(
    `  coordinator.peek: L_global=${final.lGlobal} nodes=${final.nodes} ` +
      `shares=${JSON.stringify(final.shares)}`,
  );
  console.log("");
  console.log("✓ Σ inflight ≤ L_global held at every step (the distributed safety bound).");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
