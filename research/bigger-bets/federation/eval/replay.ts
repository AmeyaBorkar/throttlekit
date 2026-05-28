/**
 * Federation eval — replay harness (TK-909).
 *
 * Feeds an Azure-trace-like workload through three federated regions
 * sharing one global coordinator Redis (the docker-compose layout in
 * `./docker-compose.yml`), measuring:
 *
 *   - Δ          : worst-case admitted - L (must be ≤ 0 for federation to hold)
 *   - U          : utilization = admitted / offered (closer to 1 is better)
 *   - coordTrips : cross-region coordinator round trips (proxy for cost)
 *   - p50/p99    : per-decision latency, ms
 *
 * Output: JSON to stdout. Pipe to a file:
 *
 *     npx tsx research/bigger-bets/federation/eval/replay.ts > result.json
 *
 * Cross-region latency is injected in-process by wrapping each RedisCoordinator
 * call in a setTimeout(REGION_LATENCY_MS). This avoids needing toxiproxy or
 * tc qdisc capabilities in the docker-compose layout.
 *
 * The script is designed to be re-run in TK-910 against a real cloud
 * cluster (fly.io / GCP / AWS) — change the connection URLs in CONFIG
 * and the LatencyProxy disappears (real RTT replaces simulated).
 *
 * Workload model: Azure traces are bursty + skewed across regions.
 * We synthesize a representative shape: K=3 regions, each running
 * Poisson(λ_r) over WINDOWS windows of WINDOW_MS, where the λ vector
 * defaults to [0.5, 0.3, 0.2] of L per window (60/30/20 split — heavy
 * us-east, moderate eu-west, light ap-south). The skew is controllable
 * via the SKEW env var; SKEW=1 puts ALL load on us-east.
 */

import { createClient } from "redis";
import { fixedWindow } from "../../../../src/algorithms/fixed-window";
import { systemClock } from "../../../../src/core/clock";
import { RedisCoordinator, federate } from "../../../../src/federation";
import type { GlobalCoordinator } from "../../../../src/federation";
import { fromNodeRedis } from "../../../../src/redis/clients";

// ---- CONFIG ----

const CONFIG = {
  coordinatorUrl: process.env.TK_FED_COORD_URL ?? "redis://localhost:16380",
  regions: ["us-east", "eu-west", "ap-south"] as const,
  /** Cross-region RTT (ms) injected before each coordinator call. */
  regionLatencyMs: Number(process.env.REGION_LATENCY_MS ?? "100"),
  /** Per-window budget. */
  globalLimit: Number(process.env.GLOBAL_LIMIT ?? "1000"),
  /** Per-region escrow size. */
  batch: Number(process.env.BATCH ?? "16"),
  /** Window length (ms). */
  windowMs: Number(process.env.WINDOW_MS ?? "60000"),
  /** Number of full windows to drive. */
  windows: Number(process.env.WINDOWS ?? "3"),
  /** Skew parameter (0 = uniform, 1 = all on us-east). */
  skew: Number(process.env.SKEW ?? "0.6"),
  /** Per-window offered load multiplier vs the global budget. 1.2 = drive 20% past L. */
  offeredMultiplier: Number(process.env.OFFERED_MULT ?? "1.2"),
} as const;

// ---- LATENCY PROXY ----

/** Wrap a coordinator so every call has `latencyMs` delay (simulates cross-region RTT). */
function latencyProxy(inner: GlobalCoordinator, latencyMs: number): GlobalCoordinator {
  const delay = () => new Promise<void>((res) => setTimeout(res, latencyMs));
  return {
    async lease(key, tokens, expiresAt) {
      await delay();
      return inner.lease(key, tokens, expiresAt);
    },
    async reconcile(key, leftover, windowStart) {
      await delay();
      return inner.reconcile(key, leftover, windowStart);
    },
    async isHealthy() {
      await delay();
      return (await inner.isHealthy?.()) ?? true;
    },
  };
}

