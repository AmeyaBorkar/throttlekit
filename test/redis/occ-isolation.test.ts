import { describe, expect, it } from "vitest";
import type { Transform } from "../../src/core/types";
import type { RedisClientLike, RedisMultiLike } from "../../src/redis/store";
import { RedisStore } from "../../src/redis/store";

/**
 * The optimistic-concurrency fallback (custom, non-Lua strategies) must isolate each WATCH/MULTI/EXEC
 * transaction on its own connection. Redis WATCH is connection-global and EXEC/UNWATCH clear the
 * ENTIRE watch set, so two concurrent applies that share one connection cross-contaminate: one
 * apply's EXEC tears down the watch protecting an in-flight sibling, letting a concurrent third-party
 * write go undetected (lost update); and a write to one apply's key falsely aborts the other (a
 * spurious retry). The store must acquire a fresh connection (client.duplicate()) per OCC transaction.
 *
 * This is an OFFLINE deterministic regression: a faithful single-connection model of WATCH/MULTI/EXEC
 * (per-connection watch set; EXEC/UNWATCH clear it; a write to a watched key marks its watchers dirty)
 * driven through an explicit step gate, so the contaminating interleaving is reproduced exactly
 * without microtask-timing luck and runs in the default CI gate with no live Redis.
 */

/** A custom (non-Lua) numeric-increment strategy transform — forces the #applyOcc path. */
function inc(): Transform<{ n: number }, number> {
  return ((state: { n: number } | undefined) => {
    const next = (state?.n ?? 0) + 1;
    return { state: { n: next }, result: next, ttlMs: 60_000, persist: true };
  }) as Transform<{ n: number }, number>;
}

/**
 * A controllable async barrier. An op `await gate.wait(label)`; the test `release(label)`s it. Once
 * released, a label latches OPEN so later waits on it (e.g. an OCC retry's repeat of the same step)
 * pass straight through — the test only needs to gate the first crossing of each step.
 */
class StepGate {
  readonly #waiters = new Map<string, () => void>();
  readonly #open = new Set<string>();
  wait(label: string): Promise<void> {
    if (this.#open.has(label)) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.set(label, resolve));
  }
  release(label: string): void {
    this.#open.add(label);
    this.#waiters.get(label)?.();
    this.#waiters.delete(label);
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * One shared Redis key space served by per-connection watch sets, so a duplicate() connection gets
 * its own watch set (the fix) while the shared root connection shares one (the bug). GET and EXEC
 * suspend on a {@link StepGate} keyed by the touched key so the test drives the exact interleaving.
 */
function makeServer(gate: StepGate) {
  const kv = new Map<string, string>();
  const watches = new Map<number, Set<string>>();
  const dirty = new Set<number>();
  let cidSeq = 0;

  const extWrite = (key: string, value: string): void => {
    kv.set(key, value);
    for (const [cid, set] of watches) if (set.has(key)) dirty.add(cid);
  };

  const makeConn = (cid: number): RedisClientLike => {
    watches.set(cid, new Set());
    const conn: RedisClientLike = {
      async watch(...keys: string[]) {
        const set = watches.get(cid)!;
        for (const k of keys) set.add(k);
        return "OK";
      },
      async unwatch() {
        watches.get(cid)!.clear();
        dirty.delete(cid);
        return "OK";
      },
      async get(key: string) {
        await gate.wait(`get:${key}`);
        return kv.get(key) ?? null;
      },
      multi(): RedisMultiLike {
        const writes: Array<[string, string]> = [];
        const m: RedisMultiLike = {
          set(key, value) {
            writes.push([key, value]);
            return m;
          },
          async exec() {
            await gate.wait(`exec:${writes[0]?.[0]}`);
            const wasDirty = dirty.has(cid);
            watches.get(cid)!.clear(); // EXEC clears the connection's whole watch set
            dirty.delete(cid);
            if (wasDirty) return null; // a watched key changed under us → caller retries
            for (const [k, v] of writes) extWrite(k, v);
            return writes.map(() => [null, "OK"] as [Error | null, unknown]);
          },
        };
        return m;
      },
      async del(...keys: string[]) {
        let n = 0;
        for (const k of keys) if (kv.delete(k)) n++;
        return n;
      },
      evalsha() {
        throw new Error("not used on the OCC path");
      },
      eval() {
        throw new Error("not used on the OCC path");
      },
      duplicate() {
        return makeConn(++cidSeq);
      },
    };
    return conn;
  };

  return { client: makeConn(++cidSeq), kv, extWrite };
}

describe("RedisStore OCC isolation (offline, deterministic)", () => {
  it("does not lose a concurrent third-party write to a sibling apply's key (no lost update)", async () => {
    const gate = new StepGate();
    const { client, kv, extWrite } = makeServer(gate);
    const store = new RedisStore({ client, prefix: "occ" });

    // Two concurrent applies on different keys (the checkMany pattern). Both WATCH+GET dispatch.
    const p1 = store.apply("k1", inc());
    const p2 = store.apply("k2", inc());
    await tick();
    // Both reads return nil (key absent), then suspend at their EXEC gate.
    gate.release("get:occ:k1");
    gate.release("get:occ:k2");
    await tick();
    // Commit k1's transaction first. On a shared connection this clears the watch protecting k2.
    gate.release("exec:occ:k1");
    await tick();
    // A third party writes k2 AFTER k1 committed — this MUST be honored, not silently overwritten.
    extWrite("occ:k2", JSON.stringify({ n: 777 }));
    // Now commit k2's transaction.
    gate.release("exec:occ:k2");

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(1);
    // p2's watch must survive p1's EXEC, so its commit aborts, retries, re-reads 777, and writes 778.
    expect(r2).toBe(778);
    expect(kv.get("occ:k2")).toBe(JSON.stringify({ n: 778 }));
  });
});
