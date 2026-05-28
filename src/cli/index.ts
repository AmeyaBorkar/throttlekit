/**
 * `throttlekit` — a small zero-dep CLI:
 *
 *     throttlekit benchmark                  quick in-process micro-benchmark
 *     throttlekit doctor                     env + optional-peer checks; validates .throttlekit.yaml
 *     throttlekit replay <log.jsonl>         re-run a JSON-lines decision log through a configured limiter
 *
 * Run any command with `--help` for its flags. No external dependencies — arg parsing is hand-rolled.
 * Exported functions ({@link main}, {@link runBenchmark}, {@link runDoctor}, {@link runReplay}) take a
 * pluggable {@link Output} so they're testable without touching `process.stdout`.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { fixedWindow } from "../algorithms/fixed-window";
import { gcra } from "../algorithms/gcra";
import { tokenBucket } from "../algorithms/token-bucket";
import { loadConfig } from "../config";
import { parseDuration } from "../core/duration";
import { rateLimit } from "../core/limiter";
import type { Limiter } from "../core/types";
import { MemoryStore } from "../stores/memory";

/** Where the CLI writes its output — swap for an in-memory sink in tests. */
export interface Output {
  log(line: string): void;
  err(line: string): void;
}

const consoleOut: Output = {
  log: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
};

const USAGE = `throttlekit <command> [options]

Commands:
  benchmark                 Quick in-process micro-benchmark (gcra / tokenBucket / fixedWindow)
  doctor                    Environment + optional-peer checks; validates .throttlekit.yaml if present
  replay <log.jsonl>        Re-run a JSON-lines log of { key, cost? } through a configured limiter

Common flags:
  --help, -h                Show this help.
  --version                 Print the throttlekit version.

\`replay\` flags:
  --config FILE             Load a .throttlekit.yaml / .json and select --name (default: "default")
  --name NAME               Limiter name in the config
  --strategy NAME           gcra | fixedWindow | tokenBucket   (when --config isn't used)
  --limit N                 Limit / capacity                  (default 100)
  --period DURATION         "1m" / "30s" / "1h" / ms          (default "1m")`;

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

/** A minimal `--key value` / `--key=value` / positional parser. No external dep. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(n < 10 ? 2 : 0);
}

interface BenchRow {
  label: string;
  opsPerSec: number;
  nsPerOp: number;
}

function timeIt(label: string, iters: number, fn: () => unknown): BenchRow {
  for (let i = 0; i < Math.min(iters, 100_000); i++) fn(); // warmup / JIT
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const ns = Number(process.hrtime.bigint() - t0);
  return { label, opsPerSec: (iters / ns) * 1e9, nsPerOp: ns / iters };
}

/** Quick in-process micro-benchmark across the three single-state strategies. */
export async function runBenchmark(opts: { iters?: number; out?: Output } = {}): Promise<number> {
  const out = opts.out ?? consoleOut;
  const iters = opts.iters ?? 2_000_000;
  out.log(
    `throttlekit benchmark — node ${process.version}, ${iters.toLocaleString()} iters / strategy`,
  );
  const g = rateLimit({
    strategy: gcra({ limit: 1_000_000, periodMs: 60_000 }),
    store: new MemoryStore({ sweepIntervalMs: 0 }),
  });
  const t = rateLimit({
    strategy: tokenBucket({ capacity: 1_000_000, refillPerSec: 1_000_000 }),
    store: new MemoryStore({ sweepIntervalMs: 0 }),
  });
  const f = rateLimit({
    strategy: fixedWindow({ limit: 1_000_000_000, windowMs: 60_000 }),
    store: new MemoryStore({ sweepIntervalMs: 0 }),
  });
  const rows = [
    timeIt("gcra        checkSync", iters, () => g.checkSync("k")),
    timeIt("tokenBucket checkSync", iters, () => t.checkSync("k")),
    timeIt("fixedWindow checkSync", iters, () => f.checkSync("k")),
  ];
  for (const r of rows) {
    out.log(
      `  ${r.label.padEnd(22)} ${fmt(r.opsPerSec).padStart(8)} ops/s   ${r.nsPerOp.toFixed(0).padStart(6)} ns/op`,
    );
  }
  return 0;
}

/** Environment + optional-peer + config checks. Returns 0 when everything passes, 1 otherwise. */
export async function runDoctor(opts: { cwd?: string; out?: Output } = {}): Promise<number> {
  const out = opts.out ?? consoleOut;
  const cwd = opts.cwd ?? process.cwd();
  out.log(`throttlekit doctor — node ${process.version}`);
  let ok = true;

  const nodeMajor = Number(process.version.replace(/^v/, "").split(".")[0] ?? 0);
  const nodeOk = nodeMajor >= 18;
  out.log(`  ${nodeOk ? "✓" : "✗"} Node ≥ 18 (${process.version})`);
  if (!nodeOk) ok = false;

  for (const peer of ["ioredis", "redis", "pg", "@opentelemetry/api", "@nestjs/common"]) {
    try {
      await import(peer);
      out.log(`  ✓ optional peer: ${peer}`);
    } catch {
      out.log(`  ◦ optional peer: ${peer} (not installed — fine unless you use it)`);
    }
  }

  const yamlPath = resolvePath(cwd, ".throttlekit.yaml");
  const jsonPath = resolvePath(cwd, ".throttlekit.json");
  const cfgPath = existsSync(yamlPath) ? yamlPath : existsSync(jsonPath) ? jsonPath : undefined;
  if (cfgPath === undefined) {
    out.log("  ◦ no .throttlekit.yaml / .throttlekit.json in cwd (skipped)");
  } else {
    try {
      const config = loadConfig(readFileSync(cfgPath, "utf8"));
      const names = Object.keys(config.limiters);
      out.log(`  ✓ ${cfgPath}: ${names.length} limiter(s) — ${names.join(", ") || "(none)"}`);
    } catch (err) {
      out.log(`  ✗ ${cfgPath}: ${(err as Error).message}`);
      ok = false;
    }
  }

  out.log(ok ? "\nAll checks passed." : "\nSome checks failed.");
  return ok ? 0 : 1;
}

