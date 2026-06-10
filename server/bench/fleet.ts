/**
 * Fleet-door benchmark — the Tier-2 round-trip reduction (the P6 headline).
 *
 * Stands up a REAL gRPC server with a `federated:` policy + the `Fleet.Reserve` lease door, then drives the
 * same ALLOW-path workload two ways against it:
 *   - Tier-1: one `Check` RPC per request (the per-request round trip every distributed limiter pays).
 *   - Tier-2: one `Fleet.Reserve` per BATCH, then `LeaseSpender.spend` locally for the rest of the batch.
 * For each it reports ops/sec, round-trips/request, and p50/p99/p99.9 served-request latency, across batch
 * sizes and across two coordinators:
 *   - TestCoordinator (in-process) — isolates the client<->server gRPC hop the lease amortizes.
 *   - RedisCoordinator (when THROTTLEKIT_TEST_REDIS is set) — the realistic distributed cost (the server's
 *     coordinator hop is amortized too, so the reduction is even larger).
 *
 * The server computes every grant SIZE (the one oracle); the client only spends it. The local spend is the
 * core `LeaseSpender` under test (imported from the repo source), so this measures the same code the golden
 * lease vectors pin.
 *
 *   cd server && npx tsx bench/fleet.ts
 *   cd server && THROTTLEKIT_TEST_REDIS=redis://localhost:6380 npx tsx bench/fleet.ts
 *
 * Numbers are produced on YOUR hardware — nothing here is a vendor claim. The absolute latency on Windows is
 * dominated by the loopback gRPC / Docker round trip; use the rows to compare Tier-1 vs Tier-2, not to
 * predict a production p50.
 */
import { hrtime } from "node:process";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { RedisCoordinator, TestCoordinator } from "throttlekit/federation";
import type { GlobalCoordinator } from "throttlekit/federation";

import { writeManifest } from "../../bench/manifest";
// The core client-side spend under test (repo source, not the published package — this is the P6 artifact).
import { LeaseSpender } from "../../src/twotier/lease-spender";
import { makeFederatedFleetSource } from "../src/fleet/source.js";
import { type RunningServer, resolveProtoPath, serve } from "../src/grpc.js";
import { createRateLimiterServiceFromConfig } from "../src/service.js";

const HUGE = 1_000_000_000;
const WINDOW_MS = 60_000; // one window spans the whole bench, so the ALLOW-path budget never rolls/exhausts
const POLICY = "api";
const KEY = "hot"; // single hot key (caller.domain), matching BENCH.md's single-hot-key methodology

/** A federated fixedWindow policy with a budget large enough that the ALLOW path never denies. */
const FED = JSON.stringify({
  limiters: {
    [POLICY]: {
      federated: { region: "bench", batch: 1 }, // batch 1 ⇒ Tier-1 Check pays one coordinator lease per req
      strategy: "fixedWindow",
      limit: HUGE,
      period: WINDOW_MS,
    },
  },
});

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(n < 10 ? 2 : 0);
}

function percentiles(samplesNs: number[]): { p50: number; p99: number; p999: number; max: number } {
  const s = samplesNs.slice().sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  return { p50: at(0.5), p99: at(0.99), p999: at(0.999), max: s[s.length - 1] ?? 0 };
}

function us(ns: number): string {
  return `${(ns / 1000).toFixed(1)}µs`;
}

interface Clients {
  check: (req: unknown) => Promise<any>;
  reserve: (req: unknown) => Promise<any>;
  close: () => void;
}

