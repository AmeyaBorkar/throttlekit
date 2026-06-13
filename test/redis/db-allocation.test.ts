/**
 * Static guard against the cross-file Redis DB-collision class fixed on 2026-05-30.
 *
 * The bug: two test files that run in parallel were assigned the SAME logical Redis DB, and each
 * file's setup issues a DB-global FLUSHDB — so one file would wipe the other's keys mid-test,
 * making the dual-path byte-identity assertions flake nondeterministically under load. (It bit
 * `node-redis`↔`weighted-fair-escrow` on DB 7 and, after 0.11.1, `fused-conformance`↔
 * `joint-lp-dual-path` on DB 12.)
 *
 * The suite invariant is ONE dedicated logical DB per Redis-backed test file. There are more
 * Redis-backed files than the 16 logical DBs stock Redis provides (and CI's service container
 * can't be given more), so one logical DB is co-tenanted by a sanctioned GROUP — sanctioned ONLY
 * because every file in it is provably flush-free (none FLUSHDBs; keys are uniquely namespaced).
 *
 * This test is a pure static scan (no Redis needed, never skipped). If you add a Redis-backed
 * test file, give it an unused DB number — or, if you must share, make BOTH co-tenants flush-free
 * with disjoint keys and add them here.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = join(HERE, "..");
const SELF = "db-allocation.test.ts";

// The single sanctioned co-tenancy: logical DB -> the exact set of files allowed to share it.
// Both are flush-free (no DB-global FLUSHDB) with disjoint, per-run/per-attempt key namespaces.
const SANCTIONED_SHARE = new Map<number, ReadonlySet<string>>([
  [
    7,
    new Set([
      "node-redis.test.ts",
      "weighted-fair-escrow-properties.test.ts",
      "cross-store-equivalence.test.ts",
      "redis-region-fair-pool.test.ts",
      // distributedTokenBudget's remaining()-peek regression: flush-free (a unique per-run `tpm:` key,
      // del'd before/after; never FLUSHDBs), so it co-tenants DB 7 safely (all 16 DBs are allocated).
      "distributed-budget.test.ts",
    ]),
  ],
]);

/** A client-option DB selector: ioredis `db: N` or node-redis `database: N` (with the colon). */
const DB_SELECTOR = /\b(?:database|db):\s*(\d+)/g;

function listTestFiles(): string[] {
  return readdirSync(TEST_ROOT, { recursive: true, encoding: "utf8" }).filter(
    (f): f is string => typeof f === "string" && f.endsWith(".test.ts"),
  );
}

/** Map logical DB number -> set of basenames that select it. */
function buildDbOwnership(): Map<number, Set<string>> {
  const byDb = new Map<number, Set<string>>();
  for (const rel of listTestFiles()) {
    const base = rel.split(/[\\/]/).pop() as string;
    if (base === SELF) continue; // don't scan our own allow-list literals
    const src = readFileSync(join(TEST_ROOT, rel), "utf8");
    for (const m of src.matchAll(DB_SELECTOR)) {
      const db = Number(m[1]);
      const owners = byDb.get(db) ?? new Set<string>();
      owners.add(base);
      byDb.set(db, owners);
    }
  }
  return byDb;
}

describe("Redis logical-DB allocation (static guard, no Redis required)", () => {
  const byDb = buildDbOwnership();

  it("no two test files share a logical DB except the sanctioned flush-free pair", () => {
    const collisions: string[] = [];
    for (const [db, owners] of byDb) {
      if (owners.size <= 1) continue;
      const allowed = SANCTIONED_SHARE.get(db);
      const isSanctioned =
        allowed !== undefined &&
        owners.size === allowed.size &&
        [...owners].every((o) => allowed.has(o));
      if (!isSanctioned) {
        collisions.push(`  DB ${db}: ${[...owners].sort().join(", ")}`);
      }
    }
    expect(
      collisions,
      `Redis DB collision(s) — parallel files sharing one logical DB FLUSHDB-race each other:\n${collisions.join(
        "\n",
      )}\nGive each file a unique DB, or make both co-tenants flush-free and add them to SANCTIONED_SHARE.`,
    ).toEqual([]);
  });

  it("the sanctioned flush-free co-tenancy on DB 7 is still intact", () => {
    // Guards the other direction: if someone moves one of the group off DB 7, the exception is
    // stale and should be removed — fail loudly so it can't silently mask a future real collision.
    const owners = [...(byDb.get(7) ?? new Set<string>())].sort();
    expect(owners).toEqual([
      "cross-store-equivalence.test.ts",
      "distributed-budget.test.ts",
      "node-redis.test.ts",
      "redis-region-fair-pool.test.ts",
      "weighted-fair-escrow-properties.test.ts",
    ]);
  });
});