interface ReplayLine {
  key: string;
  cost?: number;
}

function strategyFromFlags(flags: Record<string, string | true>): Limiter | undefined {
  const strat = typeof flags.strategy === "string" ? flags.strategy : "gcra";
  const limit = Number(flags.limit ?? 100);
  const period = typeof flags.period === "string" ? flags.period : "1m";
  const periodMs = parseDuration(period);
  if (strat === "gcra") return rateLimit({ strategy: gcra({ limit, periodMs }) });
  if (strat === "fixedWindow")
    return rateLimit({ strategy: fixedWindow({ limit, windowMs: periodMs }) });
  if (strat === "tokenBucket")
    return rateLimit({
      strategy: tokenBucket({ capacity: limit, refillPerSec: limit / (periodMs / 1000) }),
    });
  return undefined;
}

/** Re-run a JSON-lines `{ key, cost? }` log through a limiter; print admit/deny + top denied keys. */
export async function runReplay(
  args: ParsedArgs,
  opts: { out?: Output; cwd?: string } = {},
): Promise<number> {
  const out = opts.out ?? consoleOut;
  const cwd = opts.cwd ?? process.cwd();
  const logPath = args.positional[0];
  if (logPath === undefined) {
    out.err(
      "usage: throttlekit replay <log.jsonl> [--config FILE [--name NAME] | --strategy gcra --limit N --period 1m]",
    );
    return 2;
  }

  let limiter: Limiter | undefined;
  if (typeof args.flags.config === "string") {
    const config = loadConfig(readFileSync(resolvePath(cwd, args.flags.config), "utf8"));
    const name = typeof args.flags.name === "string" ? args.flags.name : "default";
    limiter = config.limiters[name];
    if (limiter === undefined) {
      out.err(
        `no limiter "${name}" in ${args.flags.config}; available: ${Object.keys(config.limiters).join(", ")}`,
      );
      return 2;
    }
  } else {
    limiter = strategyFromFlags(args.flags);
    if (limiter === undefined) {
      out.err(
        `unknown --strategy ${String(args.flags.strategy)}; use gcra | fixedWindow | tokenBucket`,
      );
      return 2;
    }
  }

  const raw = readFileSync(resolvePath(cwd, logPath), "utf8");
  let allowed = 0;
  let denied = 0;
  const denies = new Map<string, number>();
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    let parsed: ReplayLine;
    try {
      parsed = JSON.parse(t) as ReplayLine;
    } catch {
      continue;
    }
    if (typeof parsed.key !== "string") continue;
    const cost = typeof parsed.cost === "number" ? parsed.cost : 1;
    const d = await limiter.check(parsed.key, cost);
    if (d.allowed) {
      allowed += 1;
    } else {
      denied += 1;
      denies.set(parsed.key, (denies.get(parsed.key) ?? 0) + 1);
    }
  }
  const total = allowed + denied;
  const denyRate = total === 0 ? 0 : (denied / total) * 100;
  out.log(
    `replay: total=${total} allowed=${allowed} denied=${denied} (${denyRate.toFixed(1)}% deny rate)`,
  );
  if (denies.size > 0) {
    out.log("top denied keys:");
    const top = Array.from(denies.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    for (const [k, n] of top) out.log(`  ${String(n).padStart(6)}  ${k}`);
  }
  return 0;
}

/** Dispatch entry. Returns the process exit code. */
export async function main(argv: readonly string[], out: Output = consoleOut): Promise<number> {
  const cmd = argv[0];
  if (cmd === undefined || cmd === "--help" || cmd === "-h") {
    out.log(USAGE);
    return 0;
  }
  if (cmd === "--version") {
    out.log("0.9.2");
    return 0;
  }
  const rest = parseArgs(argv.slice(1));
  if (rest.flags.help === true || rest.flags.h === true) {
    out.log(USAGE);
    return 0;
  }
  if (cmd === "benchmark") {
    const iters = typeof rest.flags.iters === "string" ? Number(rest.flags.iters) : undefined;
    return runBenchmark({ ...(iters !== undefined ? { iters } : {}), out });
  }
  if (cmd === "doctor") return runDoctor({ out });
  if (cmd === "replay") return runReplay(rest, { out });
  out.err(`unknown command: ${cmd}\n${USAGE}`);
  return 2;
}
