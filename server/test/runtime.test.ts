import { ServerCredentials } from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";
import {
  createServerCredentials,
  createStore,
  isSecure,
  resolveStoreType,
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
});

describe("runtime: store selection", () => {
  it("uses an in-process memory store (no shared store) when no url/store is given", async () => {
    const resolved = await createStore({});
    expect(resolved.store).toBeUndefined();
    expect(resolved.mode).toBe("memory");
    expect(resolved.distributed).toBe(false);
    await resolved.dispose();
  });

  it("builds a shared Redis store when a redisUrl is given", async () => {
    const resolved = await createStore({ redisUrl: "redis://127.0.0.1:6399", redisPrefix: "tk" });
    expect(resolved.store).toBeDefined();
    expect(resolved.mode).toBe("redis");
    expect(resolved.distributed).toBe(true);
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
    await resolved.dispose(); // end the lazy (never-connected) pool
  });

  it("rejects an explicit --store postgres with no --postgres-url", async () => {
    await expect(createStore({ store: "postgres" })).rejects.toThrow(/--postgres-url/);
  });

  it("rejects an explicit --store redis with no --redis url", async () => {
    await expect(createStore({ store: "redis" })).rejects.toThrow(/--redis/);
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
});
