/**
 * Express adapter: gate routes with a rate limit, emit standards headers, and respond 429 with
 * Retry-After on a denial — with explicit fail-open/closed behavior when the store is unreachable.
 *
 * Requires the optional `express` peer dependency.
 * Run with:  npx tsx examples/express.ts   (then: curl localhost:3000/)
 */

import type { Request } from "express";
import express from "express";
import { expressRateLimit } from "../src/adapters/express";
import { gcra, hmacKeyer } from "../src/index";

const app = express();

// Hash the limit key so a shared store never holds the raw identifier (PII-safe).
const keyer = hmacKeyer(process.env.RL_SECRET ?? "dev-secret");

// Pull an API key from the header when present, else fall back to the client IP.
function keyFor(req: Request): string {
  const apiKey = req.headers["x-api-key"];
  const raw = (Array.isArray(apiKey) ? apiKey[0] : apiKey) ?? req.ip ?? "anon";
  return keyer(raw);
}

app.use(
  expressRateLimit({
    strategy: gcra({ limit: 100, periodMs: 60_000, burst: 20 }),
    key: keyFor,
    // Writes cost more than reads.
    cost: (req) => (req.method === "POST" ? 5 : 1),
    fail: "open", // allow if the store is unreachable ("open" | "closed")
    emit: { draft: true, legacy: true }, // emit both IETF draft and legacy X-RateLimit-* headers
    // Behind a load balancer, trust one proxy hop so the client IP isn't the balancer's.
    trustProxy: 1,
    ipv6Prefix: 64,
    onLimited: (req, _res, d) => {
      console.warn("rate limited", req.method, req.path, "retryAfterMs:", d.retryAfterMs);
    },
  }),
);

app.get("/", (_req, res) => {
  res.json({ ok: true });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`listening on http://localhost:${port}`));
