import { describe, expect, it } from "vitest";
import { version } from "../src/index";

describe("throttlekit", () => {
  it("exposes a version string", () => {
    expect(typeof version).toBe("string");
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
