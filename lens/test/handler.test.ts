import { get } from "node:http";
import { gcra, rateLimit } from "throttlekit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLensHub } from "../src/hub.js";
import { type RunningLens, serveLens } from "../src/serve.js";

const HOUR = 3_600_000;

/** Open an SSE stream and expose `until(marker)` promises over its accumulated buffer. */
function openSse(url: string): {
  until: (marker: string, ms?: number) => Promise<void>;
  close: () => void;
} {
  let buf = "";
  const waiters: Array<{ marker: string; hit: () => void }> = [];
  const req = get(url, (res) => {
    res.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if (w && buf.includes(w.marker)) {
          w.hit();
          waiters.splice(i, 1);
        }
      }
    });
  });
  req.on("error", () => {});
  return {
    until: (marker, ms = 3000) =>
      new Promise<void>((resolve, reject) => {
        if (buf.includes(marker)) {
          resolve();
          return;
        }
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${marker}`)), ms);
        timer.unref();
        waiters.push({
          marker,
          hit: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      }),
    close: () => req.destroy(),
  };
}

describe("serveLens / lensHandler", () => {
  let lens: RunningLens;
  let driveDenial: () => Promise<void>;

  beforeAll(async () => {
    const hub = createLensHub({ windowMs: HOUR });
    const limiter = hub.trackLimiter(
      "api",
      rateLimit({ strategy: gcra({ limit: 1, periodMs: HOUR, burst: 1 }) }),
    );
    driveDenial = async () => {
      await limiter.check("k"); // allow (burst 1)
      await limiter.check("k"); // deny -> pushes a denial event to subscribers
    };
    lens = await serveLens(hub, { port: 0, host: "127.0.0.1", intervalMs: 200 });
  });

  afterAll(async () => {
    await lens.close();
  });

  it("binds to loopback and serves a JSON snapshot", async () => {
    expect(lens.host).toBe("127.0.0.1");
    const res = await fetch(`${lens.url}/api/snapshot`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const snap = await res.json();
    expect(snap.meta.mode).toBe("process");
    expect(Array.isArray(snap.policies)).toBe(true);
  });

  it("serves the static UI at /", async () => {
    const res = await fetch(`${lens.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("ThrottleKit");
    expect(html).toContain("/api/stream");
  });

  it("is read-only: rejects non-GET with 405 and unknown paths with 404", async () => {
    const post = await fetch(`${lens.url}/api/snapshot`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
    const missing = await fetch(`${lens.url}/api/nope`);
    expect(missing.status).toBe(404);
  });

  it("streams an initial snapshot and a live denial over SSE", async () => {
    const stream = openSse(`${lens.url}/api/stream`);
    await stream.until("event: snapshot"); // connected + subscribed before we drive anything
    await driveDenial();
    await stream.until("event: denial");
    stream.close();
  });
});

describe("token auth", () => {
  let lens: RunningLens;
  beforeAll(async () => {
    const hub = createLensHub();
    lens = await serveLens(hub, { port: 0, host: "127.0.0.1", token: "s3cret" });
  });
  afterAll(async () => {
    await lens.close();
  });

  it("401s without the bearer token and 200s with it", async () => {
    const noAuth = await fetch(`${lens.url}/api/snapshot`);
    expect(noAuth.status).toBe(401);
    const authed = await fetch(`${lens.url}/api/snapshot`, {
      headers: { Authorization: "Bearer s3cret" },
    });
    expect(authed.status).toBe(200);
  });
});
