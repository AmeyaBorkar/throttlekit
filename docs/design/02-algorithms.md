# 02 · Algorithms

> The pure-transition rate-limiting algorithms, each authored once and (where it matters) compiled to an
> equivalent atomic Lua form. Source: `src/algorithms/`, `src/multi/`.

## Purpose

Every limit ThrottleKit enforces is one of these algorithms. Each is a pure function
`check(state, now, cost) → { state, decision }` with a deliberately **compact state shape** (to minimize
serialization cost on distributed backends) and, for the distribution-relevant ones, an **atomic Lua
program** that computes the identical decision in one Redis round trip. A universal invariant holds across
all of them: **a denied request never consumes** (`persist: false` on deny), so `remaining` stays
meaningful across repeated denials. A second: **a strategy that constructs emits only finite decisions** — a
construction parameter that would drive a `Decision` field to `Infinity`/`NaN` (a subnormal
`limit`/`refillPerSec`/`windowMs`/`ratePerSec`, or an astronomically-scaled emission interval) is rejected at
construction with a `RangeError`, so `resetAt`/`retryAfterMs` are always finite and safe to serialize into a
`RateLimit-Reset`/`Retry-After` header (see [11 · Overload & security](11-overload-and-security.md)).

## The algorithms

### GCRA — Generic Cell Rate Algorithm (the default)

**Idea.** Track a single number per key — the *theoretical arrival time* (TAT), the earliest instant the
next request would be perfectly paced. One float of state, no buckets to refill, smooth pacing with a
configurable burst.

**Derived constants** from `{ limit, periodMs, burst? }` (`src/algorithms/gcra.ts:70`):

```
T   = periodMs / limit     // emission interval (ms per request)
tau = T * burst            // burst tolerance window
```

**Transition** at `now` with cost `q` (`src/algorithms/gcra.ts:88`):

```
inc      = T * q
tat      = max(state ?? now, now)     // max(tat, now): jump-safe
newTat   = tat + inc
allowAt  = newTat - tau
if now < allowAt:  DENY,  retryAfterMs = ceil(allowAt - now)   // persist:false
else:              ALLOW, state = newTat, remaining = floor((tau - (newTat - now)) / T)
```

From a cold key (`tat = now`) the first `burst` requests are admitted instantly and request `burst+1` is
denied; thereafter throughput settles to exactly `1/T`. State is **one float**, stored in Redis as
`string.format('%.17g', newTat)` so it round-trips exactly (`src/algorithms/gcra.ts:35`).

*Why the default:* O(1) state and CPU, smooth pacing, mathematically equivalent to a token bucket but
storing one number instead of two and needing no refill bookkeeping — a smaller wire footprint and a
simpler atomic script. The math is verified against primary sources in `docs/DESIGN-NOTES.md`. The burst
boundary is allow-on-equality (`now == allowAt` ⇒ allow); a `cost` exceeding `burst` can never be
satisfied (documented).

### Token bucket

**Idea.** A bucket of `capacity` tokens refilling continuously at `refillPerSec`; admit iff `≥ cost`
tokens are present, then spend them. State `{ tokens, last }` (`src/algorithms/token-bucket.ts:22`).

```
elapsed = max(0, now - last)                          // jump-safe
tokens  = min(capacity, tokens + elapsed * refillPerMs)
allow   = tokens >= cost  →  tokens -= cost
retryAfterMs (deny) = ceil((cost - tokens) / refillPerMs)
```

Lazily refilled (no timer), starts full on a cold key. It is GCRA with `burst = capacity` behaviorally,
but reports an **explicit token count** as `remaining`, which some teams prefer for client UX — that is
its entire reason to exist alongside GCRA.

### Fixed window

**Idea.** Count requests in epoch-aligned windows of `windowMs`; deny once `limit` is reached. State
`{ start, count }` (`src/algorithms/fixed-window.ts:22`); atomic Lua is `INCR` + `PEXPIRE` territory.

```
windowStart = floor(now / windowMs) * windowMs        // epoch-aligned
count       = (state.start === windowStart) ? state.count : 0   // stale window ⇒ 0
allow       = count + cost <= limit
```

The cheapest possible counter. **Documented gotcha:** because windows reset on hard boundaries, a client
can spend a full `limit` at the end of one window and another full `limit` at the start of the next — up
to **2×limit across a single boundary** (`src/algorithms/fixed-window.ts:58`). Use GCRA/token-bucket for
smooth pacing or a sliding window for boundary-free accuracy.

