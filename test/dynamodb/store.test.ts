import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManualClock } from "../../src/core/clock";
import type { ApplyOutcome, Transform } from "../../src/core/types";
import {
  type DynamoClientLike,
  type DynamoDeleteInput,
  type DynamoGetInput,
  type DynamoPutInput,
  DynamoStore,
} from "../../src/dynamodb";
import { runStoreConformance } from "../../src/testkit";

/**
 * In-memory fake of a DynamoDB document client. The decisive property: `put` evaluates its
 * `ConditionExpression` and mutates the table **synchronously** inside the call, so — JS being
 * single-threaded — no two conditional writes interleave mid-check. That is exactly DynamoDB's
 * conditional-write atomicity, the guarantee the store's version CAS relies on. A failed condition
 * rejects with an error named `ConditionalCheckFailedException`, like the real SDK. `dump()` exposes
 * the table for assertions.
 */
function fakeDynamo(hashKey = "pk"): DynamoClientLike & {
  dump(): Map<string, Record<string, unknown>>;
} {
  const items = new Map<string, Record<string, unknown>>();
  return {
    get: (input: DynamoGetInput): Promise<Record<string, unknown> | undefined> => {
      const it = items.get(String(input.Key[hashKey]));
      return Promise.resolve(it === undefined ? undefined : { ...it });
    },
    put: (input: DynamoPutInput): Promise<void> => {
      const pk = String(input.Item[hashKey]);
      const existing = items.get(pk);
      const ok = input.ConditionExpression.includes("attribute_not_exists")
        ? existing === undefined
        : existing !== undefined && existing.version === input.ExpressionAttributeValues?.[":v"];
      if (!ok) {
        const err = new Error("The conditional request failed");
        err.name = "ConditionalCheckFailedException";
        return Promise.reject(err);
      }
      items.set(pk, { ...input.Item });
      return Promise.resolve();
    },
    delete: (input: DynamoDeleteInput): Promise<void> => {
      items.delete(String(input.Key[hashKey]));
      return Promise.resolve();
    },
    dump: () => items,
  };
}

/** A minimal counter transform (no Lua form — the Dynamo store runs the JS body via its CAS loop). */
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

// The load-bearing suite. Same-process applies are coalesced, so the 200-way concurrent RMW lands
// exactly 200 with clean version bumps; the cross-process CAS path is exercised separately below.
runStoreConformance(
  "DynamoStore",
  () => {
    const clock = new ManualClock(0);
    return {
      store: new DynamoStore({ client: fakeDynamo(), tableName: "throttlekit", clock }),
      advance: (ms: number) => clock.advance(ms),
    };
  },
  { describe, it, expect, beforeEach, afterEach },
);

describe("DynamoStore — specifics", () => {
  it("namespaces keys by prefix on a shared table (no cross-prefix collision)", async () => {
    const clock = new ManualClock(0);
    const client = fakeDynamo();
    const a = new DynamoStore({ client, tableName: "t", clock, prefix: "a" });
    const b = new DynamoStore({ client, tableName: "t", clock, prefix: "b" });
    expect(await a.apply("k", counter())).toBe(1);
    expect(await b.apply("k", counter())).toBe(1); // independent bucket despite the same raw key
    expect(await a.apply("k", counter())).toBe(2);
    expect(await b.apply("k", counter())).toBe(2);
  });

  it("reset clears state", async () => {
    const clock = new ManualClock(0);
    const store = new DynamoStore({ client: fakeDynamo(), tableName: "t", clock });
    expect(await store.apply("k", counter())).toBe(1);
    await store.reset("k");
    expect(await store.apply("k", counter())).toBe(1);
  });

  it("expires lazily by the injected clock, overwriting the stale item in place", async () => {
    const clock = new ManualClock(0);
    const client = fakeDynamo();
    const store = new DynamoStore({ client, tableName: "t", clock });
    expect(await store.apply("k", counter(1000))).toBe(1);
    clock.advance(1001);
    expect(await store.apply("k", counter(1000))).toBe(1); // prior entry expired → restarts
    expect(client.dump().get("k")?.version).toBe(1); // CAS-overwritten, not duplicated
  });

  it("writes expires_at in epoch seconds (so DynamoDB TTL can reclaim the item)", async () => {
    const clock = new ManualClock(1_700_000_000_000); // a realistic epoch-ms instant
    const client = fakeDynamo();
    const store = new DynamoStore({ client, tableName: "t", clock });
    await store.apply("k", counter(60_000));
    // 1_700_000_060_000 ms → ceil(/1000) = 1_700_000_060 s, not the ms value.
    expect(client.dump().get("k")?.expires_at).toBe(1_700_000_060);
  });

  it("uses a custom hashKey attribute name", async () => {
    const clock = new ManualClock(0);
    const client = fakeDynamo("id");
    const store = new DynamoStore({ client, tableName: "t", hashKey: "id", clock });
    expect(await store.apply("k", counter())).toBe(1);
    expect(await store.apply("k", counter())).toBe(2);
    expect(client.dump().get("k")?.id).toBe("k"); // stored under the configured attribute
  });

  it("resolves cross-process races via the version CAS (two stores, one table)", async () => {
    // Separate store instances do NOT share the in-process lock, so their applies genuinely race at
    // the shared table and must be reconciled by the conditional write + retry.
    const clock = new ManualClock(0);
    const client = fakeDynamo();
    const a = new DynamoStore({ client, tableName: "t", clock });
    const b = new DynamoStore({ client, tableName: "t", clock });
    const applies = [
      ...Array.from({ length: 50 }, () => a.apply("k", counter(60_000))),
      ...Array.from({ length: 50 }, () => b.apply("k", counter(60_000))),
    ];
    await Promise.all(applies);
    expect(await a.apply("k", read())).toBe(100); // no lost updates across the two processes
  });

  it("throws StoreUnavailableError when CAS retries are exhausted", async () => {
    const clock = new ManualClock(0);
    // A client whose conditional writes always fail forces retry exhaustion.
    const stuck: DynamoClientLike = {
      get: (): Promise<Record<string, unknown> | undefined> => Promise.resolve(undefined),
      put: (): Promise<void> => {
        const err = new Error("conditional failed");
        err.name = "ConditionalCheckFailedException";
        return Promise.reject(err);
      },
      delete: (): Promise<void> => Promise.resolve(),
    };
    const store = new DynamoStore({ client: stuck, tableName: "t", clock, maxRetries: 2 });
    await expect(store.apply("k", counter())).rejects.toThrow(/optimistic concurrency exhausted/);
  });

  it("propagates non-conditional errors without retrying", async () => {
    const clock = new ManualClock(0);
    let getCalls = 0;
    const boom: DynamoClientLike = {
      get: (): Promise<Record<string, unknown> | undefined> => {
        getCalls++;
        return Promise.resolve(undefined);
      },
      put: (): Promise<void> => Promise.reject(new Error("ProvisionedThroughputExceeded")),
      delete: (): Promise<void> => Promise.resolve(),
    };
    const store = new DynamoStore({ client: boom, tableName: "t", clock, maxRetries: 5 });
    await expect(store.apply("k", counter())).rejects.toThrow(/ProvisionedThroughputExceeded/);
    expect(getCalls).toBe(1); // a real (non-CAS) error is not retried
  });
});
