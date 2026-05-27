import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type D1Like,
  type D1PreparedStatementLike,
  type D1ResultLike,
  D1Store,
} from "../../src/cloudflare";
import { ManualClock } from "../../src/core/clock";
import type { ApplyOutcome, Transform } from "../../src/core/types";
import { runStoreConformance } from "../../src/testkit";

/** One stored row, mirroring the D1Store schema. */
interface FakeRow {
  state: string;
  expires_at: number;
  version: number;
}

/**
 * In-memory fake of a Cloudflare D1 binding. The decisive property is that `first()` and `run()` do
 * their map work **synchronously** inside an already-resolved promise: because JS is single-threaded,
 * no two `run()` bodies can interleave mid-statement, which is exactly SQLite/D1's single-writer
 * serialization — the guarantee the store's version compare-and-set relies on. `dump()` exposes the
 * backing rows for assertions.
 */
function fakeD1(): D1Like & { dump(): Map<string, FakeRow> } {
  const rows = new Map<string, FakeRow>();

  function stmt(sql: string, args: readonly unknown[] = []): D1PreparedStatementLike {
    return {
      bind: (...values: unknown[]): D1PreparedStatementLike => stmt(sql, values),
      first: <T = Record<string, unknown>>(): Promise<T | null> => {
        // SELECT state, expires_at, version FROM t WHERE key = ?
        const key = args[0] as string;
        const r = rows.get(key);
        return Promise.resolve((r === undefined ? null : { ...r }) as T | null);
      },
      run: (): Promise<D1ResultLike> => {
        const head = sql.trimStart().slice(0, 6).toUpperCase();
        let changes = 0;
        if (head === "INSERT") {
          // INSERT ... VALUES (?, ?, ?, 0) ON CONFLICT(key) DO NOTHING
          const [key, state, expiresAt] = args as [string, string, number];
          if (!rows.has(key)) {
            rows.set(key, { state, expires_at: expiresAt, version: 0 });
            changes = 1;
          }
        } else if (head === "UPDATE") {
          // UPDATE ... SET ..., version = version + 1 WHERE key = ? AND version = ?
          const [state, expiresAt, key, version] = args as [string, number, string, number];
          const r = rows.get(key);
          if (r !== undefined && r.version === version) {
            rows.set(key, { state, expires_at: expiresAt, version: version + 1 });
            changes = 1;
          }
        } else if (head === "DELETE") {
          if (sql.includes("expires_at <=")) {
            const cutoff = args[0] as number;
            for (const [k, r] of rows) {
              if (r.expires_at <= cutoff) {
                rows.delete(k);
                changes++;
              }
            }
          } else {
            const key = args[0] as string;
            if (rows.delete(key)) changes = 1;
          }
        }
        // CREATE TABLE / CREATE INDEX → no-op (changes 0).
        return Promise.resolve({ meta: { changes } });
      },
    };
  }

  return { prepare: (sql: string): D1PreparedStatementLike => stmt(sql), dump: () => rows };
}

/** A minimal counter transform (no Lua form — the D1 store runs the JS body via its CAS loop). */
const counter =
  (ttlMs = 1000): Transform<number, number> =>
  (state: number | undefined): ApplyOutcome<number, number> => {
    const next = (state ?? 0) + 1;
    return { state: next, result: next, ttlMs, persist: true };
  };

/** A non-mutating read: observe the count without writing. */
const read =
  (): Transform<number, number> =>
  (state: number | undefined): ApplyOutcome<number, number> => ({
    state,
    result: state ?? 0,
    ttlMs: 0,
    persist: false,
  });

// The load-bearing suite. Same-isolate applies are coalesced, so the 200-way concurrent RMW lands
// exactly 200 with clean version bumps; the cross-isolate CAS path is exercised separately below.
runStoreConformance(
  "D1Store",
  () => {
    const clock = new ManualClock(0);
    return {
      store: new D1Store({ db: fakeD1(), clock }),
      advance: (ms: number) => clock.advance(ms),
    };
  },
  { describe, it, expect, beforeEach, afterEach },
);

