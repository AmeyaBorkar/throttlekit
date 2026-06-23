import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Output,
  main,
  parseArgs,
  runBenchmark,
  runDoctor,
  runReplay,
} from "../../src/cli/index";

function makeSink(): Output & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    log: (l) => stdout.push(l),
    err: (l) => stderr.push(l),
  };
}

describe("parseArgs", () => {
  it("handles --key value, --key=value, and positionals", () => {
    expect(parseArgs(["benchmark", "--iters", "100", "--verbose"])).toEqual({
      positional: ["benchmark"],
      flags: { iters: "100", verbose: true },
    });
    expect(parseArgs(["--config=tk.yaml", "--name", "api", "log.jsonl"])).toEqual({
      positional: ["log.jsonl"],
      flags: { config: "tk.yaml", name: "api" },
    });
  });
});

describe("main dispatch", () => {
  it("prints usage on --help and an error on an unknown command", async () => {
    const a = makeSink();
    expect(await main(["--help"], a)).toBe(0);
    expect(a.stdout.join("\n")).toMatch(/throttlekit <command>/);
    const b = makeSink();
    expect(await main(["wat"], b)).toBe(2);
    expect(b.stderr.join("\n")).toMatch(/unknown command/);
  });
});

describe("runBenchmark", () => {
  it("runs a tiny benchmark and prints the three rows", async () => {
    const o = makeSink();
    expect(await runBenchmark({ iters: 5000, out: o })).toBe(0);
    const text = o.stdout.join("\n");
    expect(text).toMatch(/gcra/);
    expect(text).toMatch(/tokenBucket/);
    expect(text).toMatch(/fixedWindow/);
    expect(text).toMatch(/ns\/op/);
  });
});

describe("runDoctor", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tk-cli-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports node + peers + 'no config' when nothing in cwd", async () => {
    const o = makeSink();
    expect(await runDoctor({ cwd: dir, out: o })).toBe(0);
    expect(o.stdout.some((l) => /Node ≥ 18/.test(l))).toBe(true);
    expect(o.stdout.some((l) => /no \.throttlekit/.test(l))).toBe(true);
    expect(o.stdout[o.stdout.length - 1]).toMatch(/All checks passed/);
  });

  it("validates a .throttlekit.yaml and surfaces its limiters", async () => {
    writeFileSync(
      join(dir, ".throttlekit.yaml"),
      "version: 1\nlimiters:\n  api: { strategy: gcra, limit: 10, period: 1s }\n",
    );
    const o = makeSink();
    expect(await runDoctor({ cwd: dir, out: o })).toBe(0);
    expect(o.stdout.some((l) => l.includes("1 limiter(s) — api"))).toBe(true);
  });

  it("fails when the config is invalid", async () => {
    writeFileSync(join(dir, ".throttlekit.yaml"), "limiters:\n  bad: { strategy: gcra }\n");
    const o = makeSink();
    expect(await runDoctor({ cwd: dir, out: o })).toBe(1);
    expect(o.stdout[o.stdout.length - 1]).toMatch(/Some checks failed/);
  });
});

