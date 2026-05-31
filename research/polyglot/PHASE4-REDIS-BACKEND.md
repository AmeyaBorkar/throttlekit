# Phase 4 — the direct `RedisBackend` (the second door)

The polyglot design (`DESIGN.md`) reaches non-Node languages through **one core, one contract, two
doors**. Phase 2 built the **service door** (gRPC to a process running the core). Phase 4 builds the
**direct door**: a client that talks to the **same Redis** a Node fleet uses and runs the **same
vendored Lua** the core ships, so its decisions are bit-identical to an embedded Node library — with
one network hop and no extra service. It lives in the `throttlekit-py` repo (the loosely-coupled,
contract-vendoring client), not here.

This is the door that makes the *rigorous* cross-language conformance possible: because the direct path
puts an explicit `now` in `ARGV`, it can replay the **full, time-parametrized** golden vectors and match
every reply field — the proof the cross-process service door structurally couldn't give (the server
uses wall-clock time; there is no `ManualClock` over the wire).

## What landed (in `throttlekit-py`)

- **`RedisBackend(client, strategy, *, prefix="")`** — `check(key, cost=1, *, now=None)` marshals the
  ARGV in the manifest's order, runs the script by `EVALSHA` (with an `EVAL` fallback on `NOSCRIPT`),
  and decodes the five-integer reply tuple into a `Decision`. `now=None` sends the sentinel `0` so the
  script derives time from the **Redis server clock** — the skew-free default a fleet must use.
- **`strategies.py`** — `Gcra` / `TokenBucket` / `FixedWindow` / `SlidingWindow` / `SlidingWindowLog`
  as pure, frozen parameter-holders + a `from_spec(kind, options)` factory. A strategy supplies only the
  **named** ARGV values; the **order** comes from the vendored manifest, so a core ARGV reordering flows
  through on re-vendoring with **no client code change**.
- **Vendored runtime Lua** — `scripts/sync_contract.py` now also copies `wire/scripts/*.lua` +
  `manifest.json` into `src/throttlekit/_scripts/` (shipped in the wheel; see "Packaging").
- **Conformance + gates** — the full-vector replay against real Redis (below), a strategy↔ARGV unit
  gate (no Redis), and an extended drift-gate over the vendored scripts.

## The decision boundary — `check` only (and why)

The Redis **`check`** path runs the entire decision **server-side, in Lua**, so the client inherits the
proof for free. But `peek` / `forecast` in the core run the **read** script and then do the
state→`Decision` math **client-side, in JS** (`strategy.peek(state)`). Reproducing them in Python would
mean **porting that math** — re-deriving a `Decision` in a second place, with float-determinism risk —
which the design's load-bearing invariant forbids ("exactly one thing computes a `Decision`"). So the
`RedisBackend` exposes **`check` only**; `peek` / `forecast` / `check_many` stay on the **service door**,
where the core computes them. This is principled, not a shortcut: the golden vectors only cover the
`rateLimit` `check` primitive, so `check`-only is exactly the contract-covered, no-re-derivation surface.

## The conformance, and the clock-offset insight (the hard part)

`tests/test_redis_backend.py` replays every `rateLimit` suite through Python → vendored Lua → real Redis
and asserts all five reply fields against the Node oracle. The subtlety is the **`now=0` sentinel**: the
vectors were produced by the in-process oracle at `now` values starting at `0`, but on the wire
`ARGV[1] == 0` means "use the Redis `TIME` clock". So a faithful Lua replay must drive a **non-zero**
clock — we add a single offset `BASE` to every op's `now`.

**`BASE = 1000` — the smallest offset that works, and that minimality is the point:**

- It clears the sentinel and is a multiple of every window/bucket width (fixedWindow `1000`, slidingWindow
  bucket `100`), so each strategy's `floor(now/w)` window index shifts rigidly.
- **Keeping the offset minimal keeps the reproduction float-exact.** GCRA's cold-path `remaining` is
  `floor((tau − (new_tat − now)) / T)`, where `new_tat − now` should equal `inc` — but in IEEE-754
  `(now + inc) − now != inc` once `now` is large enough to crowd `inc`'s low mantissa bits, which flips a
  value sitting exactly on a floor boundary (the `gcra/fractional-T` suite, `T = 1000/3`). A large offset
  (`1_000_000`) trips this and produces a `remaining` off by one; `BASE = 1000` stays inside the exact
  range. Empirically, `BASE = 1000` reproduces **all five** fields bit-for-bit across **every** op of
  every suite; `1_000_000` mismatches 12 fields, all in `gcra/fractional-T`.
- This is an **inherent GCRA property**, not a client defect: a real Node fleet running `useServerTime`
  at real epochs sees the same magnitude-dependence. `resetAt` (the one absolute-epoch field) shifts by
  exactly `BASE`; everything else is shift-invariant.

A bonus test asserts the **SHA-1** the client computes for `EVALSHA` is the one Redis caches the script
under — i.e. a Node fleet's `EVALSHA` and the Python client's address the *same* cached script.

## Packaging — the scripts ship inside the wheel

The `.lua` are **runtime data** the backend executes, so they must resolve in an installed package, not
just a source checkout. They are vendored to **`src/throttlekit/_scripts/`** (inside the package) and
loaded package-relative. `contract/` keeps the **dev/test** artifacts (proto → stubs, vectors →
conformance), which are never needed at runtime. Each location carries its own integrity record
(`contract/manifest.sha256`; the scripts' own `manifest.json` sha256s), and the behavioral golden-vector
conformance is the backstop that catches any drift a checksum pair could hide.

## Freeze posture — unchanged (DR-78 stands)

Shipping this **experimental** client is exactly the demand signal the design said a future freeze should
wait on — but it does **not** trigger the freeze. DR-78 holds the raw Lua wire **unfrozen**
(`frozen: false`), and the single trigger remains *promotion of the `RedisBackend` to a supported,
externally-pinned surface* — which experimental shipping is not. A future freeze still needs explicit
reauthorization. The client vendors the wire with a checksum + a behavioral gate and treats it as
may-change, which is the correct posture while it is unfrozen.
