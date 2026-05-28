/**
 * Smoke tests for the web-platform unifiedAdmission + adaptiveConcurrency adapters
 * (hono, fetch, next, remix, sveltekit, elysia, trpc). The exactly-once-release
 * invariant under fuzzed event orderings is covered in TK-1327's property test;
 * here we cover the basic shape and the deny path.
 */

import { describe, expect, it, vi } from "vitest";
import { elysiaUnifiedAdmission } from "../../src/adapters/elysia";
import { withUnifiedAdmission } from "../../src/adapters/fetch";
import { honoUnifiedAdmission } from "../../src/adapters/hono";
import { nextUnifiedAdmission } from "../../src/adapters/next";
import { remixUnifiedAdmission } from "../../src/adapters/remix";
import { sveltekitUnifiedAdmission } from "../../src/adapters/sveltekit";
import { trpcUnifiedAdmission } from "../../src/adapters/trpc";
import { unifiedAdmission } from "../../src/admission/unified";
import { adaptiveConcurrency } from "../../src/concurrency/adaptive";
import { ManualClock } from "../../src/core/clock";

describe("fetch withUnifiedAdmission", () => {
  it("admits and wraps body — release on stream drain", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const wrapped = withUnifiedAdmission(async () => new Response("ok", { status: 200 }), {
      admitter,
      clock,
    });
    const res = await wrapped(new Request("https://x.example/"));
    expect(res.status).toBe(200);
    expect(guard.inflight).toBe(1);
    // Drain the body — release fires.
    await res.text();
    expect(guard.inflight).toBe(0);
  });

  it("denies: 429, no slot held", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 1, initialLimit: 1, maxLimit: 1 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const wrapped = withUnifiedAdmission(async () => new Response("ok"), { admitter, clock });
    const r1 = await wrapped(new Request("https://x.example/"));
    void r1.text();
    expect(guard.inflight).toBe(1);
    const r2 = await wrapped(new Request("https://x.example/"));
    expect(r2.status).toBe(429);
    expect(r2.headers.get("Retry-After")).not.toBeNull();
  });

  it("null body response: release immediately", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const wrapped = withUnifiedAdmission(async () => new Response(null, { status: 204 }), {
      admitter,
      clock,
    });
    await wrapped(new Request("https://x.example/"));
    expect(guard.inflight).toBe(0);
  });

  it("handler throws: release with dropped=true", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const wrapped = withUnifiedAdmission(
      async () => {
        throw new Error("boom");
      },
      { admitter, clock },
    );
    await expect(wrapped(new Request("https://x.example/"))).rejects.toThrow("boom");
    expect(guard.inflight).toBe(0);
  });
});

describe("hono honoUnifiedAdmission", () => {
  it("admits, calls next(), releases in finally", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const mw = honoUnifiedAdmission({ admitter, clock });

    let nextRan = false;
    // biome-ignore lint/suspicious/noExplicitAny: minimal Hono context mock for unit test
    const c: any = {
      req: { raw: new Request("https://x.example/") },
      res: { status: 200 },
      header: vi.fn(),
      json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
    };
    const next = async (): Promise<void> => {
      nextRan = true;
    };

    await mw(c, next);
    expect(nextRan).toBe(true);
    expect(guard.inflight).toBe(0); // released in finally
  });

  it("denies: 429", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 1, initialLimit: 1, maxLimit: 1 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const mw = honoUnifiedAdmission({ admitter, clock });

    // biome-ignore lint/suspicious/noExplicitAny: minimal Hono context mock
    const c1: any = {
      req: { raw: new Request("https://x.example/") },
      res: { status: 200 },
      header: vi.fn(),
      json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
    };
    // Hold the slot with a pending next() that never resolves until the test ends.
    let releaseNext: () => void = () => {};
    const hold = new Promise<void>((r) => {
      releaseNext = r;
    });
    void mw(c1, () => hold);
    // Let the admit microtask settle (slot is now held).
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(guard.inflight).toBe(1);

    // biome-ignore lint/suspicious/noExplicitAny: minimal Hono context mock
    const c2: any = {
      req: { raw: new Request("https://x.example/") },
      res: { status: 200 },
      header: vi.fn(),
      json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
    };
    const result = await mw(c2, async () => {});
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(429);
    releaseNext();
  });
});

