/**
 * Watch the `--tui` dashboard run against synthetic traffic — no gRPC, no second terminal.
 *
 *   cd server && npm run build && node examples/tui-demo.mjs    # run in a REAL terminal; press q to quit
 *
 * It builds the same telemetry hub the server uses, taps a couple of rate limiters, a unified
 * (rate × concurrency) admitter, a concurrency guard, and a weighted-fair-escrow budget, then drives
 * randomized load so every view animates — press 1-5 / Tab to switch between Overview, Latency, Fairness,
 * Capacity, and Guarantee (throughput, the binding-axis hero, top denied keys, concurrency health, feed).
 */

import { MemoryStore, adaptiveConcurrency, gcra, rateLimit, unifiedAdmission } from "throttlekit";
import { weightedFairEscrow } from "throttlekit/twotier";
import { createLensHub } from "../dist/monitor/hub.js";
import { runTui } from "../dist/tui.js";

const hub = createLensHub({ windowMs: 60_000 });
hub.setHealth({ backend: "demo", failMode: "open" });

const limiter = (limit) =>
  rateLimit({
    strategy: gcra({ limit, periodMs: 60_000, burst: limit }),
    store: new MemoryStore(),
  });

const api = hub.trackLimiter("api", limiter(50));
const search = hub.trackLimiter("search", limiter(25));
const unified = hub.trackAdmitter(
  "unified-api",
  unifiedAdmission({
    rate: limiter(45),
    concurrency: adaptiveConcurrency({ minLimit: 3, maxLimit: 3 }),
  }),
);
const checkout = hub.trackGuard("checkout", adaptiveConcurrency({ minLimit: 8, maxLimit: 8 }));

// Weighted-fair-escrow: one shared budget split across tenants by weight (the Fairness view reads stats()).
const fair = weightedFairEscrow({
  limit: 1000,
  windowMs: 60_000,
  weightOf: (t) => ({ "tenant-aci": 3, "user-7": 2 })[t] ?? 1,
});
hub.trackStats("fair-api", "wfe", () => fair.stats());

// Weighted keys — a few hot ones so the top-K and the feed look real.
const keys = [
  "user-1",
  "user-1",
  "user-1",
  "user-7",
  "user-7",
  "tenant-aci",
  "ip-10.0.0.7",
  "ip-10.0.0.7",
  "bob",
  "carol",
  "dave",
];
const pick = () => keys[(Math.random() * keys.length) | 0];

const holds = [];
const leases = [];

async function tick() {
  for (let i = 0; i < 12; i++) api.checkSync(pick());
  for (let i = 0; i < 6; i++) search.checkSync(pick());

  // Unified admits: hold a few to press the concurrency cap, so denials split rate vs concurrency.
  for (let i = 0; i < 3; i++) {
    try {
      const a = await unified.admit({ key: pick() });
      if (a.decision.allowed) holds.push(a);
      else a.release();
    } catch {}
  }
  if (Math.random() < 0.25)
    while (holds.length)
      try {
        holds.shift().release();
      } catch {}

  // Weighted-fair tenants: heavier tenants (tenant-aci ×3, user-7 ×2) push past their guaranteed share
  // and borrow idle tenants' surplus — so the Fairness view shows green (within guarantee) + yellow (borrow).
  for (let i = 0; i < 6; i++) fair.checkSync(pick(), 1 + ((Math.random() * 6) | 0));

  // Standalone concurrency guard: oscillate inflight for the concurrency-health panel.
  for (let i = 0; i < 3; i++) {
    const lease = checkout.acquire();
    if (lease.ok) leases.push(lease);
  }
  while (leases.length > 6)
    try {
      leases.shift().release();
    } catch {}
  if (Math.random() < 0.4 && leases.length)
    try {
      leases.pop().release();
    } catch {}
}

setInterval(() => void tick().catch(() => {}), 90);
runTui(hub, { nodeId: "demo:local", onQuit: () => process.exit(0) });
