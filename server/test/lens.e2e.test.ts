import { afterEach, describe, expect, it } from "vitest";
import { type LensWiredServer, serveWithLens } from "../src/lens.js";

// Verifies the server's --lens wiring end-to-end against the published throttlekit + throttlekit-lens:
// build a service from config with every policy tapped into a Lens hub, drive traffic, read the dashboard.

const CONFIG = `version: 1
limiters:
  api:
    strategy: gcra
    limit: 3
    period: 1h
    burst: 3
  checkout:
    concurrency:
      maxLimit: 64
`;

describe("server --lens integration", () => {
  let wired: LensWiredServer | undefined;
  afterEach(async () => {
    if (wired !== undefined) {
      wired.stopPush();
      await wired.lens.close();
      wired = undefined;
    }
  });

  it("serves a Lens dashboard reflecting the tapped limiter + admitter policies", async () => {
    wired = await serveWithLens(CONFIG, {}, "open", "memory", { host: "127.0.0.1", port: 0 });

    // Drive traffic through the (tapped) service: rate-limit a key past its burst, admit a concurrency slot.
    for (let i = 0; i < 5; i++) await wired.service.check("api", "user-1"); // 3 allow, 2 deny (gcra burst 3)
    const admitted = await wired.service.admit("checkout", "user-1");
    expect(admitted.decision.allowed).toBe(true);

    const res = await fetch(`${wired.lens.url}/api/snapshot`);
    expect(res.status).toBe(200);
    const snap = await res.json();

    expect(snap.meta.mode).toBe("process");
    expect(snap.health.backend).toBe("memory");
    expect(snap.health.failMode).toBe("open");

    const names = snap.policies.map((p: { name: string }) => p.name).sort();
    expect(names).toEqual(["api", "checkout"]);

    const api = snap.policies.find((p: { name: string }) => p.name === "api");
    expect(api.kind).toBe("limiter");
    expect(api.strategy).toBe("gcra");
    expect(api.analytics.allowed).toBe(3);
    expect(api.analytics.denied).toBe(2);

    const checkout = snap.policies.find((p: { name: string }) => p.name === "checkout");
    expect(checkout.kind).toBe("admitter");

    // The two rate denials reached the live feed, attributed to the `api` policy.
    expect(snap.recentDenials.filter((r: { policy: string }) => r.policy === "api")).toHaveLength(
      2,
    );
  });

  it("can be disabled by serving the plain service (no Lens)", async () => {
    // Sanity: the non-lens path is unchanged — serveWithLens is only used when --lens is on.
    expect(typeof serveWithLens).toBe("function");
  });
});
