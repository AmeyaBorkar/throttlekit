import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningServer, resolveProtoPath, serve } from "../src/grpc.js";
import { createStore } from "../src/runtime.js";
import { createRateLimiterServiceFromConfig } from "../src/service.js";

/**
 * Gated end-to-end: a real gRPC server backed by a **Postgres** store, assembled through the production
 * store resolver (createStore → createRateLimiterServiceFromConfig → serve). Proves `--store postgres`
 * actually persists limiter state to Postgres and enforces it over the wire. The decision still runs
 * server-side in the core (one oracle); Postgres only transports the state.
 *
 * Gated on THROTTLEKIT_TEST_POSTGRES (a pg connection URL); skipped otherwise. Locally:
 *   docker start tk-postgres   # postgres on :5433 (db/user/pass = throttlekit)
 *   THROTTLEKIT_TEST_POSTGRES=postgres://throttlekit:throttlekit@127.0.0.1:5433/throttlekit \
 *     npx vitest run test/runtime.postgres.e2e.test.ts
 */

const PG_URL = process.env.THROTTLEKIT_TEST_POSTGRES;
const d = PG_URL ? describe : describe.skip;

const TABLE = "tk_server_e2e";
const CONFIG = `
limiters:
  api:
    strategy: fixedWindow
    limit: 3
    period: 1h
`;

type VerifierPool = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
  end: () => Promise<void>;
};

// A throwaway pool used only to set up / inspect the table directly — independent of the resolver's
// own pool, so a "row landed in Postgres" assertion can't be satisfied by an in-process fallback.
async function createVerifierPool(url: string): Promise<VerifierPool> {
  const mod = (await import("pg")) as {
    Pool?: new (c: { connectionString: string }) => VerifierPool;
    default?: { Pool?: new (c: { connectionString: string }) => VerifierPool };
  };
  const Pool = mod.Pool ?? mod.default?.Pool;
  if (Pool === undefined) throw new Error("pg.Pool unavailable");
  return new Pool({ connectionString: url });
}

function makeClient(port: number): {
  client: any;
  call: (m: string, req: unknown) => Promise<any>;
} {
  const def = protoLoader.loadSync(resolveProtoPath(), {
    keepCase: false,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(def) as any;
  const client = new proto.throttlekit.v1.RateLimiter(
    `127.0.0.1:${port}`,
    grpc.credentials.createInsecure(),
  );
  const call = (method: string, req: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      client[method](req, (err: unknown, resp: unknown) => (err ? reject(err) : resolve(resp)));
    });
  return { client, call };
}

d("Postgres-backed server door (gated: THROTTLEKIT_TEST_POSTGRES)", () => {
  let resolved: Awaited<ReturnType<typeof createStore>>;
  let running: RunningServer;
  let h: { client: any; call: (m: string, req: unknown) => Promise<any> };

  beforeAll(async () => {
    // Start clean so a previous run's rows can't mask a regression.
    const setup = await createVerifierPool(PG_URL as string);
    await setup.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await setup.end();

    resolved = await createStore({
      store: "postgres",
      postgresUrl: PG_URL,
      postgresTable: TABLE,
      postgresPrefix: "e2e",
    });
    expect(resolved.mode).toBe("postgres");
    expect(resolved.store).toBeDefined();

    const service = createRateLimiterServiceFromConfig(CONFIG, {
      ...(resolved.store !== undefined ? { store: resolved.store } : {}),
      // A store outage must NOT silently admit — we want a real Postgres round-trip or a loud failure.
      fail: "closed",
    });
    running = await serve({ service, host: "127.0.0.1", port: 0 });
    h = makeClient(running.port);
    await new Promise<void>((resolve, reject) => {
      h.client.waitForReady(Date.now() + 5000, (err: unknown) => (err ? reject(err) : resolve()));
    });
  });

  afterAll(async () => {
    h?.client.close();
    await running?.close();
    await resolved?.dispose();
  });

  it("persists state to Postgres and enforces a fixed-window limit over the wire", async () => {
    const key = `e2e-${Date.now()}`;
    const allowed: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const resp = await h.call("check", { policy: "api", key, cost: 1 });
      allowed.push(resp.decision.allowed);
    }
    // limit 3 within the window ⇒ the first three admit, the rest deny. If the store weren't
    // persisting, every request would see empty state and admit (all true); fail=closed rules out a
    // silent outage masking this.
    expect(allowed).toEqual([true, true, true, false, false]);

    // Prove the state really landed in Postgres (not an in-process fallback): the resolver auto-created
    // the table and it now holds the limiter's key.
    const verifier = await createVerifierPool(PG_URL as string);
    try {
      const res = await verifier.query(`SELECT key FROM ${TABLE}`);
      const keys = (res.rows as Array<{ key: string }>).map((r) => r.key);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.some((k) => k.includes(key))).toBe(true);
    } finally {
      await verifier.end();
    }
  });
});
