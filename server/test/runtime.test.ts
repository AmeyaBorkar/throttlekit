import { ServerCredentials } from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";
import { createServerCredentials, createStore, isSecure } from "../src/runtime.js";

/**
 * Unit coverage for the deployment wiring (arg → store/credentials), without standing up Redis or a TLS
 * handshake. The Redis client is constructed with `lazyConnect`, so building + disposing a store needs
 * no live server.
 */
describe("runtime: store selection", () => {
  it("uses an in-process memory store (no shared store) when no redisUrl is given", async () => {
    const resolved = createStore({});
    expect(resolved.store).toBeUndefined();
    expect(resolved.distributed).toBe(false);
    await resolved.dispose();
  });

  it("builds a shared Redis store when a redisUrl is given", async () => {
    const resolved = createStore({ redisUrl: "redis://127.0.0.1:6399", redisPrefix: "tk" });
    expect(resolved.store).toBeDefined();
    expect(resolved.distributed).toBe(true);
    await resolved.dispose(); // disconnect the lazy (never-connected) client
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
