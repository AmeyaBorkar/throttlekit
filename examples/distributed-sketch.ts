/**
 * Cluster-wide heavy-hitter detection with a mergeable Count-Min Sketch.
 *
 * A low-and-slow distributed attacker spreads its requests thin across many nodes — under any single
 * node's per-key threshold, so no node sheds it alone. Because CMS counters are linear, each node can
 * ship its fixed-memory sketch (compact bytes) to the others and merge them: the sum is *exactly* the
 * sketch of the whole cluster's traffic, so every node sees the attacker's true global volume and
 * sheds it. Memory per node is fixed (independent of how many distinct clients exist).
 *
 * Honest scope: this is eventually-consistent *detection* (each node acts on its latest merged view),
 * not a strongly-consistent global limit — for that, use rateLimit over Redis/Postgres, or twoTier.
 *
 * Run with:  npx tsx examples/distributed-sketch.ts
 */

import { type MergeableSketch, mergeableSketch, sketchSnapshotFromBytes } from "../src/index";

const NODES = ["node-a", "node-b", "node-c"];
const THRESHOLD = 100; // shed a key whose GLOBAL estimate exceeds this per window
const ATTACKER = "198.51.100.66";

const sketches = new Map<string, MergeableSketch>(
  NODES.map((n) => [n, mergeableSketch({ epsilon: 0.01, delta: 0.001 })]),
);

// Each node sees 40 attacker hits (well under the threshold) plus its own benign traffic.
for (const n of NODES) {
  const s = sketches.get(n) as MergeableSketch;
  for (let i = 0; i < 40; i++) s.add(ATTACKER);
  for (let i = 0; i < 1_000; i++) s.add(`user-${n}-${i}`);
}

console.log("Per-node view (the attacker hides below the threshold everywhere):");
for (const n of NODES) {
  const est = (sketches.get(n) as MergeableSketch).estimate(ATTACKER);
  console.log(`  ${n}: attacker estimate ${est}  ->  ${est > THRESHOLD ? "SHED" : "allow"}`);
}

// Gossip round: every node ships its sketch as bytes; each node merges in its peers' snapshots.
const wire = new Map(NODES.map((n) => [n, (sketches.get(n) as MergeableSketch).toBytes()]));
for (const n of NODES) {
  const s = sketches.get(n) as MergeableSketch;
  for (const peer of NODES) {
    if (peer !== n) s.merge(sketchSnapshotFromBytes(wire.get(peer) as Uint8Array));
  }
}

console.log("\nAfter merge (every node sees the cluster-wide total and sheds it):");
for (const n of NODES) {
  const est = (sketches.get(n) as MergeableSketch).estimate(ATTACKER);
  console.log(`  ${n}: attacker estimate ${est}  ->  ${est > THRESHOLD ? "SHED" : "allow"}`);
}

const one = sketches.get("node-a") as MergeableSketch;
console.log(
  `\nmemory per node: ${one.capacity} counters (~${((one.capacity * 4) / 1024).toFixed(1)} KiB), independent of client count`,
);
