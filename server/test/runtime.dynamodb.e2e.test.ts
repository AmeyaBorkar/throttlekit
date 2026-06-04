import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningServer, resolveProtoPath, serve } from "../src/grpc.js";
import { createStore } from "../src/runtime.js";
import { createRateLimiterServiceFromConfig } from "../src/service.js";

/**
 * Gated end-to-end: a real gRPC server backed by **DynamoDB**, assembled through the production store
 * resolver (createStore → createRateLimiterServiceFromConfig → serve). Proves `--store dynamodb`
 * persists limiter state to DynamoDB and enforces it over the wire. The decision still runs server-side
 * in the core (one oracle); DynamoDB only transports the state via its version CAS.
 *
 * Gated on THROTTLEKIT_TEST_DYNAMODB (a DynamoDB endpoint URL); skipped otherwise. Locally:
 *   docker run -d --name tk-dynamodb -p 8000:8000 amazon/dynamodb-local
 *   THROTTLEKIT_TEST_DYNAMODB=http://127.0.0.1:8000 \
 *     npx vitest run test/runtime.dynamodb.e2e.test.ts
 *
 * The resolver's `dynamodbCreateTable` provisions the single-`pk` table; a fresh per-run prefix keeps
 * each invocation's keys distinct (DynamoDB persists across restarts, unlike the memory store).
 */

const DDB_ENDPOINT = process.env.THROTTLEKIT_TEST_DYNAMODB;
const d = DDB_ENDPOINT ? describe : describe.skip;

const REGION = "us-east-1";
const TABLE = "tk_server_e2e_ddb";
const RUN_PREFIX = `e2e-${Date.now()}`;
const CONFIG = `
limiters:
  api:
    strategy: fixedWindow
    limit: 3
    period: 1h
`;

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

/** Scan the table directly (independent of the resolver's client) and return every item's `pk`. */
async function scanPks(endpoint: string): Promise<string[]> {
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, ScanCommand } = await import("@aws-sdk/lib-dynamodb");
  const ddb = new DynamoDBClient({ region: REGION, endpoint });
  const doc = DynamoDBDocumentClient.from(ddb);
  try {
    const res = await doc.send(new ScanCommand({ TableName: TABLE }));
    return (res.Items ?? []).map((it) => String(it.pk));
  } finally {
    ddb.destroy();
  }
}

d("DynamoDB-backed server door (gated: THROTTLEKIT_TEST_DYNAMODB)", () => {
  let resolved: Awaited<ReturnType<typeof createStore>>;
  let running: RunningServer;
  let h: { client: any; call: (m: string, req: unknown) => Promise<any> };

  beforeAll(async () => {
    // dynamodb-local ignores credentials, but the AWS SDK requires them to be present.
    process.env.AWS_ACCESS_KEY_ID ??= "dummy";
    process.env.AWS_SECRET_ACCESS_KEY ??= "dummy";
    process.env.AWS_REGION ??= REGION;

    resolved = await createStore({
      store: "dynamodb",
      dynamodbTable: TABLE,
      dynamodbRegion: REGION,
      dynamodbEndpoint: DDB_ENDPOINT,
      dynamodbPrefix: RUN_PREFIX,
      dynamodbCreateTable: true, // provision the single-pk table if dynamodb-local doesn't have it yet
    });
    expect(resolved.mode).toBe("dynamodb");
    expect(resolved.store).toBeDefined();

    const service = createRateLimiterServiceFromConfig(CONFIG, {
      ...(resolved.store !== undefined ? { store: resolved.store } : {}),
      fail: "closed", // a store outage must NOT silently admit — real DynamoDB or a loud failure
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

  it("persists state to DynamoDB and enforces a fixed-window limit over the wire", async () => {
    const key = `ddb-${Date.now()}`;
    const allowed: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const resp = await h.call("check", { policy: "api", key, cost: 1 });
      allowed.push(resp.decision.allowed);
    }
    // limit 3 within the window ⇒ first three admit, the rest deny. fail=closed rules out a silent
    // memory fallback masking a non-persisting store (which would admit all five).
    expect(allowed).toEqual([true, true, true, false, false]);

    // Prove the state really landed in DynamoDB: the resolver auto-created the table and the version CAS
    // wrote the limiter's (prefixed) key.
    const pks = await scanPks(DDB_ENDPOINT as string);
    expect(pks.length).toBeGreaterThan(0);
    expect(pks.some((pk) => pk.includes(key))).toBe(true);
  });
});
