import { ServerCredentials } from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";
import {
  createServerCredentials,
  createStore,
  isSecure,
  resolveStoreType,
  securityLabel,
} from "../src/runtime.js";

/**
 * Unit coverage for the deployment wiring (arg → store/credentials), without standing up Redis,
 * Postgres, or a TLS handshake. The Redis client uses `lazyConnect` and a pg Pool connects lazily on
 * first query, so building + disposing a store needs no live backend.
 */
describe("runtime: store type resolution", () => {
  it("defaults to memory when nothing is given", () => {
    expect(resolveStoreType({})).toBe("memory");
  });

  it("infers redis from a redisUrl", () => {
    expect(resolveStoreType({ redisUrl: "redis://localhost:6379" })).toBe("redis");
  });

  it("infers postgres from a postgresUrl", () => {
    expect(resolveStoreType({ postgresUrl: "postgres://localhost:5432/db" })).toBe("postgres");
  });

  it("infers dynamodb from a dynamodbTable", () => {
    expect(resolveStoreType({ dynamodbTable: "throttlekit" })).toBe("dynamodb");
  });

  it("an explicit store wins over inference", () => {
    expect(resolveStoreType({ store: "memory", redisUrl: "redis://localhost:6379" })).toBe(
      "memory",
    );
  });

  it("rejects an ambiguous redis+postgres spec with no explicit store", () => {
    expect(() =>
      resolveStoreType({
        redisUrl: "redis://localhost:6379",
        postgresUrl: "postgres://localhost:5432/db",
      }),
    ).toThrow(/ambiguous/);
  });

  it("rejects an ambiguous postgres+dynamodb spec with no explicit store", () => {
    expect(() =>
      resolveStoreType({ postgresUrl: "postgres://localhost:5432/db", dynamodbTable: "t" }),
    ).toThrow(/ambiguous/);
  });
});

describe("runtime: store selection", () => {
  it("uses an in-process memory store (no shared store) when no url/store is given", async () => {
    const resolved = await createStore({});
    expect(resolved.store).toBeUndefined();
    expect(resolved.mode).toBe("memory");
    expect(resolved.distributed).toBe(false);
    expect(resolved.makeCoordinator).toBeUndefined(); // memory cannot federate
    expect(resolved.makeConcurrencyCoordinator).toBeUndefined(); // …nor coordinate concurrency
    expect(resolved.makeRegionFairPool).toBeUndefined(); // …nor pool a cross-region fair budget
    await resolved.dispose();
  });

  it("builds a shared Redis store when a redisUrl is given", async () => {
    const resolved = await createStore({ redisUrl: "redis://127.0.0.1:6399", redisPrefix: "tk" });
    expect(resolved.store).toBeDefined();
    expect(resolved.mode).toBe("redis");
    expect(resolved.distributed).toBe(true);
    // A federation coordinator is available over the raw client (constructed without connecting).
    expect(resolved.makeCoordinator).toBeDefined();
    const coordinator = resolved.makeCoordinator?.({ windowMs: 60_000, budgetPerWindow: 100 });
    expect(typeof coordinator?.lease).toBe("function");
    // …and a fleet concurrency coordinator over the same raw client.
    expect(resolved.makeConcurrencyCoordinator).toBeDefined();
    const cc = resolved.makeConcurrencyCoordinator?.({ aggregate: "median" });
    expect(typeof cc?.heartbeat).toBe("function");
    // …and a store-backed cross-region fair pool over the same raw client (the 4th distributed feature).
    expect(resolved.makeRegionFairPool).toBeDefined();
    const rfp = resolved.makeRegionFairPool?.({ limit: 100, windowMs: 60_000, key: "fe" });
    expect(rfp?.isAsync).toBe(true); // the async (network round-trip) RedisRegionFairPool
    expect(typeof rfp?.grant).toBe("function");
    await resolved.dispose(); // disconnect the lazy (never-connected) client
  });

  it("builds a shared Postgres store when a postgresUrl is given (lazy pool, no live server)", async () => {
    const resolved = await createStore({
      postgresUrl: "postgres://throttlekit:throttlekit@127.0.0.1:5499/none",
      postgresTable: "tk_state",
      postgresPrefix: "tk",
    });
    expect(resolved.store).toBeDefined();
    expect(resolved.mode).toBe("postgres");
    expect(resolved.distributed).toBe(true);
    // A federation coordinator is available over the same pool (constructed without querying).
    expect(resolved.makeCoordinator).toBeDefined();
    const coordinator = resolved.makeCoordinator?.({ windowMs: 60_000, budgetPerWindow: 100 });
    expect(typeof coordinator?.lease).toBe("function");
    // …and a fleet concurrency coordinator over the same pool.
    expect(resolved.makeConcurrencyCoordinator).toBeDefined();
    const cc = resolved.makeConcurrencyCoordinator?.({ aggregate: "median" });
    expect(typeof cc?.heartbeat).toBe("function");
    // …but NO cross-region fair pool yet: there is no PostgresRegionFairPool (Redis-only today).
    expect(resolved.makeRegionFairPool).toBeUndefined();
    await resolved.dispose(); // end the lazy pool + stop the coordinators' background GC timers
  });

  it("rejects an explicit --store postgres with no --postgres-url", async () => {
    await expect(createStore({ store: "postgres" })).rejects.toThrow(/--postgres-url/);
  });

  it("rejects an explicit --store redis with no --redis url", async () => {
    await expect(createStore({ store: "redis" })).rejects.toThrow(/--redis/);
  });

  it("builds a DynamoDB store when a dynamodbTable is given (lazy client, no live service)", async () => {
    const resolved = await createStore({
      store: "dynamodb",
      dynamodbTable: "tk_unit",
      dynamodbRegion: "us-east-1",
      dynamodbEndpoint: "http://127.0.0.1:1", // unreachable, but the AWS client connects lazily
      dynamodbPrefix: "tk",
      // dynamodbCreateTable omitted ⇒ no network: just construct the store + adapter.
    });
    expect(resolved.store).toBeDefined();
    expect(resolved.mode).toBe("dynamodb");
    expect(resolved.distributed).toBe(true);
    expect(resolved.makeCoordinator).toBeUndefined(); // dynamodb has no coordinator impl
    expect(resolved.makeConcurrencyCoordinator).toBeUndefined(); // …nor a concurrency one
    expect(resolved.makeRegionFairPool).toBeUndefined(); // …nor a cross-region fair pool
    await resolved.dispose(); // destroy the never-used client
  });

  it("rejects an explicit --store dynamodb with no --dynamodb-table", async () => {
    await expect(createStore({ store: "dynamodb" })).rejects.toThrow(/--dynamodb-table/);
  });
});

