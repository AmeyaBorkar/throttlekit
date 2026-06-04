import { describe, expect, it } from "vitest";
import { RingBuffer } from "../src/ring.js";

describe("RingBuffer", () => {
  it("retains items oldest-first while under capacity", () => {
    const r = new RingBuffer<number>(4);
    r.push(1);
    r.push(2);
    r.push(3);
    expect(r.size).toBe(3);
    expect(r.toArray()).toEqual([1, 2, 3]);
  });

  it("overwrites the oldest once full, keeping the newest N oldest-first", () => {
    const r = new RingBuffer<number>(3);
    for (let i = 1; i <= 7; i++) r.push(i);
    expect(r.size).toBe(3);
    expect(r.toArray()).toEqual([5, 6, 7]);
  });

  it("stays bounded across a large append stream (O(1) push, never grows)", () => {
    const r = new RingBuffer<number>(200);
    for (let i = 0; i < 100_000; i++) r.push(i);
    expect(r.size).toBe(200);
    const arr = r.toArray();
    expect(arr).toHaveLength(200);
    expect(arr[0]).toBe(99_800);
    expect(arr[199]).toBe(99_999);
  });

  it("clear() empties it and it keeps working afterward", () => {
    const r = new RingBuffer<string>(2);
    r.push("a");
    r.push("b");
    r.clear();
    expect(r.size).toBe(0);
    expect(r.toArray()).toEqual([]);
    r.push("c");
    expect(r.toArray()).toEqual(["c"]);
  });

  it("treats a zero/negative capacity as 1 (always retains the latest)", () => {
    const r = new RingBuffer<number>(0);
    r.push(1);
    r.push(2);
    expect(r.size).toBe(1);
    expect(r.toArray()).toEqual([2]);
  });
});