/** Build a RateLimiter (Tier-1) + Fleet (Tier-2) client pair against a running server. */
function makeClients(port: number): Clients {
  const def = protoLoader.loadSync(resolveProtoPath(), {
    keepCase: false,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(def) as any;
  const target = `127.0.0.1:${port}`;
  const creds = grpc.credentials.createInsecure();
  const rl = new proto.throttlekit.v1.RateLimiter(target, creds);
  const fleet = new proto.throttlekit.v1.Fleet(target, creds);
  const unary =
    (client: any, method: string) =>
    (req: unknown): Promise<any> =>
      new Promise((resolve, reject) => {
        client[method](req, (err: unknown, resp: unknown) => (err ? reject(err) : resolve(resp)));
      });
  return {
    check: unary(rl, "check"),
    reserve: unary(fleet, "reserve"),
    close: () => {
      rl.close();
      fleet.close();
    },
  };
}

/** Start a server whose Tier-1 federated limiter and Tier-2 fleet source share ONE `coordinator`. */
async function serveFleet(coordinator: GlobalCoordinator): Promise<RunningServer> {
  const service = createRateLimiterServiceFromConfig(FED, { makeCoordinator: () => coordinator });
  const sources = {
    [POLICY]: makeFederatedFleetSource(coordinator, { windowMs: WINDOW_MS, limit: HUGE }),
  };
  return serve({ service, port: 0, fleet: { sources } });
}

interface Tier1Result {
  tier: "tier1-check";
  reqs: number;
  opsPerSec: number;
  roundTripsPerReq: number;
  p50us: number;
  p99us: number;
  p999us: number;
}

/** Tier-1: one Check RPC per request. The baseline every per-request distributed limiter pays. */
async function runTier1(c: Clients, reqs: number): Promise<Tier1Result> {
  for (let i = 0; i < 200; i++) await c.check({ policy: POLICY, key: KEY, cost: 1 }); // warm (script + JIT + conn)
  const samples: number[] = [];
  const t0 = hrtime.bigint();
  for (let i = 0; i < reqs; i++) {
    const s = hrtime.bigint();
    await c.check({ policy: POLICY, key: KEY, cost: 1 });
    samples.push(Number(hrtime.bigint() - s));
  }
  const totalNs = Number(hrtime.bigint() - t0);
  const p = percentiles(samples);
  return {
    tier: "tier1-check",
    reqs,
    opsPerSec: (reqs / totalNs) * 1e9,
    roundTripsPerReq: 1,
    p50us: p.p50 / 1000,
    p99us: p.p99 / 1000,
    p999us: p.p999 / 1000,
  };
}

interface Tier2Result {
  tier: "tier2-lease";
  batch: number;
  reqs: number;
  opsPerSec: number;
  reserves: number;
  reqsPerRoundTrip: number;
  p50us: number;
  p99us: number;
  p999us: number;
}

/**
 * Tier-2: lease BATCH units in one Reserve, then serve locally with the core `LeaseSpender` until the chunk
 * is spent. A real high-throughput client over-asks (`wants = BATCH`) to amortize the hop — the spender's
 * own `spendOrRefresh` would ask for `cost`, so the batch is the client's policy, expressed here directly.
 */
async function runTier2(c: Clients, reqs: number, batch: number): Promise<Tier2Result> {
  const reserveBatch = (spender: LeaseSpender) => async () => {
    const resp = await c.reserve({ policy: POLICY, caller: { domain: KEY }, wants: batch });
    const lease = resp.lease;
    spender.applyLease({ capacity: lease.capacity, expiresAt: lease.expiryMs });
    return lease.capacity as number;
  };

  // Warm: a couple of full lease cycles (load the Lua/script path on the server + JIT the spend loop).
  {
    const warm = new LeaseSpender({ limit: HUGE });
    const refill = reserveBatch(warm);
    for (let i = 0; i < Math.max(batch * 2, 200); i++) {
      let r = warm.spend(Date.now(), 1);
      while (r.needsRefresh) {
        await refill();
        r = warm.spend(Date.now(), 1);
      }
    }
  }

  const spender = new LeaseSpender({ limit: HUGE });
  const refill = reserveBatch(spender);
  let reserves = 0;
  const samples: number[] = [];
  const t0 = hrtime.bigint();
  for (let i = 0; i < reqs; i++) {
    const now = Date.now();
    const s = hrtime.bigint();
    let r = spender.spend(now, 1);
    while (r.needsRefresh) {
      reserves++;
      await refill();
      r = spender.spend(now, 1);
    }
    samples.push(Number(hrtime.bigint() - s));
  }
  const totalNs = Number(hrtime.bigint() - t0);
  const p = percentiles(samples);
  return {
    tier: "tier2-lease",
    batch,
    reqs,
    opsPerSec: (reqs / totalNs) * 1e9,
    reserves,
    reqsPerRoundTrip: reserves > 0 ? reqs / reserves : reqs,
    p50us: p.p50 / 1000,
    p99us: p.p99 / 1000,
    p999us: p.p999 / 1000,
  };
}

interface CoordinatorRun {
  coordinator: string;
  reqs: number;
  tier1: Tier1Result;
  tier2: Tier2Result[];
}

/** Drive Tier-1 + a Tier-2 batch sweep against one coordinator, on a fresh server. */
async function benchCoordinator(
  label: string,
  makeCoord: () => GlobalCoordinator,
  reqs: number,
  batches: number[],
): Promise<CoordinatorRun> {
  const coordinator = makeCoord();
  const running = await serveFleet(coordinator);
  const clients = makeClients(running.port);
  try {
    console.log(`\n${label} coordinator (reqs=${reqs}):`);
    const tier1 = await runTier1(clients, reqs);
    console.log(
      `  Tier-1 Check (1 RPC / req)      ${fmt(tier1.opsPerSec).padStart(8)} ops/s   ` +
        `p50 ${us(tier1.p50us * 1000)}  p99 ${us(tier1.p99us * 1000)}  ${tier1.roundTripsPerReq} trip/req`,
    );
    const tier2: Tier2Result[] = [];
    for (const batch of batches) {
      const r = await runTier2(clients, reqs, batch);
      tier2.push(r);
      const speedup = r.opsPerSec / tier1.opsPerSec;
      console.log(
        `  Tier-2 lease (batch ${String(batch).padStart(4)})       ${fmt(r.opsPerSec).padStart(8)} ops/s   ` +
          `p50 ${us(r.p50us * 1000)}  p99 ${us(r.p99us * 1000)}  ` +
          `${r.reqsPerRoundTrip.toFixed(0)} req/trip   ${speedup.toFixed(1)}x`,
      );
    }
    return { coordinator: label, reqs, tier1, tier2 };
  } finally {
    clients.close();
    await running.close();
  }
}

/** Parse a positive-int env override, falling back to `dflt`. */
function envInt(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;
}

async function main(): Promise<void> {
  console.log("ThrottleKit Fleet-door benchmark — Tier-2 lease round-trip reduction");
  console.log(`node ${process.version}`);

  const runs: CoordinatorRun[] = [];
  const batches = process.env.FLEET_BATCHES?.split(",")
    .map(Number)
    .filter((n) => n > 0) ?? [10, 100, 1000];
  const testReqs = envInt("FLEET_TEST_REQS", 20_000);
  const redisReqs = envInt("FLEET_REDIS_REQS", 3_000);

  // In-process coordinator: isolates the client<->server gRPC hop the lease amortizes.
  runs.push(
    await benchCoordinator(
      "TestCoordinator (in-process)",
      () => new TestCoordinator({ budgetPerWindow: HUGE }),
      testReqs,
      batches,
    ),
  );

  // Realistic distributed coordinator: the server's lease hits Redis too, so Tier-2 amortizes BOTH hops.
  const redisUrl = process.env.THROTTLEKIT_TEST_REDIS;
  if (redisUrl) {
    const { default: Redis } = await import("ioredis");
    const client = new Redis(redisUrl, { maxRetriesPerRequest: 2, db: 12 });
    await client.flushdb();
    try {
      runs.push(
        await benchCoordinator(
          "RedisCoordinator (distributed)",
          () =>
            new RedisCoordinator({
              client,
              windowMs: WINDOW_MS,
              budgetPerWindow: HUGE,
              prefix: "tkbench:fleet",
            }),
          redisReqs,
          batches,
        ),
      );
    } finally {
      await client.quit();
    }
  } else {
    console.log(
      "\nRedisCoordinator: skipped (set THROTTLEKIT_TEST_REDIS=redis://localhost:6380 for the distributed tier)",
    );
  }

  const path = writeManifest("fleet", { benchmark: "fleet-door-round-trip-reduction", runs });
  console.log(`\nManifest: ${path}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
