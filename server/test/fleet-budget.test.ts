import { ManualClock, MemoryStore, ThrottleKitError } from "throttlekit";
import { describe, expect, it } from "vitest";
import { buildServiceConfig } from "../src/config.js";
import { OperationNotSupportedError, createRateLimiterServiceFromConfig } from "../src/service.js";

/**
 * Door B, fleet-shared (the Tier-1 distributed cost axis): a policy with a `fleetBudget` block is served as
 * a windowed token-budget meter via `debit`, exactly like `tokenBudget` — but every server instance pointed
 * at one shared store enforces ONE global budget per key (the core's `distributedTokenBudget`, one oracle).
 *
 * The load-bearing promise is "many instances, one budget, reached over the EXISTING `Debit` RPC with no
 * client change and no wire change." A shared `MemoryStore` across two services models a shared Redis: the
 * decision logic and the store contract are identical; only the store transport differs (and the core's own
 * Redis distributed-budget tests cover that transport). A ManualClock pins every debit to one window.
 */

// One fleet policy: a 10-token-per-window budget shared across the fleet.
const FLEET = JSON.stringify({
  limiters: { tpm: { fleetBudget: { budget: 10, windowMs: 60_000 } } },
});

describe("fleet-shared token-budget (fleetBudget) policies via the service door", () => {
  it("serves a fleetBudget policy via debit on a single instance (private store fallback)", async () => {
    const clock = new ManualClock(0);
    const service = createRateLimiterServiceFromConfig(FLEET, { clock }); // no shared store → private memory
    expect(service.policies()).toEqual(["tpm"]);

    let allowed = 0;
    for (let i = 0; i < 15; i++) if ((await service.debit("tpm", "acme", 1)).allowed) allowed++;
    // Stop-at-boundary, per-token debit: 10 admitted, then the rest refused (Δ = 0), like `tokenBudget`.
    expect(allowed).toBe(10);
  });

  it("two instances over one shared store enforce a single global budget", async () => {
    // Two services sharing ONE store = two server instances pointed at one Redis, same `fleetBudget` policy.
    const clock = new ManualClock(0);
    const store = new MemoryStore();
    const a = createRateLimiterServiceFromConfig(FLEET, { store, clock });
    const b = createRateLimiterServiceFromConfig(FLEET, { store, clock });

    let allowed = 0;
    for (let i = 0; i < 30; i++) {
      const svc = i % 2 === 0 ? a : b; // alternate the "instance" each request
      if ((await svc.debit("tpm", "acme", 1)).allowed) allowed++;
    }
    // ONE budget of 10 across BOTH instances — not 10 per instance. This is the whole promise: the shared
    // store coordinates the fleet, reached through the unchanged `debit` op.
    expect(allowed).toBe(10);
  });

  it("keeps an independent fleet budget per key (honest key-semantics)", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore();
    const a = createRateLimiterServiceFromConfig(FLEET, { store, clock });
    const b = createRateLimiterServiceFromConfig(FLEET, { store, clock });

    for (let i = 0; i < 10; i++) await a.debit("tpm", "acme", 1); // spend acme's fleet budget on instance a
    expect((await b.debit("tpm", "acme", 1)).allowed).toBe(false); // ...seen as spent on instance b too
    expect((await b.debit("tpm", "globex", 1)).allowed).toBe(true); // globex is a separate budget entirely
  });

  it("prefix lets differently-named policies share one fleet budget", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore();
    const config = JSON.stringify({
      limiters: {
        teamA: { fleetBudget: { budget: 10, windowMs: 60_000, prefix: "shared" } },
        teamB: { fleetBudget: { budget: 10, windowMs: 60_000, prefix: "shared" } },
      },
    });
    const service = createRateLimiterServiceFromConfig(config, { store, clock });

    let allowed = 0;
    for (let i = 0; i < 20; i++) {
      const policy = i % 2 === 0 ? "teamA" : "teamB";
      if ((await service.debit(policy, "k", 1)).allowed) allowed++;
    }
    // Both policies resolve store key "shared:k" → ONE shared budget of 10, not 10 + 10.
    expect(allowed).toBe(10);
  });

  it("evicting a fleet meter preserves the budget (state lives in the shared store)", async () => {
    const clock = new ManualClock(0);
    const store = new MemoryStore();
    const config = JSON.stringify({
      limiters: { tpm: { fleetBudget: { budget: 3, windowMs: 60_000, maxKeys: 1 } } },
    });
    const service = createRateLimiterServiceFromConfig(config, { store, clock });

    expect((await service.debit("tpm", "a", 1)).allowed).toBe(true); // a: 1/3
    expect((await service.debit("tpm", "a", 1)).allowed).toBe(true); // a: 2/3
    await service.debit("tpm", "b", 1); // a different key — evicts a's in-process meter (maxKeys = 1)
    expect((await service.debit("tpm", "a", 1)).allowed).toBe(true); // a: 3/3 — rebuilt meter re-reads store
    expect((await service.debit("tpm", "a", 1)).allowed).toBe(false); // a's fleet budget is fully spent
  });

  it("is a meter, not a limiter: check / peek are UNIMPLEMENTED", async () => {
    const service = createRateLimiterServiceFromConfig(FLEET, {});
    await expect(service.check("tpm", "k")).rejects.toBeInstanceOf(OperationNotSupportedError);
    await expect(service.peek("tpm", "k")).rejects.toBeInstanceOf(OperationNotSupportedError);
  });

  it("rejects a policy declaring both tokenBudget and fleetBudget (mutually exclusive)", () => {
    const bad = JSON.stringify({
      limiters: {
        x: {
          tokenBudget: { budget: 1, windowMs: 1000 },
          fleetBudget: { budget: 1, windowMs: 1000 },
        },
      },
    });
    expect(() => buildServiceConfig(bad, {})).toThrow(/at most one of/);
  });

  it("requires both budget and windowMs", () => {
    const bad = JSON.stringify({ limiters: { x: { fleetBudget: { budget: 10 } } } });
    expect(() => buildServiceConfig(bad, {})).toThrow(ThrottleKitError);
    expect(() => buildServiceConfig(bad, {})).toThrow(/fleetBudget: both/);
  });
});
