/**
 * A fixed-capacity ring buffer: **O(1)** `push` (overwriting the oldest entry once full) and an ordered
 * `toArray()` snapshot (O(size), taken only at snapshot time, off the hot path).
 *
 * The hub records each denial / fence / latency sample from inside the *synchronous* tap that runs on every
 * decision, so `push` MUST be O(1). A naive `Array.prototype.push` + `Array.prototype.shift` ring is O(n)
 * per append once full — which would silently make the documented "O(1) tap" guarantee false under a
 * sustained denial stream. This keeps it O(1).
 */
export class RingBuffer<T> {
  readonly #cap: number;
  #buf: (T | undefined)[] = [];
  #size = 0;
  /** Index of the oldest retained entry. */
  #head = 0;

  constructor(capacity: number) {
    this.#cap = Math.max(1, Math.floor(capacity));
  }

  /** Append `item`, evicting the oldest entry once at capacity. O(1). */
  push(item: T): void {
    if (this.#size < this.#cap) {
      this.#buf[(this.#head + this.#size) % this.#cap] = item;
      this.#size += 1;
      return;
    }
    // Full: overwrite the oldest entry and advance the head past it.
    this.#buf[this.#head] = item;
    this.#head = (this.#head + 1) % this.#cap;
  }

  /** Number of retained entries (≤ capacity). */
  get size(): number {
    return this.#size;
  }

  /** The retained entries, oldest-first. O(size); snapshot-time only, never on the tap path. */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.#size; i++) {
      out.push(this.#buf[(this.#head + i) % this.#cap] as T);
    }
    return out;
  }

  /** Drop all retained entries. */
  clear(): void {
    this.#buf = [];
    this.#size = 0;
    this.#head = 0;
  }
}
