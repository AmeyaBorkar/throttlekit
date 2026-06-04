/**
 * Deployment wiring for the server: building the backing **store** (memory or a shared Redis) and the
 * server **credentials** (insecure, TLS, or mTLS) from plain options. Kept apart from `bin.ts` so the
 * arg → resource mapping is unit-testable without standing up Redis or a TLS handshake.
 *
 * The distributed value of the service door is realised here: pointing every server instance at the
 * **same Redis** makes them one fleet enforcing one limit — the decision still runs server-side in Lua
 * (the core), and instances coordinate through the shared store.
 */

import { readFileSync } from "node:fs";

import * as grpc from "@grpc/grpc-js";
import { Redis } from "ioredis";
import type { Store } from "throttlekit";
import { DynamoStore } from "throttlekit/dynamodb";
import type {
  DynamoClientLike,
  DynamoDeleteInput,
  DynamoGetInput,
  DynamoPutInput,
} from "throttlekit/dynamodb";
import { PostgresStore } from "throttlekit/postgres";
import type { PgPoolLike } from "throttlekit/postgres";
import { RedisStore } from "throttlekit/redis";
import type { RedisClientLike } from "throttlekit/redis";

/** Which backend holds the limiter state. `memory` is per-policy in-process; the rest are shared. */
export type StoreType = "memory" | "redis" | "postgres" | "dynamodb";

/**
 * How the served policies are backed. `store` selects the backend explicitly; when omitted it is
 * inferred from the lone connection signal (a `postgresUrl` ⇒ postgres, a `redisUrl` ⇒ redis, a
 * `dynamodbTable` ⇒ dynamodb, else memory) so the legacy `--redis <url>`-only invocation keeps working.
 */
export interface StoreSpec {
  /** Explicit backend. Omit to infer from which connection signal is present (back-compat). */
  store?: StoreType;
  /** Redis connection URL (e.g. `redis://localhost:6379`). */
  redisUrl?: string;
  /** Optional key prefix applied across the shared Redis store (on top of each policy's own prefix). */
  redisPrefix?: string;
  /** Postgres connection URL (e.g. `postgres://user:pass@localhost:5432/db`). */
  postgresUrl?: string;
  /** Table holding limiter state (default `throttlekit`). */
  postgresTable?: string;
  /** Optional key prefix applied across the shared Postgres store. */
  postgresPrefix?: string;
  /** DynamoDB table name (its presence is the dynamodb signal; provision it unless `dynamodbCreateTable`). */
  dynamodbTable?: string;
  /** AWS region for the DynamoDB store (else the SDK's default chain / `AWS_REGION`). */
  dynamodbRegion?: string;
  /** Override the DynamoDB endpoint — e.g. `http://localhost:8000` for dynamodb-local. */
  dynamodbEndpoint?: string;
  /** Optional key prefix applied across the shared DynamoDB store. */
  dynamodbPrefix?: string;
  /** Create the table (a single `pk` string partition key, on-demand billing) if absent, then wait for
   * it to become active. A dev/local convenience — production usually points at a pre-provisioned table. */
  dynamodbCreateTable?: boolean;
}

/** A resolved store plus a disposer for any resources it owns (a Redis connection / a pg Pool). */
export interface ResolvedStore {
  /** The shared store to back every policy, or `undefined` to use per-policy in-process memory. */
  store?: Store;
  /** Which backend was built. */
  mode: StoreType;
  /** Whether a distributed (non-memory) store was built. */
  distributed: boolean;
  /** Release the store's resources (close the Redis connection / end the pg Pool). */
  dispose(): Promise<void>;
}

/**
 * Resolve the effective backend. An explicit `store` wins; otherwise infer it from the lone connection
 * signal. More than one signal with no explicit `store` is rejected so a stray flag can't silently pick
 * the wrong backend.
 */
export function resolveStoreType(spec: StoreSpec): StoreType {
  if (spec.store !== undefined) return spec.store;
  const inferred: StoreType[] = [
    spec.redisUrl !== undefined ? "redis" : undefined,
    spec.postgresUrl !== undefined ? "postgres" : undefined,
    spec.dynamodbTable !== undefined ? "dynamodb" : undefined,
  ].filter((s): s is StoreType => s !== undefined);
  if (inferred.length > 1) {
    throw new Error(
      `ambiguous store: ${inferred.join(" + ")} all implied; pass --store to choose one`,
    );
  }
  return inferred[0] ?? "memory";
}

/** A `pg.Pool` constructor narrowed to the slice we use (a {@link PgPoolLike} plus async `end`). */
type PgPoolCtor = new (config: { connectionString: string }) => PgPoolLike & {
  end(): Promise<void>;
};

