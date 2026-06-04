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
import { PostgresStore } from "throttlekit/postgres";
import type { PgPoolLike } from "throttlekit/postgres";
import { RedisStore } from "throttlekit/redis";
import type { RedisClientLike } from "throttlekit/redis";

/** Which backend holds the limiter state. `memory` is per-policy in-process; the rest are shared. */
export type StoreType = "memory" | "redis" | "postgres";

/**
 * How the served policies are backed. `store` selects the backend explicitly; when omitted it is
 * inferred (a `postgresUrl` ⇒ postgres, else a `redisUrl` ⇒ redis, else memory) so the legacy
 * `--redis <url>`-only invocation keeps working unchanged.
 */
export interface StoreSpec {
  /** Explicit backend. Omit to infer from which connection URL is present (back-compat). */
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
 * Resolve the effective backend. An explicit `store` wins; otherwise infer it from the connection
 * URLs. A Redis **and** a Postgres URL with no explicit `store` is rejected so a stray flag can't
 * silently pick the wrong backend.
 */
export function resolveStoreType(spec: StoreSpec): StoreType {
  if (spec.store !== undefined) return spec.store;
  if (spec.redisUrl !== undefined && spec.postgresUrl !== undefined) {
    throw new Error(
      "ambiguous store: both --redis and --postgres-url were given; pass --store to choose one",
    );
  }
  if (spec.postgresUrl !== undefined) return "postgres";
  if (spec.redisUrl !== undefined) return "redis";
  return "memory";
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