### Sliding window — sub-bucketed counter

**Idea.** Near-exact rolling window at any limit with **bounded** memory. The window is divided into `S+1`
ring slots (`buckets`, default 10); each request bumps the slot for the current tick, and the count is the
sum of in-window slots with the oldest partial slot weighted by its overlap fraction
(`src/algorithms/sliding-window.ts:122`):

```
estimate  = (sum of the S newest in-window slots) + oldestSlot * ((w - elapsed) / w)
allow     = estimate + cost <= limit
```

Error is bounded by **one bucket** (≈ `1/S` of the window) because only the single oldest bucket is
approximated. `buckets: 1` recovers the classic two-counter estimator
(`current + previous · ((windowMs − elapsed)/windowMs)`); the `S = 1` form is verified verbatim against
Cloudflare's published worked example in `docs/DESIGN-NOTES.md`. This is the sweet spot between fixed
window (cheap, 2× error) and the exact log (precise, unbounded memory). State is two plain arrays so it
JSON-round-trips on the SQL backends.

### Sliding window log — exact

**Idea.** Store the timestamp of every accepted unit; count those within the trailing `windowMs`. Exact,
but **O(limit) memory per key**, so it is scoped to low/moderate limits (e.g. "5 password resets / hour").
State is an ascending `number[]`; pruning the stale prefix is an index walk, no filter allocation
(`src/algorithms/sliding-window-log.ts:93`). In Redis it maps to a sorted set
(`ZREMRANGEBYSCORE` + `ZCARD` + `ZADD`) inside one Lua script, with members named by deterministic rank so
the script is reproducible (no `TIME`-based uniqueness). `retryAfterMs` is *exact* — the time until the
oldest in-window hit expires.

### Leaky bucket — the traffic shaper

**Idea.** Smooth bursty input to a steady `ratePerSec` by *scheduling* each accepted request slightly
later, rejecting only when the wait would exceed `maxQueueMs`. The next-departure recurrence is identical
to GCRA's TAT — **GCRA rejects past its tolerance; the shaper waits** (`src/algorithms/leaky-bucket.ts:132`).

It is exposed as a distinct interface (`Shaper`: `reserve`/`schedule`/`reset`) rather than a `Strategy`
because it returns a `Reservation { accepted, delayMs }`, not a `Decision` — a different product shape (it
delays rather than denies). `schedule()` reserves then sleeps; the sleep is *chunked* to step past
`setTimeout`'s 32-bit (~24.8 day) ceiling, because a larger value silently clamps to 1 ms and would fire
almost immediately (`src/algorithms/leaky-bucket.ts:62`). A wait over the ceiling throws `QueueFullError`.

### Quota — billing-period budget