describe("runReplay", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tk-cli-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs a JSON-lines log through a flag-built limiter and summarises", async () => {
    const lines = ["k1", "k1", "k1", "k1", "k1", "k2"]
      .map((k) => JSON.stringify({ key: k }))
      .join("\n");
    writeFileSync(join(dir, "log.jsonl"), lines);
    const o = makeSink();
    const code = await runReplay(
      parseArgs(["log.jsonl", "--strategy", "gcra", "--limit", "3", "--period", "1m"]),
      { cwd: dir, out: o },
    );
    expect(code).toBe(0);
    const summary = o.stdout.find((l) => l.startsWith("replay:"));
    expect(summary).toMatch(/total=6/);
    expect(summary).toMatch(/allowed=4/); // 3 of k1 + 1 of k2; k2 has its own budget
    expect(summary).toMatch(/denied=2/); // the 4th and 5th k1
    expect(o.stdout.some((l) => /top denied keys/.test(l))).toBe(true);
  });

  it("treats a value-less --limit as the documented default (100), not limit=1", async () => {
    // parseArgs yields `limit: true` for a value-less flag; that must fall back to
    // the documented default (100), not coerce to Number(true) === 1 and build a
    // degenerate limiter that denies most traffic.
    expect(parseArgs(["log.jsonl", "--strategy", "gcra", "--limit"]).flags.limit).toBe(true);
    const lines = ["k", "k", "k", "k", "k"].map((k) => JSON.stringify({ key: k })).join("\n");
    writeFileSync(join(dir, "log.jsonl"), lines);
    const o = makeSink();
    const code = await runReplay(parseArgs(["log.jsonl", "--strategy", "gcra", "--limit"]), {
      cwd: dir,
      out: o,
    });
    expect(code).toBe(0);
    const summary = o.stdout.find((l) => l.startsWith("replay:"));
    // At the default limit=100 all five cost-1 requests on one key are allowed;
    // a degenerate limit=1 would have allowed 1 and denied 4.
    expect(summary).toMatch(/allowed=5/);
    expect(summary).toMatch(/denied=0/);
  });

  it("skips a line with a non-positive/NaN cost instead of aborting the whole run", async () => {
    // A single cost:0 (or negative/NaN) line must not reject the run: the valid
    // lines either side of it should still be counted and a summary emitted —
    // matching how a malformed-JSON line is skipped via `continue`.
    writeFileSync(
      join(dir, "log.jsonl"),
      [{ key: "a" }, { key: "b", cost: 0 }, { key: "c" }].map((o) => JSON.stringify(o)).join("\n"),
    );
    const o = makeSink();
    const code = await runReplay(
      parseArgs(["log.jsonl", "--strategy", "gcra", "--limit", "100", "--period", "1m"]),
      { cwd: dir, out: o },
    );
    expect(code).toBe(0);
    const summary = o.stdout.find((l) => l.startsWith("replay:"));
    expect(summary).toMatch(/total=2/); // only the two valid lines "a" and "c"
    expect(summary).toMatch(/allowed=2/);
  });

  it("skips a negative cost line too (full requireCost contract)", async () => {
    writeFileSync(
      join(dir, "log.jsonl"),
      [{ key: "a" }, { key: "b", cost: -5 }, { key: "d" }].map((o) => JSON.stringify(o)).join("\n"),
    );
    const o = makeSink();
    const code = await runReplay(
      parseArgs(["log.jsonl", "--strategy", "gcra", "--limit", "100", "--period", "1m"]),
      { cwd: dir, out: o },
    );
    expect(code).toBe(0);
    const summary = o.stdout.find((l) => l.startsWith("replay:"));
    expect(summary).toMatch(/total=2/); // "a" and "d"; the negative-cost "b" skipped
  });

  it("loads a named limiter from --config", async () => {
    writeFileSync(
      join(dir, ".throttlekit.yaml"),
      "version: 1\nlimiters:\n  api: { strategy: gcra, limit: 1, period: 1m }\n",
    );
    writeFileSync(
      join(dir, "log.jsonl"),
      [{ key: "x" }, { key: "x" }].map((o) => JSON.stringify(o)).join("\n"),
    );
    const o = makeSink();
    const code = await runReplay(
      parseArgs(["log.jsonl", "--config", ".throttlekit.yaml", "--name", "api"]),
      { cwd: dir, out: o },
    );
    expect(code).toBe(0);
    expect(o.stdout.find((l) => l.startsWith("replay:"))).toMatch(/allowed=1.*denied=1/);
  });

  it("emits a usage error without a log argument", async () => {
    const o = makeSink();
    expect(await runReplay(parseArgs([]), { cwd: dir, out: o })).toBe(2);
    expect(o.stderr[0]).toMatch(/usage: throttlekit replay/);
  });
});
