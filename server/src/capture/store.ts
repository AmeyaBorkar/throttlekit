/**
 * The durable **encrypted** segment store. Each {@link CaptureSegment} is serialized and sealed with
 * **AES-256-GCM** before it touches the disk — there is **no plaintext-on-disk mode**. The GCM auth tag
 * makes every read **tamper-evident** (a modified or wrong-key blob fails the integrity check and throws,
 * never returns silently-wrong data). Retention is enforced by `sweep` (on every write + the admin sweep);
 * a read **refuses** a past-TTL segment but never deletes it, so a read-only `list`/`export` can't silently
 * purge. Filenames carry only an opaque `createdAt` timestamp + random suffix — **no tenant id or key ever
 * appears in a filename** (the scope lives only inside the ciphertext).
 *
 * I/O happens at **flush time** (off the decision path), never on the emit path — `record()` is purely
 * in-memory; this store is driven by the flush loop draining the recorder.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CaptureSegment, DurableConfig, RetentionConfig } from "./types.js";

const IV_BYTES = 12; // AES-GCM standard nonce length
const TAG_BYTES = 16; // GCM auth tag length
/** `seg-<createdAt>-<rand>.bin` — only an epoch-ms timestamp + random; never PII. */
const FILE_RE = /^seg-(\d+)-[0-9a-f]+\.bin$/;

/** A stored segment's handle: its opaque file id + the (non-PII) createdAt timestamp. */
export interface SegmentRef {
  readonly id: string;
  readonly createdAt: number;
}

/** The durable encrypted segment store. */
export interface SegmentStore {
  /**
   * Encrypt + persist a segment; returns its opaque id. Sweeps past-TTL files first when `presweep` is
   * `true` (the default — the contract every direct caller relies on). The flush loop passes `false`
   * after sweeping ONCE up front for the whole batch: a segment written this batch is freshly created and
   * cannot be past-TTL, so re-sweeping per write would only repeat the full directory scan (O(K×N)).
   */
  write(segment: CaptureSegment, presweep?: boolean): Promise<string>;
  /** List stored segment handles (timestamps only — **no decryption**), oldest first. */
  list(): Promise<SegmentRef[]>;
  /**
   * Decrypt a segment by id. Throws on tamper / wrong key / past-TTL. Does **not** delete — only `sweep`
   * (and `write`'s pre-sweep) deletes, so a read-only `list`/`export` never silently purges + skips its audit.
   */
  read(id: string): Promise<CaptureSegment>;
  /** Purge every past-TTL segment; returns the count removed. */
  sweep(): Promise<number>;
}

/** Options for {@link createSegmentStore}. */
export interface SegmentStoreOptions {
  /** Time source for TTL (mainly tests). Default the system clock. */
  readonly clock?: { now(): number };
}

/** Create a durable AES-256-GCM segment store under `durable.dir`, retained for `retention.ttlMs`. */
export function createSegmentStore(
  durable: DurableConfig,
  retention: RetentionConfig,
  options: SegmentStoreOptions = {},
): SegmentStore {
  const key = Buffer.from(durable.encryptionKeyHex, "hex");
  const dir = durable.dir;
  const ttlMs = retention.ttlMs;
  const clock = options.clock ?? { now: () => Date.now() };

  const isExpired = (createdAt: number): boolean => clock.now() - createdAt > ttlMs;

  async function listRefs(): Promise<SegmentRef[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return []; // dir not created yet ⇒ nothing stored
    }
    const refs: SegmentRef[] = [];
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (m !== null) refs.push({ id: name, createdAt: Number(m[1]) });
    }
    return refs.sort((a, b) => a.createdAt - b.createdAt);
  }

  async function sweep(): Promise<number> {
    let purged = 0;
    for (const ref of await listRefs()) {
      if (isExpired(ref.createdAt)) {
        try {
          await unlink(join(dir, ref.id));
          purged++;
        } catch {
          // a concurrent purge already removed it ⇒ fine
        }
      }
    }
    return purged;
  }

  return {
    async write(segment, presweep = true): Promise<string> {
      await mkdir(dir, { recursive: true });
      // TTL enforced at write — a stale segment never lingers past its window. The flush loop sweeps the
      // batch ONCE before its writes (passing `presweep: false`) so this no longer rescans the directory
      // per segment; a direct caller (`presweep` defaults true) still sweeps past-TTL first, unchanged.
      if (presweep) await sweep();
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const plaintext = Buffer.from(JSON.stringify(segment), "utf8");
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      // On-disk layout: iv ‖ tag ‖ ciphertext — only the sealed blob, never plaintext.
      const blob = Buffer.concat([iv, tag, ciphertext]);
      const id = `seg-${segment.createdAt}-${randomBytes(8).toString("hex")}.bin`;
      await writeFile(join(dir, id), blob);
      return id;
    },

    list: listRefs,

    async read(id): Promise<CaptureSegment> {
      // Validate the id directly against the anchored FILE_RE — same path-traversal guard as listRefs
      // (no `/`, `\`, or `..` can match `^seg-<digits>-<hex>\.bin$`), but O(1): no readdir + scan of the
      // whole directory per read. createdAt is recovered from the id for the TTL check. (The old read()
      // re-ran listRefs per call, making cli `list` — read per ref — O(N^2) in directory syscalls.)
      const m = FILE_RE.exec(id);
      if (m === null) throw new Error(`segment ${JSON.stringify(id)} not found`);
      const createdAt = Number(m[1]);
      // Refuse a past-TTL segment WITHOUT deleting it — only sweep() (and write()'s pre-sweep) delete, so a
      // read-only list/export never silently purges + skips its audit. The next flush's sweep removes it.
      if (isExpired(createdAt)) throw new Error(`segment ${JSON.stringify(id)} is past its TTL`);
      let blob: Buffer;
      try {
        blob = await readFile(join(dir, id)); // ENOENT ⇒ not found (matches the old missing-ref path)
      } catch {
        throw new Error(`segment ${JSON.stringify(id)} not found`);
      }
      if (blob.length < IV_BYTES + TAG_BYTES)
        throw new Error(`segment ${JSON.stringify(id)} is corrupt (truncated blob)`);
      const iv = blob.subarray(0, IV_BYTES);
      const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      // GCM verifies the tag in `final()` — a tampered blob or wrong key throws here, never returns junk.
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(plaintext.toString("utf8")) as CaptureSegment;
    },

    sweep,
  };
}
