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
import { RedisStore } from "throttlekit/redis";
import type { RedisClientLike } from "throttlekit/redis";

/** How the served policies are backed. With no `redisUrl`, each policy uses a private in-process store. */
export interface StoreSpec {
  /** Redis connection URL (e.g. `redis://localhost:6379`). Absent ⇒ in-process memory (single instance). */
  redisUrl?: string;
  /** Optional key prefix applied across the shared store (on top of each policy's own prefix). */
  redisPrefix?: string;
}

/** A resolved store plus a disposer for any resources it owns (the Redis connection). */
export interface ResolvedStore {
  /** The shared store to back every policy, or `undefined` to use per-policy in-process memory. */
  store?: Store;
  /** Whether a distributed (Redis) store was built. */
  distributed: boolean;
  /** Release the store's resources (close the Redis connection). */
  dispose(): Promise<void>;
}

/**
 * Build the backing store. With a `redisUrl`, every policy shares one {@link RedisStore} so all server
 * instances pointed at that Redis enforce one fleet-wide limit. The client connects lazily, so this is
 * safe to call before Redis is reachable.
 */
export function createStore(spec: StoreSpec): ResolvedStore {
  if (spec.redisUrl === undefined) {
    return { distributed: false, dispose: async () => {} };
  }
  const client = new Redis(spec.redisUrl, { lazyConnect: true });
  const store = new RedisStore({
    // ioredis satisfies RedisClientLike structurally (see throttlekit/redis `fromIoredis`).
    client: client as unknown as RedisClientLike,
    ...(spec.redisPrefix !== undefined ? { prefix: spec.redisPrefix } : {}),
  });
  return {
    store,
    distributed: true,
    dispose: async () => {
      client.disconnect();
    },
  };
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
