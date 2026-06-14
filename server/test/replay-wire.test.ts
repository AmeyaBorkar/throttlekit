import { describe, expect, it } from "vitest";
import { replayService } from "../src/replay/tap.js";
import { wireReplay } from "../src/replay/wire.js";
import { createRateLimiterServiceFromConfig } from "../src/service.js";

/**
 * #299 Server replay P2 — `wireReplay` + the feed tap. One shadow per *leaf-rate* policy (built from its full
 * LimiterSpec, incl. string durations like `period: 1m`); non-leaf policies are not shadowed; an
 * unrebuildable leaf strategy is skipped (not fatal). The tap feeds a live decision into its shadow without
 * changing it. (The core's minimal YAML allows single-level flow maps but not nested ones — block style below.)
 */

const CONFIG = `
limiters:
  api: { strategy: gcra, limit: 100, period: 1m, burst: 20 }
  search: { strategy: fixedWindow, limit: 10, windowMs: 1000 }
  budget:
    tokenBudget:
      budget: 1000
      windowMs: 60000
replay:
  enabled: true
  candidate:
    policy: search
    set:
      limit: 15
`;

describe("wireReplay", () => {
  it("shadows only leaf-rate policies — incl. a `period: 1m` gcra (full-spec rebuild)", () => {
    const w = wireReplay(CONFIG, { now: () => 1000 });
    expect(w.enabled).toBe(true);
    // `api` present ⇒ the raw `period: "1m"` spec rebuilt through buildStrategy. `budget` (tokenBudget) is
    // not leaf-rate, so it is neither shadowed nor "skipped".
    expect([...w.shadows.keys()].sort()).toEqual(["api", "search"]);
    expect(w.shadows.has("budget")).toBe(false);
    expect(w.skipped).toEqual([]);
  });

  it("does not shadow distributed policies (federated / fleetBudget / distributedConcurrency) as plain rate (regression)", () => {
    // The leaf-rate classifier used a stale 4-block subset, so these distributed policies were
    // misclassified as plain rate, shadowed, and produced a silently-wrong what-if baseline.
    const config = [
      "limiters:",
      "  fed:",
      "    strategy: gcra",
      "    limit: 100",
      "    period: 1m",
      "    federated:",
      "      region: us",
      "  fleetb:",
      "    strategy: gcra",
      "    limit: 100",
      "    period: 1m",
      "    fleetBudget:",
      "      budget: 1000",
      "      windowMs: 60000",
      "  dconc:",
      "    strategy: gcra",
      "    limit: 100",
      "    period: 1m",
      "    distributedConcurrency:",
      "      limit: 10",
      "  plain: { strategy: gcra, limit: 100, period: 1m }",
      "replay:",
      "  enabled: true",
    ].join("\n");
    const w = wireReplay(config, { now: () => 1000 });
    expect([...w.shadows.keys()]).toEqual(["plain"]); // only the leaf-rate gcra is shadowed
    expect(w.shadows.has("fed")).toBe(false);
    expect(w.shadows.has("fleetb")).toBe(false);
    expect(w.shadows.has("dconc")).toBe(false);
  });

  it("skips a leaf-rate strategy the testkit can't rebuild (leakyBucket), without crashing", () => {
    const w = wireReplay(
      "limiters:\n  shaped: { strategy: leakyBucket, capacity: 10, refillPerSec: 5 }\nreplay:\n  enabled: true\n",
      { now: () => 1000 },
    );
    expect(w.shadows.has("shaped")).toBe(false);
    expect(w.skipped).toContain("shaped");
  });

  it("feed routes to the matching shadow; an unknown policy is a no-op", () => {
    const w = wireReplay(CONFIG, { now: () => 1000 });
    w.feed("search", "u1");
    w.feed("search", "u1");
    expect(w.shadows.get("search")?.steps).toBe(2);
    expect(() => w.feed("ghost", "x")).not.toThrow();
  });

  it("runs the configured what-if (search limit 10 → 15 loosens the two denials)", () => {
    const w = wireReplay(CONFIG, { now: () => 1000 });
    for (let i = 0; i < 12; i++) w.feed("search", "u1");
    const snap = w.runConfiguredWhatIf();
    expect(snap?.policy).toBe("search");
    expect(snap?.state).toBe("ok");
    expect(snap?.flippedDenyToAllow).toBe(2);
  });

  it("honors a `policies:` whitelist", () => {
    // The core's minimal YAML has no sequences, so a `policies` list is a comma/space-separated string.
    const w = wireReplay(
      "limiters:\n  api: { strategy: gcra, limit: 100, period: 1m }\n  search: { strategy: fixedWindow, limit: 10, windowMs: 1000 }\nreplay:\n  enabled: true\n  policies: search\n",
      { now: () => 1000 },
    );
    expect([...w.shadows.keys()]).toEqual(["search"]);
  });

  it("is inert when disabled (no shadows, feed no-op, no what-if)", () => {
    const w = wireReplay("limiters:\n  api: { strategy: gcra, limit: 100, period: 1m }\n");
    expect(w.enabled).toBe(false);
    expect(w.shadows.size).toBe(0);
    expect(() => w.feed("api", "k")).not.toThrow();
    expect(w.runConfiguredWhatIf()).toBeUndefined();
  });
});

describe("replayService (the feed tap)", () => {
  it("feeds each leaf-rate decision into its shadow, returning the production decision unchanged", async () => {
    const w = wireReplay(CONFIG, { now: () => 1000 });
    const service = createRateLimiterServiceFromConfig(CONFIG, { fail: "open" });
    const wrapped = replayService(service, w);

    const d = await wrapped.check("search", "u1");
    expect(d.allowed).toBe(true); // first request under limit 10 — the real decision, untouched
    expect(w.shadows.get("search")?.steps).toBe(1); // and the shadow recorded it
  });

  it("returns the inner service unwrapped when replay is disabled (zero overhead)", () => {
    const off = wireReplay("limiters:\n  api: { strategy: gcra, limit: 100, period: 1m }\n");
    const bare = createRateLimiterServiceFromConfig(CONFIG, { fail: "open" });
    expect(replayService(bare, off)).toBe(bare);
  });
});