**Idea.** A budget that resets on a **real calendar boundary** (e.g. "1,000,000 calls/month, resetting on
the 1st"), distinct from a sliding rate limit. `resetCadence ∈ calendar-month | calendar-week |
calendar-day | fixed | rolling` (`src/algorithms/quota.ts`). `rolling` delegates to the proven
`slidingWindow`; `fixed` is an epoch-aligned window; the `calendar-*` cadences compute the true next civil
boundary (leap-year-correct) with dependency-free proleptic-Gregorian math (Howard Hinnant's
`daysFromCivil`/`civilFromDays`, `src/algorithms/calendar.ts:27`), reimplemented verbatim in inline Lua.

*Why a fixed UTC offset, not a DST-aware zone:* a DST transition cannot be reproduced in Redis Lua without
bundling a timezone database, which would break the bit-identity guarantee. A fixed offset is the only
calendar arithmetic that is reproducible byte-for-byte in Lua — and most billing runs in UTC or a fixed
offset anyway (`src/algorithms/calendar.ts:8`). `offsetMinutes` is validated to ±840 (±14 h).

### Selection cheat sheet

| Goal | Pick |
|---|---|
| Best general default — tiny state, smooth pacing | **GCRA** |
| Client-friendly "tokens remaining", controlled bursts | Token bucket |
| Shape/queue outbound calls to a fixed rate | Leaky bucket |
| Cheapest coarse cap, boundary burst acceptable | Fixed window |
| Exact "N in the last X" at low limits | Sliding window log |
| Near-exact rolling window at any limit, bounded memory | Sliding window (sub-bucketed) |
| Budget that resets on a calendar/billing boundary | Quota |

## Multi-dimensional limiting (`all` / `any`)

Real systems limit on several axes at once — per-IP **and** per-user **and** per-route. Done naïvely that
is N sequential checks (N round trips) with a partial-consume hazard: if dimension 3 denies after 1 and 2
already consumed, you've leaked budget. `all({...})` (AND) and `any({...})` (OR) solve both
(`src/multi/index.ts`):

- **Atomic together on Redis.** Every dimension is evaluated in a **single Lua script** over hash-tag
  co-located keys, so the whole decision is one atomic round trip.
- **No partial consumption.** The script computes all sub-decisions first and commits state only if the
  combine rule admits (all-allow for `all`, any-allow for `any`); otherwise nothing is consumed.
- **A representative `Decision`.** The result reflects the *binding* constraint — for `all`, the
  min-remaining dimension when allowed or the largest-`retryAfter` denier when denied — so your headers
  and logs name the real limit.

The in-process path achieves the same none-or-all atomicity via single-threaded execution: peek every
dimension, combine, commit in one uninterrupted turn. The fused Lua mirrors the JS `combine` exactly, so
memory and Redis composites are bit-identical. The async path supports `gcra`/`tokenBucket`/`fixedWindow`
(the single-state strategies); other strategies on the multi path throw on Redis.

## Design decisions & rationale

- **GCRA is the default** because it minimizes both state and complexity while matching token-bucket
  behavior — the smallest correct primitive that paces smoothly.
- **Compact state shapes everywhere** (a float, a two-field record, a fixed ring) because state is
  serialized on every distributed apply; smaller state is less wire and less CPU.
- **A denied request never consumes** so a client hammering a blocked key sees a stable `remaining`/`retryAfter`,
  and so the "exactly K admitted at limit K" atomicity property holds.
- **The sub-bucketed sliding window exists** specifically to occupy the bounded-memory / near-exact middle
  ground that neither fixed window (cheap but 2× error) nor the exact log (precise but unbounded) covers.
- **Calendar math is dependency-free and Lua-reproducible** so a billing reset is bit-identical between the
  JS and Redis paths — at the cost of no DST awareness, an explicitly documented trade.

## What proves it

- `test/algorithms/gcra.test.ts` — admits exactly `burst` then denies; paces at `1/T`; **clock-jump safe**
  (a backward jump denies and recovers, never over-admits).
- `test/algorithms/token-bucket.test.ts` — full burst, lazy refill pacing, idle clamp, no over-refill on a
  backward jump.
- `test/algorithms/fixed-window.test.ts` — exactly `limit` per window, epoch alignment, and the documented
  **2×limit across a boundary**.
- `test/algorithms/sliding-window.test.ts` — does **not** double across a boundary; smooth weight decay.
- `test/algorithms/sliding-window-log.test.ts` — exact count and exact `retryAfter`; frees a slot precisely
  as the oldest hit exits.
- `test/algorithms/leaky-bucket.test.ts` (+ `leaky-schedule-overflow.test.ts`) — paces at the drain rate,
  rejects past `maxQueueMs`, and does not resolve early for a delay beyond the 32-bit timer ceiling.
- `test/algorithms/quota.test.ts` + `calendar.test.ts` — calendar/fixed/rolling cadences; `daysFromCivil ↔
  civilFromDays` round-trips over ~550 years and agrees with `Date.UTC`; leap-year February; offset shifting.
- `test/multi/multi.test.ts` — `all` denies with **no partial consume**; `any` allows if any allows;
  binding decision = tightest remaining; Redis dual-path conformance for both.
- `test/conformance/conformance.test.ts` — the bit-identical JS-vs-Lua proof across all strategies (see
  [01](01-core-model.md)).
- `test/algorithms/decision-finiteness.test.ts` — every strategy, under adversarial construction params
  (subnormal / astronomical rates and windows), either throws a `RangeError` or only emits finite `Decision`
  fields — the construction-time finiteness invariant.

## Source map

`src/algorithms/gcra.ts` · `token-bucket.ts` · `fixed-window.ts` · `sliding-window.ts` ·
`sliding-window-log.ts` · `leaky-bucket.ts` · `quota.ts` · `calendar.ts` · `index.ts` ·
`src/multi/index.ts` (the `all`/`any` combinators).