describe("runtime: credentials", () => {
  it("isSecure requires both a cert and a key", () => {
    expect(isSecure({})).toBe(false);
    expect(isSecure({ certPath: "c" })).toBe(false);
    expect(isSecure({ keyPath: "k" })).toBe(false);
    expect(isSecure({ certPath: "c", keyPath: "k" })).toBe(true);
  });

  it("returns insecure credentials when no cert/key is provided", () => {
    expect(createServerCredentials({})).toBeInstanceOf(ServerCredentials);
  });

  it("labels the channel by what createServerCredentials actually builds, not flag presence", () => {
    // A CA without a server cert/key cannot honor mTLS: the channel falls back to insecure, so the
    // label must read "insecure" — never "mTLS". (The banner used to key on `--tls-ca` presence and
    // claimed "mTLS" for this fully-unauthenticated plaintext port.)
    expect(securityLabel({ caPath: "/ca.pem" })).toBe("insecure");
    expect(securityLabel({})).toBe("insecure");
    expect(securityLabel({ certPath: "c" })).toBe("insecure");
    expect(securityLabel({ keyPath: "k" })).toBe("insecure");
    expect(securityLabel({ certPath: "c", keyPath: "k" })).toBe("TLS");
    expect(securityLabel({ certPath: "c", keyPath: "k", caPath: "/ca.pem" })).toBe("mTLS");
  });

  it("never advertises more security than createServerCredentials provides", () => {
    // Invariant: label === "insecure" iff the built credentials are the insecure ones. (Cert/key paths
    // that exist would have createServerCredentials read real PEM files, so only the insecure-equivalent
    // specs are exercised against the real builder here.)
    const insecureSpecs = [{}, { caPath: "/ca.pem" }, { certPath: "c" }, { keyPath: "k" }];
    const insecureCtor = createServerCredentials({}).constructor;
    for (const spec of insecureSpecs) {
      expect(securityLabel(spec)).toBe("insecure");
      expect(createServerCredentials(spec).constructor).toBe(insecureCtor);
    }
  });
});
