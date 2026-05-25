/**
 * Web `fetch` adapter for edge runtimes (Cloudflare Workers, Deno, Bun, Next.js edge). Wraps a
 * `(Request) => Response` handler: on allow it forwards and copies the rate-limit headers onto the
 * response; on deny it returns 429 with Retry-After. No peer dependencies — uses the global
 * Request/Response/Headers (Node 18+).
 *
 * Run with:  npx tsx examples/fetch-edge.ts
 */

import { withRateLimit } from "../src/adapters/fetch";
import { gcra } from "../src/index";

// Your normal handler: receives a Web Request, returns a Web Response.
function handler(req: Request): Response {
  const path = new URL(req.url).pathname;
  return new Response(JSON.stringify({ hello: path }), {
    headers: { "Content-Type": "application/json" },
  });
}

// Wrap it with a rate-limit gate. The default key tries cf-connecting-ip, then x-forwarded-for
// (resolved through the trusted-proxy policy), then "anon".
const fetchHandler = withRateLimit(handler, {
  strategy: gcra({ limit: 30, periodMs: 10_000 }),
  fail: "open",
  emit: { draft: true },
  ipv6Prefix: 64,
});

// A Cloudflare Workers / Deno-style default export.
export default { fetch: fetchHandler };

// Local smoke test: fire a couple of requests through the wrapped handler.
async function demo(): Promise<void> {
  const req = new Request("https://example.com/widgets", {
    headers: { "cf-connecting-ip": "203.0.113.10" },
  });
  const res = await fetchHandler(req);
  console.log("status:", res.status);
  console.log("RateLimit-Remaining:", res.headers.get("RateLimit-Remaining"));
  console.log("body:", await res.text());
}

void demo();
