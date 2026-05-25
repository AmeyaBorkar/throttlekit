# Design Notes & Verified Algorithm Math

Every formula here was verified against primary sources before implementation. This file is the
"no hallucinations" audit trail; code comments reference back to it.

## GCRA (Generic Cell Rate Algorithm) — default

Let `T = periodMs / limit` (emission interval), `tau = T · burst` (burst tolerance), and
`inc = T · cost`. Given stored `tat` (theoretical arrival time; defaults to `now` when
absent/expired):

```
tat'     = max(tat, now)
new_tat  = tat' + inc
allow_at = new_tat - tau
DENY  when now < allow_at  → retryAfterMs = ceil(allow_at - now); state unchanged
ALLOW otherwise            → persist new_tat with PX = ceil(new_tat - now)
remaining (allow) = floor((tau - (new_tat - now)) / T)
remaining (deny)  = floor((tau - (tat'   - now)) / T)
resetAt = (allow ? new_tat : tat')   // epoch-ms when fully replenished
```

**Burst semantics (decided & documented).** With `tau = T·burst`, a cold bucket admits exactly
`burst` requests instantaneously, then paces at `1/T`; request `burst+1` is denied. We expose this
as the meaning of `burst`. The canonical `throttled` library uses `tau = T·(burst+1)` (so it admits
`burst+1`) — same algorithm, off-by-one in what "burst" names. We match the project spec (`T·burst`).
Boundary is allow-on-equality (`now == allow_at` ⇒ allow), matching Wikipedia's VSA conformance
(`ta > TAT − tau` conforms) and `throttled` (`diff < 0`).

Sources: Brandur Leach <https://brandur.org/rate-limiting> · `throttled/rate.go`
<https://github.com/throttled/throttled/blob/master/rate.go> · Wikipedia GCRA
<https://en.wikipedia.org/wiki/Generic_cell_rate_algorithm>.

## Token bucket

`refillPerMs = refillPerSec / 1000`. Lazy refill:
`tokens = min(capacity, tokens + max(0, now − last)·refillPerMs)`, `last = now`.
Allow iff `tokens ≥ cost` ⇒ `tokens −= cost`. `retryAfterMs(deny) = ceil((cost − tokens)/refillPerMs)`.
`resetAt = now + ceil((capacity − tokens)/refillPerMs)`. Starts full. `limit = capacity`.
GCRA with `burst = capacity` is equivalent; token bucket reports an explicit token count.
Sources: <https://en.wikipedia.org/wiki/Token_bucket>.

## Leaky bucket (shaper / `schedule`)

Constant drain `r = ratePerSec`, `T = 1000/r`. Per arrival:
`departure = max(now, next_departure)`, `next_departure = departure + T·cost`,
`delayMs = departure − now`. Reject when `delayMs > maxQueueMs` (bounded queue `B/r`). The TAT
recurrence is identical to GCRA's; GCRA *rejects* past `tau`, the shaper *waits* up to `maxQueueMs`.
Sources: <https://en.wikipedia.org/wiki/Leaky_bucket>.

## Fixed window

Window key `floor(now/windowMs)`; `count++`; deny when `count > limit`.
`resetAt = (floor(now/windowMs)+1)·windowMs`. Documented property: up to **2×limit** across a
boundary. Atomic Lua = `INCR` + `PEXPIRE` on first hit.

## Sliding window counter (sub-bucketed, near-exact)

Window `[now − windowMs, now]` split into `S` buckets of width `w = windowMs/S`
(`buckets`, default 10). With `c = floor(now/w)` and `elapsed = now − c·w`:

```
estimate = Σ count(c−S+1 .. c) + count(c−S) · (w − elapsed)/w
allow iff estimate + cost ≤ limit   // compare the fractional value directly; do not floor first
```

