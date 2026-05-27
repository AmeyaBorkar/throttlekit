import { systemClock } from "../core/clock";
import { StoreUnavailableError } from "../core/errors";
import { prefixer } from "../core/key";
import type { Clock, Store, Transform } from "../core/types";

/**
 * Input for a strongly-consistent `GetItem`. The shape mirrors `@aws-sdk/lib-dynamodb`'s `GetCommand`
 * input exactly, so adapting a real client is a pass-through (see {@link DynamoStore} for the adapter).
 */
export interface DynamoGetInput {
  TableName: string;
  Key: Record<string, unknown>;
  /** Always `true` — a stale read would just waste a CAS retry. */
  ConsistentRead: boolean;
}

/** Input for a conditional `PutItem`. Mirrors `@aws-sdk/lib-dynamodb`'s `PutCommand` input. */
export interface DynamoPutInput {
  TableName: string;
  Item: Record<string, unknown>;
  /** The optimistic-concurrency guard; a violation must reject with `ConditionalCheckFailedException`. */
  ConditionExpression: string;
  ExpressionAttributeValues?: Record<string, unknown>;
  ExpressionAttributeNames?: Record<string, string>;
}

/** Input for a `DeleteItem`. Mirrors `@aws-sdk/lib-dynamodb`'s `DeleteCommand` input. */
export interface DynamoDeleteInput {
  TableName: string;
  Key: Record<string, unknown>;
}

/**
 * The minimal slice of a DynamoDB document client ThrottleKit needs: a strongly-consistent read, a
 * conditional put, and a delete — all using document-style (plain JS) attribute values. The input
 * shapes are byte-for-byte the AWS SDK v3 command inputs, so the adapter is mechanical (see
 * {@link DynamoStore}). The contract that makes the store correct: a `put` whose `ConditionExpression`
 * fails **must reject with an error named `"ConditionalCheckFailedException"`** — exactly what the AWS
 * SDK throws.
 */
export interface DynamoClientLike {
  get(input: DynamoGetInput): Promise<Record<string, unknown> | undefined>;
  put(input: DynamoPutInput): Promise<void>;
  delete(input: DynamoDeleteInput): Promise<void>;
}

export interface DynamoStoreOptions {
  /** A document client satisfying {@link DynamoClientLike}. ThrottleKit never closes a client it is given. */
  client: DynamoClientLike;
  /** The DynamoDB table name (you provision the table; there is no sensible default). */
  tableName: string;
  /**
   * The table's partition-key attribute name. Default `"pk"`. The table must have **only** a
   * partition key (no sort key).
   */
  hashKey?: string;
  /** Storage key namespace, prefixed as `prefix:key`. */
  prefix?: string;
  /**
   * Bounded retries for the conditional-write compare-and-set. Default `16`. In-process applies to one
   * key are coalesced (see {@link DynamoStore}), so retries are only spent on genuine cross-process
   * races; `16` tolerates heavy contention on a single hot key.
   */
  maxRetries?: number;
  /**
   * Time source for lazy expiry. Defaults to {@link systemClock}; inject a `ManualClock` to drive
   * expiry deterministically in tests. (DynamoDB's own TTL deletes lazily in the background; this
   * clock decides "expired" for reads, which is what keeps decisions correct meanwhile.)
   */
  clock?: Clock;
}

/** A resolved, never-rejecting promise used to seed the per-key serialization chain. */
const RESOLVED: Promise<void> = Promise.resolve();

/** True when an error is DynamoDB's conditional-write rejection (the signal to re-read and retry). */
function isConditionalCheckFailed(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "ConditionalCheckFailedException"
  );
}

/**
 * Distributed store backed by **DynamoDB**.
 *
 * DynamoDB offers neither a per-key lock nor an interactive transaction across `await` points, so the
 * atomic read-modify-write {@link Store.apply} demands is built from **optimistic concurrency** with a
 * conditional write on a `version` attribute:
 *
 * ```text
 *   GetItem (ConsistentRead)                              -- read state + version; lazy-expire in JS
 *   <run transform(state) in JS>                          -- the same pure code every backend runs
 *   PutItem Item={…, version: v+1}  ConditionExpression="version = :v"     -- commit iff unchanged
 *   -- (or "attribute_not_exists(#pk)" on first touch); ConditionalCheckFailed ⇒ re-read and retry
 * ```
 *
 * The conditional `PutItem` is the compare-and-set: if another process wrote between our read and our
 * write, the condition fails (`ConditionalCheckFailedException`) and we re-read and retry. So N
 * concurrent increments across the fleet land exactly N — like Redis `INCR` — with no lock held. An
 * expired item is overwritten in place by that same CAS (its stale `version` still matches what we
 * read), so expiry needs no separate delete on the hot path.
 *
 * **In-process coalescing.** Every apply takes the CAS loop (DynamoDB has no atomic-command path), so
 * a hot key hammered from one process would CAS-contend with itself and burn write-billed retries.
 * Applies to the same key *from this process* are therefore serialized behind a per-key promise chain
 * — one clean version bump each — while the CAS still reconciles genuine cross-process races. The
 * chain entry is dropped once it drains, bounding the lock map by in-flight keys.
 *
 * **Expiry.** Decisions are kept correct by **lazy expiry** in JS (an item past `expires_at` reads as
 * absent), exactly like the Redis/Postgres backends. `expires_at` is also written in **epoch seconds**
 * so you can enable [DynamoDB TTL](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html)
 * on that attribute and let DynamoDB reclaim storage automatically — no sweep to run. (DynamoDB's TTL
 * deletion can lag hours; lazy expiry is what guarantees correctness in the meantime.)
 *
 * **State** is the same JSON text the Redis optimistic-concurrency and Postgres paths write, so a
 * value round-trips as the exact IEEE-754 double and decisions stay bit-identical across backends.
 *
 * **Table.** Create a table with a single string partition key (default attribute name `pk`) and,
 * optionally, TTL enabled on `expires_at`. Async-only: `limiter.checkSync` throws (use `await
 * limiter.check`).
 *
 * @example Adapting an AWS SDK v3 `DynamoDBDocumentClient` (the adapter is a pass-through):
 * ```ts
 * import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
 * import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
 * import { DynamoStore, type DynamoClientLike } from "throttlekit/dynamodb";
 *
 * const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
 * const client: DynamoClientLike = {
 *   get: (input) => doc.send(new GetCommand(input)).then((r) => r.Item),
 *   put: (input) => doc.send(new PutCommand(input)).then(() => undefined),
 *   delete: (input) => doc.send(new DeleteCommand(input)).then(() => undefined),
 * };
 * const store = new DynamoStore({ client, tableName: "throttlekit" });
 * ```
 */