// Lazy + untyped specifier: a Redis-only or memory-only deployment must never require `pg`, and tsc
// must not demand pg's types at build time. The `: string` annotation makes `import()` resolve to
// `any`, keeping this fully decoupled from whether pg is installed.
const PG_MODULE: string = "pg";

async function loadPgPoolCtor(): Promise<PgPoolCtor> {
  type PgModule = { Pool?: PgPoolCtor; default?: { Pool?: PgPoolCtor } };
  let mod: PgModule;
  try {
    mod = (await import(PG_MODULE)) as PgModule;
  } catch {
    throw new Error(
      "--store postgres needs the 'pg' package, which is not installed. Run `npm install pg`.",
    );
  }
  const Pool = mod.Pool ?? mod.default?.Pool;
  if (Pool === undefined) throw new Error("the 'pg' module did not export a Pool constructor");
  return Pool;
}

// The minimal slices of the AWS SDK v3 the DynamoDB door uses, so the untyped lazy imports below stay
// type-checked without depending on @aws-sdk types at build time.
interface DdbClient {
  send(command: unknown): Promise<{ Item?: Record<string, unknown> }>;
  destroy(): void;
}
interface AwsDdbClientModule {
  DynamoDBClient: new (config: { region?: string; endpoint?: string }) => DdbClient;
  CreateTableCommand: new (input: unknown) => unknown;
  waitUntilTableExists: (
    cfg: { client: DdbClient; maxWaitTime: number },
    params: { TableName: string },
  ) => Promise<unknown>;
}
interface AwsDdbLibModule {
  DynamoDBDocumentClient: { from(client: DdbClient): DdbClient };
  GetCommand: new (input: DynamoGetInput) => unknown;
  PutCommand: new (input: DynamoPutInput) => unknown;
  DeleteCommand: new (input: DynamoDeleteInput) => unknown;
}

// Lazy, untyped specifiers (same rationale as pg): the AWS SDK is a large dependency only a
// `--store dynamodb` deployment needs, and tsc must not demand its types at build time.
const AWS_DDB_CLIENT_MODULE: string = "@aws-sdk/client-dynamodb";
const AWS_DDB_LIB_MODULE: string = "@aws-sdk/lib-dynamodb";

