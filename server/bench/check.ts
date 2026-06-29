/**
 * Server `Check` handler CPU micro-benchmark — the per-request cost of the gRPC `RateLimiter.Check`
 * handler **in isolation, with no network**.
 *
 * The handler (`server/src/grpc.ts`) is a pure translation: an already-decoded request object → the
 * core service `check` (enforce + the core's `Decision`) → `decisionMessage` shaping → the unary
 * callback. This harness builds the service over an in-process `MemoryStore`-backed `gcra` limiter,
 * builds ONE request object, and times calling the handler in a hot loop (best-of-N), so it isolates
 * the **decision + enforce + message-shaping** CPU — exactly the path two planned server wins target.
 *
 * What this does NOT measure: the gRPC/HTTP-2 proto encode+decode. With grpc-js's dynamic proto
 * loader that codec runs at the transport boundary (inside the server's wire handling), not inside the
 * handler — the handler receives a plain decoded `call.request` and returns a plain object grpc-js then
 * encodes. Fully isolating that codec in-process isn't feasible without standing up a real socket (see
 * `server/bench/fleet.ts` for the full round-trip number, which DOES include it). So this is the
 * handler-call cost only; the proto codec is out of frame by construction.
 *
 *   cd server && npx tsx bench/check.ts        # or, from the repo root: npm run bench:check
 *
 * ALLOW path, single hot key (the `gcra` limit is high enough that the key never denies across the run),
 * matching BENCH.md's methodology. Numbers are produced on YOUR hardware — nothing here is a vendor claim.
 */
import { MemoryStore } from "throttlekit";

import { writeManifest } from "../../bench/manifest";
import { rateLimiterHandlers } from "../src/grpc.js";
import { createRateLimiterServiceFromConfig } from "../src/service.js";

const ITERS = 200_000;
const WARMUP = 10_000;
const RUNS = 5;

// One plain `gcra` policy over an in-process MemoryStore. The limit is high enough that the single hot
// key never denies across the whole run, so every call shapes a real ALLOW `Decision` (the message-
// shaping path the server win targets runs on allow and deny alike, but ALLOW is the methodology).
const CONFIG = JSON.stringify({
  limiters: { api: { strategy: "gcra", limit: 1_000_000_000, period: 60_000 } },
});

/** The shape `rateLimiterHandlers().check` actually consumes: it reads only `call.request`. */
type UnaryHandler = (
  call: { request: unknown },
  cb: (err: unknown, resp?: unknown) => void,
) => void;

interface Row {
  label: string;
  note: string;
  opsPerSec: number;
  nsPerOp: number;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(n < 10 ? 2 : 0);
}

/** Time `iters` awaited handler calls; returns ns/op. The handler resolves via the unary callback. */
async function timeOne(fn: () => Promise<unknown>, iters: number): Promise<number> {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) await fn();
  return Number(process.hrtime.bigint() - t0) / iters;
}

/** Best-of-N — the min is the most stable estimator on noisy hardware (matches bench/gate.ts). */
async function timeBestOf(
  fn: () => Promise<unknown>,
  iters: number,
  runs: number,
): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < runs; r++) {
    const ns = await timeOne(fn, iters);
    if (ns < best) best = ns;
  }
  return best;
}

async function main(): Promise<void> {
  console.log("ThrottleKit server Check-handler benchmark (in-process, no network)");
  console.log(`node ${process.version}`);

  const service = createRateLimiterServiceFromConfig(CONFIG, { store: new MemoryStore() });
  const handlers = rateLimiterHandlers(service);
  const check = handlers.check as unknown as UnaryHandler;
  // The decoded request the transport would hand the handler. Reused across the loop — we are timing the
  // handler, not allocation of the request, exactly as the in-process strategy benches reuse one key.
  const call = { request: { policy: "api", key: "hot", cost: 1 } };

  const checkOnce = (): Promise<unknown> =>
    new Promise((resolve, reject) => {
      check(call, (err, resp) => (err ? reject(err) : resolve(resp)));
    });

  // Confirm we're on the ALLOW path before timing (a denied/erroring config would silently skew the row).
  const probe = (await checkOnce()) as { decision?: { allowed?: boolean } };
  if (probe?.decision?.allowed !== true) {
    throw new Error(
      "Check-handler bench expected an ALLOW decision; got a deny — check the config",
    );
  }

  for (let i = 0; i < WARMUP; i++) await checkOnce(); // warm up / JIT

  const nsPerOp = await timeBestOf(checkOnce, ITERS, RUNS);
  const row: Row = {
    label: "RateLimiter.Check handler",
    note: "in-process gcra/MemoryStore; decision + enforce + message-shaping (excludes proto wire codec)",
    opsPerSec: (1e9 / nsPerOp) * 1,
    nsPerOp,
  };

  console.log(`\nbest of ${RUNS} × ${ITERS.toLocaleString()} calls (single hot key, ALLOW path):`);
  console.log(
    `  ${row.label.padEnd(28)} ${fmt(row.opsPerSec).padStart(8)} ops/s   ${row.nsPerOp.toFixed(0).padStart(6)} ns/op   ${row.note}`,
  );

  const path = writeManifest("check", {
    benchmark: "server-check-handler-cpu-in-process",
    iters: ITERS,
    warmup: WARMUP,
    runs: RUNS,
    rows: [row],
  });
  console.log(`\nManifest: ${path}`);

  await service.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
