/**
 * The flush loop — drains the recorder's in-memory segments to the durable {@link SegmentStore} on a
 * timer, **off the decision path**. It is back-pressured: if a flush is still running when the next tick
 * fires, the tick is skipped (a slow disk can never let flushes pile up), and a write that fails drops
 * that one segment (counted) rather than throwing. `record()` stays purely in-memory; all I/O is here.
 */

import type { CaptureRecorder } from "./recorder.js";
import type { SegmentStore } from "./store.js";

/** The outcome of one flush: how many segments were persisted vs dropped on a write error. */
export interface FlushResult {
  readonly written: number;
  readonly dropped: number;
}

/** The flush loop handle. */
export interface FlushLoop {
  /** Drain the recorder and persist each segment now. A write failure drops that segment (counted). */
  flushOnce(): Promise<FlushResult>;
  /** Start flushing every `intervalMs` (back-pressured; `unref`'d so it never keeps the process alive). */
  start(intervalMs: number): void;
  /** Stop the timer (a final `flushOnce` is the caller's choice on shutdown). */
  stop(): void;
}

/** Create a flush loop that drains `recorder` into `store`. */
export function createFlushLoop(recorder: CaptureRecorder, store: SegmentStore): FlushLoop {
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function flushOnce(): Promise<FlushResult> {
    const segments = recorder.drain();
    let written = 0;
    let dropped = 0;
    if (segments.length > 0) {
      // Sweep past-TTL files ONCE for the whole batch, then write each segment without re-sweeping
      // (`presweep: false`). Every segment we write now is freshly created so it cannot be past-TTL —
      // the single leading sweep enforces retention for the batch, turning O(K segments × N files) into
      // O(N). A sweep fault is best-effort (it never fails the flush — retention catches up next batch).
      try {
        await store.sweep();
      } catch {
        /* best-effort: a sweep fault never fails the flush — the next batch's sweep catches up */
      }
      for (const segment of segments) {
        try {
          await store.write(segment, false);
          written++;
        } catch {
          // A write failure drops that segment, counted — never throws (flush is best-effort + off-path).
          dropped++;
        }
      }
    }
    return { written, dropped };
  }

  return {
    flushOnce,
    start(intervalMs): void {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        if (inFlight) return; // back-pressure: never overlap flushes
        inFlight = true;
        void flushOnce()
          .catch(() => {
            /* best-effort */
          })
          .finally(() => {
            inFlight = false;
          });
      }, intervalMs);
      // Don't let the flush timer hold the event loop open on shutdown.
      timer.unref?.();
    },
    stop(): void {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