describe("D1Store — specifics", () => {
  it("namespaces keys by prefix on a shared database (no cross-prefix collision)", async () => {
    const clock = new ManualClock(0);
    const db = fakeD1();
    const a = new D1Store({ db, clock, prefix: "a" });
    const b = new D1Store({ db, clock, prefix: "b" });
    expect(await a.apply("k", counter())).toBe(1);
    expect(await b.apply("k", counter())).toBe(1); // independent bucket despite the same raw key
    expect(await a.apply("k", counter())).toBe(2);
    expect(await b.apply("k", counter())).toBe(2);
  });

  it("reset clears state", async () => {
    const clock = new ManualClock(0);
    const store = new D1Store({ db: fakeD1(), clock });
    expect(await store.apply("k", counter())).toBe(1);
    await store.reset("k");
    expect(await store.apply("k", counter())).toBe(1);
  });

  it("expires lazily by the injected clock, overwriting the stale row in place", async () => {
    const clock = new ManualClock(0);
    const db = fakeD1();
    const store = new D1Store({ db, clock });
    expect(await store.apply("k", counter(1000))).toBe(1);
    clock.advance(1001);
    expect(await store.apply("k", counter(1000))).toBe(1); // prior entry expired → restarts
    // The physical row was CAS-overwritten (version bumped), not duplicated.
    expect(db.dump().get("k")?.version).toBe(1);
  });

  it("sweep() reclaims only expired rows and reports the count", async () => {
    const clock = new ManualClock(0);
    const db = fakeD1();
    const store = new D1Store({ db, clock });
    await store.apply("short", counter(1000));
    await store.apply("long", counter(10_000));
    clock.advance(5000); // "short" is now expired, "long" is not
    expect(await store.sweep()).toBe(1);
    expect(db.dump().has("short")).toBe(false);
    expect(db.dump().has("long")).toBe(true);
  });

  it("resolves cross-isolate races via the version CAS (two stores, one database)", async () => {
    // Separate store instances do NOT share the in-process lock, so their applies genuinely race at
    // the shared database and must be reconciled by the version compare-and-set + retry.
    const clock = new ManualClock(0);
    const db = fakeD1();
    const a = new D1Store({ db, clock });
    const b = new D1Store({ db, clock });
    const applies = [
      ...Array.from({ length: 50 }, () => a.apply("k", counter(60_000))),
      ...Array.from({ length: 50 }, () => b.apply("k", counter(60_000))),
    ];
    await Promise.all(applies);
    expect(await a.apply("k", read())).toBe(100); // no lost updates across the two isolates
  });

  it("throws StoreUnavailableError when CAS retries are exhausted", async () => {
    const clock = new ManualClock(0);
    // A database whose conditional writes never commit (changes always 0) forces retry exhaustion.
    const stuck: D1Like = {
      prepare: (): D1PreparedStatementLike => {
        const self: D1PreparedStatementLike = {
          bind: () => self,
          first: <T = Record<string, unknown>>(): Promise<T | null> => Promise.resolve(null),
          run: (): Promise<D1ResultLike> => Promise.resolve({ meta: { changes: 0 } }),
        };
        return self;
      },
    };
    const store = new D1Store({ db: stuck, clock, maxRetries: 2 });
    await expect(store.apply("k", counter())).rejects.toThrow(/optimistic concurrency exhausted/);
  });

  it("honors autoCreate:false by issuing no DDL", async () => {
    const clock = new ManualClock(0);
    const inner = fakeD1();
    const seen: string[] = [];
    const db: D1Like = {
      prepare: (sql: string): D1PreparedStatementLike => {
        seen.push(sql.trimStart().slice(0, 6).toUpperCase());
        return inner.prepare(sql);
      },
    };
    const store = new D1Store({ db, clock, autoCreate: false });
    expect(await store.apply("k", counter())).toBe(1); // still works against the pre-existing schema
    expect(seen).not.toContain("CREATE"); // ...but no DDL was issued
    expect(seen).toContain("INSERT");
  });
});
