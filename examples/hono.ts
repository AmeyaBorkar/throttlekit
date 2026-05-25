/**
 * Hono v4 adapter (honoRateLimit). Like the fetch/edge adapter, a Hono app is invoked directly via
 * `app.fetch(request)` — no listening server — so this example is fully runnable and self-contained.
 * On allow it sets the rate-limit headers and forwards; on deny it returns 429 with Retry-After.
 *
 * Requires the optional `hono` peer dependency.
 * Run with:  npx tsx examples/hono.ts
 */

import { Hono } from "hono";
import { honoRateLimit } from "../src/adapters/hono";
import { gcra } from "../src/index";

const app = new Hono();

// Gate every route. The default key derives from cf-connecting-ip → x-forwarded-for → "anon".
app.use(
  "*",
  honoRateLimit({
    strategy: gcra({ limit: 3, periodMs: 10_000 }),
    fail: "open", // allow if the store is unreachable ("open" | "closed")
    emit: { draft: true }, // IETF draft RateLimit headers
    onLimited: (c, d) => console.warn("limited", c.req.path, "retryAfterMs:", d.retryAfterMs),
  }),
);

app.get("/", (c) => c.json({ ok: true }));

// Fire 4 requests from the same client through app.fetch. With a limit of 3, the 4th is a 429.
async function demo(): Promise<void> {
  for (let i = 1; i <= 4; i++) {
    const res = await app.fetch(
      new Request("https://example.com/", { headers: { "cf-connecting-ip": "203.0.113.5" } }),
    );
    console.log(
      `#${i} status: ${res.status}`,
      "remaining:",
      res.headers.get("RateLimit-Remaining"),
      "retry-after:",
      res.headers.get("Retry-After") ?? "—",
    );
  }
}

void demo();
