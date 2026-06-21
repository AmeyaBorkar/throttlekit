import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type VectorDocument, buildDocument } from "../../wire/vectors/vectors";

/**
 * The golden-vector lock. `wire/vectors/golden-vectors.json` is the language-neutral conformance
 * contract every ThrottleKit surface (the future gRPC service, polyglot clients) is checked against.
 * This test regenerates the document from the shipped Node core and asserts the committed file still
 * matches — so the wire BEHAVIOR cannot drift silently: any change to a strategy's decisions fails
 * here, forcing a deliberate `npm run wire:vectors` + a reviewed diff (and, on a real break, a
 * `contractVersion` bump). It is also the Node library's regression net over the exact reply values.
 *
 * `generatedFrom` (the package version) is normalised out — a version bump must NOT force a regen.
 */
const VECTORS_PATH = join(__dirname, "../../wire/vectors/golden-vectors.json");

function normalize(doc: VectorDocument): Omit<VectorDocument, "generatedFrom"> {
  const { generatedFrom: _ignored, ...rest } = doc;
  return rest;
}

describe("wire conformance vectors", () => {
  const committed = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as VectorDocument;
  const fresh = buildDocument();

  it("the committed golden vectors match the current core (run `npm run wire:vectors` if intentional)", () => {
    expect(normalize(fresh)).toEqual(normalize(committed));
  });

  it("declares an unfrozen v1 contract (the wire is not formally frozen yet — bet #78)", () => {
    expect(committed.contractVersion).toBe("1");
    expect(committed.frozen).toBe(false);
    expect(committed.decisionFields).toEqual([
      "allowed",
      "limit",
      "remaining",
      "resetAt",
      "retryAfterMs",
    ]);
  });

  it("pins the GCRA cold-burst boundary (5 admits from a burst of 5, then a paced denial)", () => {
    const suite = fresh.suites.find((s) => s.name === "gcra/burst5-rate10ps");
    expect(suite).toBeDefined();
    if (suite === undefined || suite.primitive === "lease")
      throw new Error("expected a rate suite");
    const allowed = suite.ops.map((o) => o.expect.allowed);
    expect(allowed.slice(0, 6)).toEqual([true, true, true, true, true, false]);
    // the denied 6th request is paced one emission interval (T = periodMs/limit = 100ms) out
    expect(suite.ops[5]?.expect.retryAfterMs).toBe(100);
  });

  it("no rateLimit op uses now=0 — the Redis Lua reads ARGV[1]=0 as the server-clock sentinel", () => {
    // A raw-Lua RedisBackend replays each op with ARGV[1]=op.now. The vendored check scripts overload
    // ARGV[1]=0 to mean "read the Redis server TIME", so a now=0 op is unreproducible: real Lua would
    // substitute the live epoch and the resetAt assertion would never match. Keeping every rateLimit op
    // non-zero lets a port pass `now` literally — making the README's "runs the same vendored Lua …
    // round-trips correctly" claim true for every rateLimit op. (tokenBudget/lease have no extracted Lua.)
    for (const suite of fresh.suites) {
      if (suite.primitive !== "rateLimit") continue;
      for (const op of suite.ops) {
        expect(
          op.now,
          `${suite.name} has a now=0 op (collides with the Lua server-clock sentinel)`,
        ).not.toBe(0);
      }
    }
  });

  it("pins tokenBudget stop-at-boundary (a crossing debit is admitted in full; the next is refused)", () => {
    const suite = fresh.suites.find((s) => s.name === "tokenBudget/crossing-debit");
    if (suite === undefined || suite.primitive === "lease")
      throw new Error("expected a tokenBudget suite");
    const [first, crossing, after] = suite.ops;
    expect(first?.expect.allowed).toBe(true); // served 80, remaining 20
    expect(crossing?.expect.allowed).toBe(true); // debit 50 admitted in full → served 130
    expect(crossing?.expect.remaining).toBe(0);
    expect(after?.expect.allowed).toBe(false); // served 130 >= 100 → refused
  });
});
