/**
 * Append-only audit log for the capture admin surface. Every authorized `list`/`export`/`sweep` (and a
 * server `enable`/`flush`) appends one {@link AuditRecord} as a line of JSON — the log is only ever
 * appended to, never rewritten, so it is a durable trail of who touched which scope/policy and when.
 */

import { appendFile, readFile } from "node:fs/promises";
import type { AuditRecord } from "./types.js";

/** A durable append-only audit trail. */
export interface AuditLog {
  /** Append one record (a single JSON line). */
  append(record: AuditRecord): Promise<void>;
  /** Read the full trail, oldest first. A malformed line is skipped (never aborts the read). */
  read(): Promise<AuditRecord[]>;
}

/** Create a JSONL audit log at `path` (created on first append). */
export function createAuditLog(path: string): AuditLog {
  return {
    async append(record): Promise<void> {
      await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
    },
    async read(): Promise<AuditRecord[]> {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch {
        return []; // no log yet
      }
      const out: AuditRecord[] = [];
      for (const line of text.split("\n")) {
        if (line === "") continue;
        try {
          out.push(JSON.parse(line) as AuditRecord);
        } catch {
          // a truncated/corrupt tail line is skipped, not fatal
        }
      }
      return out;
    },
  };
}