// ---- WORKLOAD ----

/** Generate per-region offered counts for a window given skew s. */
function regionLoads(L: number, K: number, skew: number, multiplier: number): number[] {
  const fHot = 1 / K + skew * (1 - 1 / K);
  const fCold = K === 1 ? 0 : (1 - fHot) / (K - 1);
  const total = Math.round(L * multiplier);
  const coldLoad = Math.round(total * fCold);
  const hotLoad = total - coldLoad * (K - 1);
  return [hotLoad, ...Array.from({ length: K - 1 }, () => coldLoad)];
}

// ---- MAIN ----

async function main() {
  const client = createClient({ url: CONFIG.coordinatorUrl });
  await client.connect();
  await client.flushDb();

  const innerCoord = new RedisCoordinator({
    client: fromNodeRedis(client),
    windowMs: CONFIG.windowMs,
    budgetPerWindow: CONFIG.globalLimit,
    prefix: "fed-eval",
  });

  // Count coordinator trips by wrapping the proxy too.
  let coordTrips = 0;
  const counting: GlobalCoordinator = {
    async lease(...args) {
      coordTrips++;
      return innerCoord.lease(...args);
    },
    async reconcile(...args) {
      return innerCoord.reconcile(...args);
    },
    async isHealthy() {
      return innerCoord.isHealthy?.() ?? true;
    },
  };
  const coordinator = latencyProxy(counting, CONFIG.regionLatencyMs);

  const limiters = CONFIG.regions.map((region) =>
    federate({
      strategy: fixedWindow({ limit: CONFIG.globalLimit, windowMs: CONFIG.windowMs }),
      coordinator,
      region,
      batch: CONFIG.batch,
      clock: systemClock,
    }),
  );

  const latencies: number[] = [];
  let totalOffered = 0;
  let totalAdmitted = 0;
  const perWindowAdmits: number[] = [];

  for (let w = 0; w < CONFIG.windows; w++) {
    const loads = regionLoads(
      CONFIG.globalLimit,
      CONFIG.regions.length,
      CONFIG.skew,
      CONFIG.offeredMultiplier,
    );
    let windowAdmits = 0;
    for (let r = 0; r < CONFIG.regions.length; r++) {
      const limiter = limiters[r];
      if (limiter === undefined) continue;
      const load = loads[r];
      if (load === undefined || load === 0) continue;
      for (let i = 0; i < load; i++) {
        totalOffered++;
        const t0 = performance.now();
        const d = await limiter.check("hot");
        const t1 = performance.now();
        latencies.push(t1 - t0);
        if (d.allowed) {
          totalAdmitted++;
          windowAdmits++;
        }
      }
    }
    perWindowAdmits.push(windowAdmits);
    // Roll the window — sleep to the next boundary.
    await new Promise((res) => setTimeout(res, CONFIG.windowMs + 100));
  }

  const sorted = latencies.slice().sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.floor((sorted.length - 1) * p)] ?? 0;

  const overshoot = Math.max(0, ...perWindowAdmits.map((a) => a - CONFIG.globalLimit));

  const result = {
    config: { ...CONFIG },
    metrics: {
      offered: totalOffered,
      admitted: totalAdmitted,
      uOffered: totalAdmitted / Math.max(1, totalOffered),
      uCapacity: totalAdmitted / (CONFIG.globalLimit * CONFIG.windows),
      overshoot,
      coordTrips,
      coordTripsPerRequest: coordTrips / Math.max(1, totalOffered),
      latencyMs: {
        p50: pct(0.5),
        p95: pct(0.95),
        p99: pct(0.99),
      },
      perWindowAdmits,
    },
    timestamp: new Date().toISOString(),
  };

  console.log(JSON.stringify(result, null, 2));
  await client.flushDb();
  await client.quit();
}

main().catch((err) => {
  console.error("eval failed:", err);
  process.exit(1);
});
