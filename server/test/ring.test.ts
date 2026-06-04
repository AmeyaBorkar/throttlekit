import { describe, expect, it } from "vitest";
import { RingBuffer } from "../src/monitor/ring.js";

describe("RingBuffer", () => {
  it("retains insertion order until full", () => {
    const r = new RingBuffer<number>(3);
    r.push(1);
    r.push(2);
    expect(r.toArray()).toEqual([1, 2]);
    expect(r.size).toBe(2);
  });

  it("overwrites the oldest once at capacity (the O(1) ring)", () => {
    const r = new RingBuffer<number>(3);
    for (const n of [1, 2, 3, 4, 5]) r.push(n);
    expect(r.toArray()).toEqual([3, 4, 5]);
    expect(r.size).toBe(3);
  });

  it("clamps capacity to at least 1", () => {
    const r = new RingBuffer<number>(0);
    r.push(1);
    r.push(2);
    expect(r.toArray()).toEqual([2]);
  });

  it("clears", () => {
    const r = new RingBuffer<number>(2);
    r.push(1);
    r.clear();
    expect(r.toArray()).toEqual([]);
    expect(r.size).toBe(0);
  });
});
