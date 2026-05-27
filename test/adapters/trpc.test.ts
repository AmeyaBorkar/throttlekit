import { describe, expect, it, vi } from "vitest";
import { trpcRateLimit } from "../../src/adapters/trpc";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { ManualClock } from "../../src/core/clock";
import { RateLimitExceededError } from "../../src/core/errors";
import type { Store } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";

interface Ctx {
  ip: string;
}

const downStore: Store = {
  apply: () => Promise.reject(new Error("down")),
  reset: () => Promise.resolve(),
};

function mw(extra: Record<string, unknown> = {}) {
  const clock = new ManualClock(0);
  return trpcRateLimit<Ctx>({
    strategy: fixedWindow({ limit: 2, windowMs: 60_000 }),
    store: new MemoryStore({ clock, sweepIntervalMs: 0 }),
    clock,
    key: ({ ctx }) => ctx.ip,
    ...extra,
  });
}

const next =
  <T>(value: T) =>
  () =>
    Promise.resolve(value);

describe("trpcRateLimit", () => {
  it("calls next() under the limit and returns its value", async () => {
    const rl = mw();
    const result = await rl({ ctx: { ip: "1.1.1.1" }, next: next("ok") });
    expect(result).toBe("ok");
  });

  it("throws RateLimitExceededError over the limit (default)", async () => {
    const rl = mw();
    await rl({ ctx: { ip: "1.1.1.1" }, next: next("ok") });
    await rl({ ctx: { ip: "1.1.1.1" }, next: next("ok") });
    await expect(rl({ ctx: { ip: "1.1.1.1" }, next: next("ok") })).rejects.toBeInstanceOf(
      RateLimitExceededError,
    );
  });

  it("uses a custom errorFactory on denial", async () => {
    class TooMany extends Error {
      code = "TOO_MANY_REQUESTS";
    }
    const rl = mw({ errorFactory: () => new TooMany("slow down") });
    await rl({ ctx: { ip: "1.1.1.1" }, next: next("ok") });
    await rl({ ctx: { ip: "1.1.1.1" }, next: next("ok") });
    await expect(rl({ ctx: { ip: "1.1.1.1" }, next: next("ok") })).rejects.toBeInstanceOf(TooMany);
  });

  it("keys by ctx (distinct callers isolated) and fires onLimited", async () => {
    const onLimited = vi.fn();
    const rl = mw({ onLimited });
    await rl({ ctx: { ip: "1.1.1.1" }, next: next("ok") });
    await rl({ ctx: { ip: "1.1.1.1" }, next: next("ok") });
    await expect(rl({ ctx: { ip: "1.1.1.1" }, next: next("ok") })).rejects.toBeInstanceOf(
      RateLimitExceededError,
    );
    expect(onLimited).toHaveBeenCalledOnce();
    // A different ctx has its own bucket.
    await expect(rl({ ctx: { ip: "2.2.2.2" }, next: next("ok") })).resolves.toBe("ok");
  });

  it("fails open (next) and closed (rethrows) on a store outage", async () => {
    const clock = new ManualClock(0);
    const base = {
      strategy: fixedWindow({ limit: 1, windowMs: 60_000 }),
      store: downStore,
      clock,
      key: ({ ctx }: { ctx: Ctx }) => ctx.ip,
    };
    await expect(
      trpcRateLimit<Ctx>(base)({ ctx: { ip: "1.1.1.1" }, next: next("ok") }),
    ).resolves.toBe("ok");
    await expect(
      trpcRateLimit<Ctx>({ ...base, fail: "closed" })({ ctx: { ip: "1.1.1.1" }, next: next("ok") }),
    ).rejects.toThrow(/down/);
  });
});