describe("trpc trpcUnifiedAdmission", () => {
  it("admits + releases on procedure success", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const mw = trpcUnifiedAdmission<{ user: string }>({
      admitter,
      key: ({ ctx }) => ctx.user,
    });

    const result = await mw<string>({
      ctx: { user: "alice" },
      next: async () => "ok",
    });
    expect(result).toBe("ok");
    expect(guard.inflight).toBe(0);
  });

  it("procedure throws: release dropped=true", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const mw = trpcUnifiedAdmission<{ user: string }>({
      admitter,
      key: ({ ctx }) => ctx.user,
    });

    await expect(
      mw({
        ctx: { user: "alice" },
        next: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
    expect(guard.inflight).toBe(0);
  });
});

describe("sveltekit sveltekitUnifiedAdmission", () => {
  it("admits + resolves + body drain releases", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const handle = sveltekitUnifiedAdmission({ admitter, clock });

    const event = {
      request: new Request("https://x.example/"),
      getClientAddress: () => "203.0.113.5",
    };
    const resolve = async (): Promise<Response> => new Response("ok");
    const res = await handle({ event, resolve });
    expect(res.status).toBe(200);
    expect(guard.inflight).toBe(1);
    await res.text();
    expect(guard.inflight).toBe(0);
  });
});

describe("next nextUnifiedAdmission", () => {
  it("HOC admits + body drain releases", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const wrapped = nextUnifiedAdmission(async () => new Response("ok"), { admitter, clock });
    const res = await wrapped(new Request("https://x.example/"));
    expect(res.status).toBe(200);
    await res.text();
    expect(guard.inflight).toBe(0);
  });
});

describe("remix remixUnifiedAdmission", () => {
  it("HOC admits + body drain releases", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const wrapped = remixUnifiedAdmission(async ({ request: _request }) => new Response("ok"), {
      admitter,
      clock,
    });
    const res = await wrapped({ request: new Request("https://x.example/") });
    expect(res.status).toBe(200);
    await res.text();
    expect(guard.inflight).toBe(0);
  });
});

describe("elysia elysiaUnifiedAdmission", () => {
  it("wrap admits + releases on body return", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 4, initialLimit: 4, maxLimit: 4 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const admit = elysiaUnifiedAdmission({ admitter, clock });
    const ctx: {
      request: Request;
      set: { status?: number | string; headers: Record<string, string> };
    } = {
      request: new Request("https://x.example/"),
      set: { headers: {} },
    };

    const result = await admit(ctx, async () => "ok");
    expect(result).toBe("ok");
    expect(guard.inflight).toBe(0);
  });

  it("wrap denies: ctx.set.status = 429", async () => {
    const clock = new ManualClock(0);
    const guard = adaptiveConcurrency({ clock, minLimit: 1, initialLimit: 1, maxLimit: 1 });
    const admitter = unifiedAdmission({ concurrency: guard, clock });
    const admit = elysiaUnifiedAdmission({ admitter, clock });
    const mkCtx = (): {
      request: Request;
      set: { status?: number | string; headers: Record<string, string> };
    } => ({
      request: new Request("https://x.example/"),
      set: { headers: {} },
    });
    const ctx1 = mkCtx();
    // Hold the slot via a never-resolving body until we release it.
    let releaseHold: () => void = () => {};
    const hold = new Promise<string>((r) => {
      releaseHold = () => r("done");
    });
    void admit(ctx1, () => hold);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(guard.inflight).toBe(1);

    const ctx2 = mkCtx();
    await admit(ctx2, async () => "no");
    expect(ctx2.set.status).toBe(429);
    releaseHold();
  });
});
