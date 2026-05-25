/**
 * Fixed-memory rate limiting over an unbounded key universe (sketchRateLimit).
 *
 * A normal per-key limiter stores one record per active key — under a volumetric attack from
 * millions of distinct source IPs, that per-key state is *itself* the memory-exhaustion vector.
 * `sketchRateLimit` keeps a single Count-Min Sketch whose footprint depends only on the accuracy
 * parameters (epsilon, delta), never on how many keys are seen. It never over-admits; its only
 * error is denying a key slightly early once hash collisions inflate its estimate.
 *
 * Run with:  npx tsx examples/sketch-ddos.ts
 */

import { ManualClock, sketchRateLimit } from "../src/index";

function exactWithinBudget(): void {
  const clock = new ManualClock(0);
  const limiter = sketchRateLimit({ limit: 5, windowMs: 1_000, clock });

  // The footprint is set at construction from epsilon/delta — not the key count.
  console.log(`capacity: ${limiter.capacity} counters (~7.4 KiB), fixed for the limiter's life`);

  // Within the sketch's accuracy budget, distinct keys are tracked exactly: 1,000 distinct IPs,
  // each making one request, are all admitted — and memory has not grown.
  let admitted = 0;
  for (let i = 0; i < 1_000; i++) {
    if (limiter.checkSync(`198.51.100.${i}`).allowed) admitted++;
  }
  console.log(`1,000 distinct IPs → ${admitted} admitted; capacity still ${limiter.capacity}`);
}

function floodShedsSafely(): void {
  const clock = new ManualClock(0);
  const limiter = sketchRateLimit({ limit: 5, windowMs: 1_000, clock });

  // A volumetric flood far exceeding what a 7.4 KiB sketch is sized for. A per-key limiter would
  // allocate ~1M records here (the exhaustion vector). The sketch holds fixed memory by trading
  // accuracy — it sheds aggressively, but ALWAYS in the safe direction: it never over-admits, it
  // only denies early. Memory stays flat no matter how many distinct keys arrive.
  let admitted = 0;
  for (let i = 0; i < 1_000_000; i++) {
    if (limiter.checkSync(`flood-${i}`).allowed) admitted++;
  }
  console.log(
    `1,000,000 distinct keys → ${admitted} admitted (sheds early, safe direction); ` +
      `capacity still ${limiter.capacity}`,
  );
}

function neverOverAdmitsAHotKey(): void {
  const clock = new ManualClock(0);
  const limiter = sketchRateLimit({ limit: 5, windowMs: 1_000, clock });

  // Hammer one key far past its limit within a single window.
  let allowed = 0;
  for (let i = 0; i < 20; i++) {
    if (limiter.checkSync("attacker").allowed) allowed++;
  }
  // The guarantee is hard (non-probabilistic): allowed is NEVER more than the limit.
  console.log(`hot key: ${allowed} allowed out of 20 (limit 5) — never over-admits:`, allowed <= 5);

  // The window is fixed and epoch-aligned: crossing windowMs resets the budget.
  clock.advance(1_000);
  console.log("after window roll, allowed again:", limiter.checkSync("attacker").allowed);
}

exactWithinBudget();
floodShedsSafely();
neverOverAdmitsAHotKey();