export class DynamoStore implements Store {
  readonly #client: DynamoClientLike;
  readonly #table: string;
  readonly #hashKey: string;
  readonly #prefixKey: (key: string) => string;
  readonly #clock: Clock;
  readonly #maxRetries: number;
  /** Per-key serialization tails: collapse same-process contention so the CAS only sees real races. */
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(options: DynamoStoreOptions) {
    this.#client = options.client;
    this.#table = options.tableName;
    this.#hashKey = options.hashKey ?? "pk";
    this.#prefixKey = prefixer(options.prefix);
    this.#clock = options.clock ?? systemClock;
    this.#maxRetries = options.maxRetries ?? 16;
  }

  /**
   * Serialize `fn` against other in-process calls for the same key via a promise chain. The tail is
   * dropped once it drains with nothing queued behind it, bounding the lock map by in-flight keys.
   */
  #withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(key) ?? RESOLVED;
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#locks.set(key, tail);
    void tail.then(() => {
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    });
    return run;
  }

  async apply<S, R>(key: string, transform: Transform<S, R>): Promise<R> {
    const fullKey = this.#prefixKey(key);
    return this.#withKeyLock(fullKey, () => this.#applyCas(fullKey, transform));
  }

  /** Optimistic read-modify-write: read item + version, run the transform, commit iff unchanged. */
  async #applyCas<S, R>(fullKey: string, transform: Transform<S, R>): Promise<R> {
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      const now = Math.floor(this.#clock.now());
      const item = await this.#client.get({
        TableName: this.#table,
        Key: { [this.#hashKey]: fullKey },
        ConsistentRead: true,
      });

      // `version` is defined iff an item physically exists (live or expired) — it drives CAS vs
      // first-insert and is the compare token. An expired item yields `undefined` state so the
      // transform restarts, but is still overwritten in place via its stale version (no delete).
      let state: S | undefined;
      let version: number | undefined;
      if (item !== undefined) {
        version = Number(item.version);
        const liveUntilMs = Number(item.expires_at) * 1000;
        state = liveUntilMs > now ? (JSON.parse(item.state as string) as S) : undefined;
      }

      const out = transform(state);
      if (!out.persist) return out.result;

      const ttl = Math.max(1, Math.ceil(out.ttlMs));
      // Stored in epoch SECONDS so DynamoDB TTL can reclaim the item; lazy expiry handles correctness.
      const expiresAtSec = Math.ceil((now + ttl) / 1000);
      const encoded = JSON.stringify(out.state);

      try {
        if (version !== undefined) {
          await this.#client.put({
            TableName: this.#table,
            Item: {
              [this.#hashKey]: fullKey,
              state: encoded,
              expires_at: expiresAtSec,
              version: version + 1,
            },
            ConditionExpression: "version = :v",
            ExpressionAttributeValues: { ":v": version },
          });
        } else {
          await this.#client.put({
            TableName: this.#table,
            Item: {
              [this.#hashKey]: fullKey,
              state: encoded,
              expires_at: expiresAtSec,
              version: 0,
            },
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": this.#hashKey },
          });
        }
        return out.result;
      } catch (err) {
        // Lost the race (another process wrote first); re-read and retry. Anything else propagates.
        if (isConditionalCheckFailed(err)) continue;
        throw err;
      }
    }
    throw new StoreUnavailableError(
      `DynamoStore: optimistic concurrency exhausted ${this.#maxRetries} retries`,
    );
  }

  async reset(key: string): Promise<void> {
    await this.#client.delete({
      TableName: this.#table,
      Key: { [this.#hashKey]: this.#prefixKey(key) },
    });
  }
}