/** Create the single-`pk` table (on-demand billing) if it doesn't already exist, then wait for it. */
async function ensureDynamoTable(
  ddb: DdbClient,
  CreateTableCommand: AwsDdbClientModule["CreateTableCommand"],
  waitUntilTableExists: AwsDdbClientModule["waitUntilTableExists"],
  table: string,
): Promise<void> {
  try {
    await ddb.send(
      new CreateTableCommand({
        TableName: table,
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );
  } catch (err) {
    // The table already exists ⇒ idempotent no-op; anything else is a real failure.
    const name =
      typeof err === "object" && err !== null ? (err as { name?: unknown }).name : undefined;
    if (name !== "ResourceInUseException") throw err;
  }
  await waitUntilTableExists({ client: ddb, maxWaitTime: 30 }, { TableName: table });
}

/** Build a DynamoDB-backed store + its disposer, lazily loading the AWS SDK and adapting its doc client. */
async function buildDynamoStore(
  spec: StoreSpec,
): Promise<{ store: Store; dispose: () => Promise<void> }> {
  if (spec.dynamodbTable === undefined) {
    throw new Error("--store dynamodb requires --dynamodb-table <name>");
  }
  let clientMod: AwsDdbClientModule;
  let libMod: AwsDdbLibModule;
  try {
    clientMod = (await import(AWS_DDB_CLIENT_MODULE)) as AwsDdbClientModule;
    libMod = (await import(AWS_DDB_LIB_MODULE)) as AwsDdbLibModule;
  } catch {
    throw new Error(
      "--store dynamodb needs '@aws-sdk/client-dynamodb' and '@aws-sdk/lib-dynamodb', which are not installed. Run `npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb`.",
    );
  }
  const { DynamoDBClient, CreateTableCommand, waitUntilTableExists } = clientMod;
  const { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } = libMod;

  // The SDK client connects lazily on first command, so construction never blocks on a live service.
  const ddb = new DynamoDBClient({
    ...(spec.dynamodbRegion !== undefined ? { region: spec.dynamodbRegion } : {}),
    ...(spec.dynamodbEndpoint !== undefined ? { endpoint: spec.dynamodbEndpoint } : {}),
  });
  const table = spec.dynamodbTable;

  if (spec.dynamodbCreateTable === true) {
    await ensureDynamoTable(ddb, CreateTableCommand, waitUntilTableExists, table);
  }

  // The document client + the mechanical pass-through adapter the core documents (its `DynamoClientLike`
  // input shapes are byte-for-byte the SDK command inputs).
  const doc = DynamoDBDocumentClient.from(ddb);
  const client: DynamoClientLike = {
    get: (input: DynamoGetInput) => doc.send(new GetCommand(input)).then((r) => r.Item),
    put: (input: DynamoPutInput) => doc.send(new PutCommand(input)).then(() => undefined),
    delete: (input: DynamoDeleteInput) => doc.send(new DeleteCommand(input)).then(() => undefined),
  };
  const store = new DynamoStore({
    client,
    tableName: table,
    ...(spec.dynamodbPrefix !== undefined ? { prefix: spec.dynamodbPrefix } : {}),
  });
  return {
    store,
    dispose: async () => {
      ddb.destroy();
    },
  };
}

/**
 * Build the backing store. A `redisUrl`/`postgresUrl` (or an explicit `store`) makes every policy
 * share one distributed store, so all instances pointed at it enforce one fleet-wide limit; with
 * neither, each policy uses a private in-process store. Clients connect lazily, so this is safe to
 * call before the backing service is reachable. The decision still runs server-side in the core (the
 * store only transports state), so every backend yields bit-identical decisions.
 */
export async function createStore(spec: StoreSpec): Promise<ResolvedStore> {
  const mode = resolveStoreType(spec);
  switch (mode) {
    case "memory":
      return { mode, distributed: false, dispose: async () => {} };
    case "redis": {
      if (spec.redisUrl === undefined) {
        throw new Error("--store redis requires --redis <url>");
      }
      const client = new Redis(spec.redisUrl, { lazyConnect: true });
      const store = new RedisStore({
        // ioredis satisfies RedisClientLike structurally (see throttlekit/redis `fromIoredis`).
        client: client as unknown as RedisClientLike,
        ...(spec.redisPrefix !== undefined ? { prefix: spec.redisPrefix } : {}),
      });
      return {
        store,
        mode,
        distributed: true,
        dispose: async () => {
          client.disconnect();
        },
      };
    }
    case "postgres": {
      if (spec.postgresUrl === undefined) {
        throw new Error("--store postgres requires --postgres-url <url>");
      }
      const Pool = await loadPgPoolCtor();
      // pg.Pool connects lazily on first query, so constructing it never blocks on a live server.
      const pool = new Pool({ connectionString: spec.postgresUrl });
      const store = new PostgresStore({
        pool,
        ...(spec.postgresTable !== undefined ? { table: spec.postgresTable } : {}),
        ...(spec.postgresPrefix !== undefined ? { prefix: spec.postgresPrefix } : {}),
      });
      return {
        store,
        mode,
        distributed: true,
        dispose: async () => {
          await pool.end();
        },
      };
    }
    case "dynamodb": {
      const { store, dispose } = await buildDynamoStore(spec);
      return { store, mode, distributed: true, dispose };
    }
  }
}

/** TLS material. With `caPath` present, client certificates are required and verified (mTLS). */
export interface TlsSpec {
  /** PEM server certificate chain. */
  certPath?: string;
  /** PEM server private key. */
  keyPath?: string;
  /** PEM CA bundle to verify client certs against ⇒ enables mTLS. */
  caPath?: string;
}

/** Whether {@link createServerCredentials} will produce a secure (TLS/mTLS) channel for this spec. */
export function isSecure(spec: TlsSpec): boolean {
  return spec.certPath !== undefined && spec.keyPath !== undefined;
}

/**
 * Build gRPC server credentials: **insecure** when no cert/key is given (loopback/dev only), **TLS** with
 * a cert + key, and **mTLS** when a `caPath` is also supplied (client certs required and verified).
 */
export function createServerCredentials(spec: TlsSpec): grpc.ServerCredentials {
  if (!isSecure(spec) || spec.certPath === undefined || spec.keyPath === undefined) {
    return grpc.ServerCredentials.createInsecure();
  }
  const certChain = readFileSync(spec.certPath);
  const privateKey = readFileSync(spec.keyPath);
  const rootCerts = spec.caPath !== undefined ? readFileSync(spec.caPath) : null;
  return grpc.ServerCredentials.createSsl(
    rootCerts,
    [{ private_key: privateKey, cert_chain: certChain }],
    spec.caPath !== undefined, // checkClientCertificate ⇒ mTLS when a CA is provided
  );
}
