import { describe, expect, it } from "vitest";
import { remixRateLimit } from "../../src/adapters/remix";
import { fixedWindow } from "../../src/algorithms/fixed-window";
import { ManualClock } from "../../src/core/clock";
import type { Store } from "../../src/core/types";
import { MemoryStore } from "../../src/stores/memory";

const req = (ip = "1.1.1.1"): Request =>
  new Request("https://example.test/", { headers: { "cf-connecting-ip": ip } });

const downStore: Store = {
  apply: () => Promise.reject(new Error("down")),
  reset: () => Promise.resolve(),
};

function guard(extra: Record<string, unknown> = {}) {
  const clock = new ManualClock(0);
  return remixRateLimit({
    strategy: fixedWindow({ limit: 2, windowMs: 60_000 }),
    store: new MemoryStore({ clock, sweepIntervalMs: 0 }),
    clock,
    ...extra,
  });
}

/** Run the guard and capture either resolved headers or the thrown Response. */
async function run(
  g: ReturnType<typeof remixRateLimit>,
  request: Request,
): Promise<{ headers?: Record<string, string>; thrown?: Response }> {
  try {
    return { headers: await g(request) };
  } catch (e) {
    return { thrown: e as Response };
  }
}

describe("remixRateLimit", () => {
  it("resolves to standards headers under the limit", async () => {
    const r = await run(guard(), req());
    expect(r.thrown).toBeUndefined();
    expect(Object.keys(r.headers ?? {}).some((k) => k.toLowerCase().startsWith("ratelimit"))).toBe(
      true,
    );
  });

  it("throws a 429 Response over the limit", async () => {
    const g = guard();
    await g(req());
    await g(req());
    const r = await run(g, req());
    expect(r.thrown).toBeInstanceOf(Response);
    expect(r.thrown?.status).toBe(429);
    const body = (await r.thrown?.json()) as { retryAfterMs: number };
    expect(body.retryAfterMs).toBeGreaterThan(0);
  });

  it("keys distinct clients independently", async () => {
    const g = guard();
    await g(req("1.1.1.1"));
    await g(req("1.1.1.1"));
    expect((await run(g, req("1.1.1.1"))).thrown?.status).toBe(429);
    expect((await run(g, req("2.2.2.2"))).thrown).toBeUndefined(); // different client
  });

  it("fails open (resolves {}) and closed (throws 503) on a store outage", async () => {
    const clock = new ManualClock(0);
    const base = { strategy: fixedWindow({ limit: 1, windowMs: 60_000 }), store: downStore, clock };
    expect((await run(remixRateLimit(base), req())).headers).toEqual({});
    const closed = await run(remixRateLimit({ ...base, fail: "closed" }), req());
    expect(closed.thrown?.status).toBe(503);
  });
});