Error is bounded by one bucket ≈ `1/S` of the window (only the oldest bucket is approximated).
The `S = 1` form is the classic two-counter estimator
`estimate = current + previous·((windowMs − elapsed)/windowMs)`, verified verbatim against
Cloudflare's worked example (50/min, prev 42, 18 in current at 15s ⇒ 42·0.75 + 18 = 49.5).
Sources (two-counter + 0.003% measured error over 400M reqs): Cloudflare
<https://blog.cloudflare.com/counting-things-a-lot-of-different-things/>. S-bucket / 1/S bound:
general literature (e.g. <https://limits.readthedocs.io/en/stable/strategies.html>).

## Sliding window log (exact)

Store ascending timestamps of accepted hits; count those within trailing `windowMs`; deny when
`count + cost > limit`. `retryAfterMs = (oldest_in_window + windowMs) − now`. O(limit) memory.
Redis: `ZREMRANGEBYSCORE` + `ZCARD` + `ZADD` inside one Lua script.

## Adaptive concurrency (Gradient2 + AIMD)

**Gradient2** (verified against Netflix `Gradient2Limit.java`):

```
gradient = clamp(0.5, 1.0, tolerance · rttNoload / rttActual)   // tolerance default 1.5
newLimit = limit · gradient + queueSize
newLimit = limit · (1 − smoothing) + newLimit · smoothing       // smoothing default 0.2
newLimit = clamp(minLimit, maxLimit, newLimit)
if inflight < limit/2: keep limit unchanged                     // don't grow while under-utilized
```

Netflix's Gradient2 tracks `rttNoload` as an exponential moving average (with a ×0.95 decay when
`noload/actual > 2`) and defaults `queueSize` to a constant `4`. The project spec describes
`queueSize = √limit` (from the older `GradientLimit`); we make `queueSize` configurable and default
to `√limit` per the spec, and use a *windowed* rolling-min for `rttNoload` (decays upward when no
new minimum), which gives "best observed latency" without the all-time-min low-bias Netflix warns
about. `didDrop` is treated as an overload signal (forces gradient toward the floor).

**AIMD** (verified against `AIMDLimit.java`): on healthy sample (`rtt ≤ timeout`, no drop) and
`inflight·2 ≥ limit`, `limit += 1`; on drop or `rtt > timeout`, `limit = floor(limit · backoffRatio)`
(`backoffRatio` default 0.9, in `[0.5,1)`). Clamp `[minLimit, maxLimit]`.

Sources: <https://github.com/Netflix/concurrency-limits> (`Gradient2Limit.java`, `AIMDLimit.java`) ·
Netflix blog <https://netflixtechblog.medium.com/performance-under-load-3e6fa9a60581> · Vector ARC
<https://vector.dev/blog/adaptive-request-concurrency/>.

## IETF RateLimit headers

Current draft is **draft-ietf-httpapi-ratelimit-headers-11** (May 2026), which uses RFC 9651
Structured Fields:

```
RateLimit-Policy: "default";q=100;w=60
RateLimit: "default";r=50;t=30
```

`q`=quota, `w`=window seconds, `r`=remaining, `t`=seconds until the quota resets (delta-seconds,
deliberately not a Unix timestamp), `pk`=partition key. The legacy triple
`RateLimit-Limit/Remaining/Reset` appears only in an appendix of -11 but remains widely consumed.
We emit, per configuration: (a) the structured `RateLimit`+`RateLimit-Policy` form, (b) the
`RateLimit-*` triple (delta-seconds reset), and/or (c) legacy `X-RateLimit-*`. `Retry-After` is
delta-seconds (rounded up, min 1) on `429`, and takes precedence over the effective window.
Source: <https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/>.

## Redis specifics

- `EVALSHA <sha>` → on `NOSCRIPT`, `SCRIPT LOAD`/`EVAL` then retry. Cache sha per script.
- Cluster hash tags: only the substring inside the first `{...}` is hashed, so a limiter's
  multi-key script wraps the subject in braces to co-locate all keys on one slot (avoids
  `CROSSSLOT`). All keys passed via `KEYS`.
- Server clock: scripts derive `now` from `redis.call('TIME')` when the caller passes the sentinel
  `now = 0`, so node clock skew can't corrupt shared state; the script returns the `now` it used so
  the decoded `Decision` is self-consistent. Tests pass an explicit `now` for determinism.
Sources: <https://redis.io/docs/latest/develop/programmability/eval-intro/> ·
<https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/>.
