/**
 * The durable **encrypted** segment store. Each {@link CaptureSegment} is serialized and sealed with
 * **AES-256-GCM** before it touches the disk — there is **no plaintext-on-disk mode**. The GCM auth tag
 * makes every read **tamper-evident** (a modified or wrong-key blob fails the integrity check and throws,
 * never returns silently-wrong data). Retention is enforced at write **and** read: a segment past its TTL
 * is purged and unreadable. Filenames carry only an opaque `createdAt` timestamp + random suffix — **no
 * tenant id or key ever appears in a filename** (the scope lives only inside the ciphertext).
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
  /** Encrypt + persist a segment (sweeping past-TTL files first); returns its opaque id. */
  write(segment: CaptureSegment): Promise<string>;
  /** List stored segment handles (timestamps only — **no decryption**), oldest first. */
  list(): Promise<SegmentRef[]>;
  /** Decrypt a segment by id. Throws on tamper / wrong key / past-TTL (which also purges it). */
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
    async write(segment): Promise<string> {
      await mkdir(dir, { recursive: true });
      await sweep(); // TTL enforced at write — a stale segment never lingers past its window
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
      const ref = (await listRefs()).find((r) => r.id === id);
      if (ref === undefined) throw new Error(`segment ${JSON.stringify(id)} not found`);
      if (isExpired(ref.createdAt)) {
        try {
          await unlink(join(dir, id));
        } catch {
          /* already gone */
        }
        throw new Error(`segment ${JSON.stringify(id)} is past its TTL and was purged`);
      }
      const blob = await readFile(join(dir, id));
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
