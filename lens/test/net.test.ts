import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { hostForUrl, listenServer } from "../src/net.js";

describe("hostForUrl", () => {
  it("brackets IPv6 literals and passes other hosts through unchanged", () => {
    expect(hostForUrl("127.0.0.1")).toBe("127.0.0.1");
    expect(hostForUrl("localhost")).toBe("localhost");
    expect(hostForUrl("::1")).toBe("[::1]");
    expect(hostForUrl("fe80::1")).toBe("[fe80::1]");
  });
});

describe("listenServer", () => {
  it("resolves the bound port on an ephemeral bind", async () => {
    const server = createServer();
    const port = await listenServer(server, 0, "127.0.0.1");
    expect(port).toBeGreaterThan(0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("REJECTS on a port clash instead of hanging forever (EADDRINUSE)", async () => {
    const first = createServer();
    const port = await listenServer(first, 0, "127.0.0.1");
    const second = createServer();
    await expect(listenServer(second, port, "127.0.0.1")).rejects.toThrow();
    await new Promise<void>((resolve) => first.close(() => resolve()));
  });
});
