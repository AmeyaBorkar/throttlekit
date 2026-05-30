# `wire/` — the cross-language conformance contract

This directory holds the **golden conformance vectors**: the language-neutral yardstick that lets a
non-JavaScript surface (the planned gRPC service, a Python/Go client) prove it makes the **same
decisions** as the reference ThrottleKit core — the cross-language extension of the dual-path
(JS ≡ Lua) conformance the library already ships.

> **Status: experimental, NOT frozen.** `golden-vectors.json` carries `"frozen": false`. The raw wire
> (Lua script names, ARGV, the `Decision` reply tuple, state encoding, key scheme) is documented and
> behavior-locked here, but **not** yet a frozen contract — that's bet #78, a separate, deliberate
> decision (see `research/polyglot/DESIGN.md`). Treat these vectors as a may-change contract until
> `frozen` flips to `true`.

## The one invariant everything rests on

**Exactly one thing computes a `Decision`: the Node core** — directly, as Lua-in-Redis, or (later)
inside the service. Every other surface is a *pipe*, and these vectors are the single yardstick every
pipe is checked against. No surface re-derives the math. That's what keeps "proven, not claimed" intact
across a repo and a language boundary.

## What's here

| File | Role |
|---|---|
| `vectors/vectors.ts` | The canonical input suites + `buildDocument()` — runs the **shipped core as the oracle** to fill in every expected `Decision`. Pure (no I/O). |
| `vectors/golden-vectors.json` | The committed, language-neutral artifact a port vendors and replays. Generated — do not hand-edit. |
| `generate.ts` | Thin writer: `npm run wire:vectors` → regenerates the JSON. |

The lock lives in [`test/wire/conformance-vectors.test.ts`](../test/wire/conformance-vectors.test.ts):
it regenerates in-memory and fails if the committed JSON has drifted, so wire behavior can't change
silently — a deliberate change forces a regenerate + a reviewed diff, and a real behavioral break
forces a `contractVersion` bump.

## The format

```jsonc
{
  "contractVersion": "1",                 // a port pins to this; bumps only on a behavioral break
  "generatedFrom": "throttlekit@1.0.1",   // provenance only — NOT part of the contract
  "frozen": false,                        // see the status note above
  "decisionFields": ["allowed","limit","remaining","resetAt","retryAfterMs"],
  "suites": [
    {
      "primitive": "rateLimit",
      "name": "gcra/burst5-rate10ps",
      "strategy": { "kind": "gcra", "options": { "limit": 10, "periodMs": 1000, "burst": 5 } },
      "key": "k",
      "ops": [
        { "now": 0, "cost": 1, "expect": { "allowed": true, "limit": 5, "remaining": 4, "resetAt": 100, "retryAfterMs": 0 } }
        // …state accumulates on `key` across the suite's ops
      ]
    },
    {
      "primitive": "tokenBudget",
      "name": "tokenBudget/crossing-debit",
      "options": { "budget": 100, "windowMs": 60000 },
      "ops": [ { "now": 0, "tokens": 80, "expect": { /* … */ } } ]
    }
  ]
}
```

The suites deliberately exercise the **divergence-prone** cases — cold-burst exhaustion, paced denial +
recovery, `cost > 1`, window rollover, **fractional internal state** (the `%.17g` GCRA TAT round-trip),
large real-epoch `now`, and the `tokenBudget` stop-at-boundary crossing debit — because that's where a
re-implementation is most likely to diverge.

## How a port consumes them

1. For each suite, construct the primitive from `strategy.kind` + `options` (or the `tokenBudget`
   options) against a **manual clock**.
2. For each op: set the clock to `now`, run the check/debit with `cost`/`tokens`, and assert the
   returned decision equals `expect` **field-for-field**. (`resetAt`/`retryAfterMs` included.)
3. Run it in the port's own CI, against a **pinned** vector file (checksum-verified) so the two repos
   can never silently drift.

A Redis-backed port doesn't need to re-implement the math at all — it runs the *same* vendored Lua, and
these vectors confirm its marshalling/decoding round-trips correctly.

## Regenerating

```bash
npm run wire:vectors      # rewrites vectors/golden-vectors.json from the current core
```

Only needed when you intentionally change wire behavior or add a suite. CI (`test/wire/`) fails if the
committed file is stale, so you won't forget. The file is excluded from biome formatting (it's
generated) — `generate.ts` owns its shape.
