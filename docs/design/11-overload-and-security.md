# 11 · Overload & security

> Fixed-memory DDoS sketches for an unbounded key universe, and the keying/headers machinery that makes
> rate limiting a correct *security* control. Source: `src/sketch/`, `src/security/`, `src/http/`.

## Purpose

Two concerns that share a theme — *getting it wrong silently defeats the limit*. Under a flood of unique
keys, per-key state is itself the memory-exhaustion vector, so overload protection needs **fixed-memory**
counting. And rate limiting is a security control: deriving the *key* wrong (trusting a spoofable header,
limiting a full IPv6 address) is the classic bypass, so keying must be an explicit, validated choice.

## Fixed-memory sketches (`src/sketch/`)

**`CountMinSketch`** is a single flat `Uint32Array` of `depth × width` counters whose footprint depends only
on the accuracy parameters (`epsilon`, `delta`), never on the key count
(`width = ⌈e/epsilon⌉`, `depth = ⌈ln(1/delta)⌉`, Cormode–Muthukrishnan 2005). The `depth` independent
hashes come from double-hashing two FNV-1a seeds (deterministic, so seeded tests reproduce); `estimate` is
the min counter across rows (so it **never underestimates**). The default `add` uses the Estan–Varghese
**conservative-update** rule, which provably tightens the overestimate while preserving the never-underestimate
property. Plain (non-conservative) sketches are linear, so `mergeSnapshot` is an *exact* union — the basis
for cluster-wide estimation.

**`sketchRateLimit`** (experimental) is a windowed, fixed-memory limiter. Check-before-add is mandatory (a
CMS can't be decremented): read `estimate(key)`, admit iff `estimate + cost ≤ limit`, only then `add`. Cost
must be an integer (a fractional cost would truncate in the `Uint32Array`). **The guarantee:** because
`estimate ≥ trueCount`, an `allowed` decision implies the true admitted count ≤ limit — a *hard,
non-probabilistic never-over-admit* property. The only error is *early* denial, bounded by `≤ epsilon·N`
with probability `≥ 1 − delta`. Over-denying (never over-admitting) is exactly the right bias for DDoS.

**`mergeableSketch`** (experimental) is a cluster-wide *estimator*. It is honestly scoped as
eventually-consistent detection/best-effort shedding — **not** a strongly-consistent global limiter (for an
exact shared limit, use `rateLimit` over Redis/Postgres or `twoTier`). The library ships the data structure
and the math, not the merge schedule or transport.

## Proxy-correct client IP (`src/security/ip.ts`)

Trusting `X-Forwarded-For` blindly is the classic rate-limit bypass — an attacker prepends a forged hop and
rotates the "client" IP at will. So the default is `trustProxy: false` (ignore XFF, use the socket peer), and
trust is **opt-in and explicit**:

- `trustProxy: number N` — Express hop semantics: the client is `N` entries left of the socket peer in
  `[...xff, remoteAddr]`, clamped.
- `trustProxy: string[]` — a CIDR/IP allowlist: walk right-to-left, the first address *not* in the
  allowlist is the client.

All IPv4/IPv6 parsing, masking, and CIDR matching is in-house (no dependency): strict IPv4 (rejects
leading-zero octets), full IPv6 including `::` compression and embedded-IPv4 tails, with zone-id and bracket
stripping. A malformed trust entry never matches (fail-closed for trust). **IPv6 is aggregated to a `/64`
prefix by default** — one IPv6 customer controls billions of addresses, so per-full-address limiting is
trivially bypassed; the `/64` bucket collapses that.

## PII-safe keys (`src/security/keys.ts`)

`hmacKeyer(secret)` hashes a raw key (IP, user id, API key) with HMAC-SHA-256 before it reaches the store, so
a shared Redis never holds raw identifiers (a GDPR / multi-tenant posture). *Why HMAC, not a bare digest:* a
*keyed* hash means the mapping isn't a public rainbow table — without the server secret an attacker can't
precompute `hash(ip)` for every IP.

## HTTP headers (`src/http/headers.ts`)

Three flavors of the same decision: `draft` (the IETF triple `RateLimit-Limit/Remaining/Reset`, where Reset
is **delta-seconds**), `structured` (RFC 9651 Structured Fields: `RateLimit` + `RateLimit-Policy`), and
`legacy` (`X-RateLimit-*`, where Reset is **epoch-seconds**). The default is `{ draft: true }`. On any
denial, `Retry-After` (delta-seconds, minimum 1) is **always** added regardless of the emit selection — the
library never advertises "retry immediately." `policyName` is interpolated into a quoted structured field, so
it is sanitized: C0 controls and DEL (including the CR/LF header-injection vector) are dropped and `"`/`\`
are escaped.

## The explicit fail direction (cross-cutting)

Store outages resolve via an explicit `fail: "open" | "closed"`, never an accident. The default is `"open"`
(availability); the docs steer security-sensitive limiters (auth/payments/signup) to `"closed"` so a store
outage can't be ridden to bypass the limit, and the policy applies to *any* limiter throw. In HTTP adapters a
fail-closed outage is a 503; in gRPC it's `UNAVAILABLE`.

## Adversarial-input guards at the boundary

Rate limiting sits on an untrusted edge, so every value that crosses the boundary — the raw text of a
`.throttlekit.yaml`, a per-request `cost`, a strategy's construction options, a peer's wire sketch — is
validated to fail *loudly and finitely* rather than produce a corrupt limit. A fuzz + mutation + model-based
sweep of these surfaces surfaced the guards below; each rejects at the boundary with a typed error:

- **Decision finiteness (`src/algorithms/`, `src/core/validate.ts`).** A construction parameter that would
  make a `Decision` field non-finite is rejected with a `RangeError`, so a limiter that builds only ever emits
  finite `resetAt`/`retryAfterMs` (a non-finite `resetAt` would become a malformed `RateLimit-Reset` header).
  This covers a subnormal or astronomically-scaled `limit`/`refillPerSec`/`windowMs`/`periodMs`/`ratePerSec`
  across `gcra`, `tokenBucket`, `fixedWindow`, `slidingWindow`, and `quota` — and `leakyBucket`, where a
  non-finite `delayMs` would otherwise make `schedule()` `sleep(Infinity)` and never fire (a silent hang). The
  rate-based strategies additionally bound their derived emission interval to a safe-integer count of ms.
- **Config parser recursion (`src/config/yaml.ts`).** The zero-dependency YAML/JSON-subset parser caps
  block-nesting depth (`MAX_NESTING_DEPTH = 64`) and throws a typed `YamlParseError`, so a deeply-nested
  untrusted config can't overflow the call stack (a DoS on config text). The parser also never pollutes
  `Object.prototype` — `__proto__`/`constructor`/`prototype` keys are dropped.
- **Cost overflow (`src/core/validate.ts`).** A per-request `cost` must be a positive finite number
  `≤ Number.MAX_SAFE_INTEGER`; a larger cost overflowed the emission-interval `cost · T` to a non-finite
  `retryAfterMs`.
- **Bounded sketch ring (`src/algorithms/sliding-window.ts`).** `slidingWindow.buckets` is capped at 100 000 —
  the estimator holds an O(buckets) ring *per key*, so an unbounded `buckets` from one hostile config was a
  memory-amplification vector (the fixed-memory sketches above bound the orthogonal *key-count* axis).
- **Sketch total poisoning (`src/sketch/index.ts`).** A decoded snapshot whose `total` is non-finite or
  negative is rejected, and a poisoned peer `total` is ignored on merge, so a malformed wire snapshot can't
  corrupt the cluster-wide `N` (the count in the `ε·N` shed threshold).

## Design decisions & rationale

- **Fixed-memory sketches** because per-key state is itself the DDoS amplification vector; the sketch's
  footprint is a function of accuracy, not cardinality.
- **Every boundary value fails loudly and finitely** — a config, cost, option, or peer snapshot that could
  only yield a corrupt or non-finite limit is rejected at the edge with a typed error, never a silent
  `Infinity`/`NaN`, unbounded allocation, or hang.
- **The sketch limiter over-denies, never over-admits** — the one-sided error that is correct for abuse
  protection, and it's a hard (non-probabilistic) safety property because `estimate ≥ trueCount`.
- **Trust is opt-in and validated** — the default ignores `X-Forwarded-For`; a malformed trust entry never
  matches; this is the audited fix for the spoofing bypass.
- **IPv6 aggregated to `/64`** so one customer can't rotate through billions of addresses.
- **HMAC (keyed) hashing**, not a bare digest, so the stored mapping isn't a precomputable rainbow table.
- **`Retry-After` always on a denial**, and `policyName` sanitized against header injection.
- **Fail direction is explicit** — the library never guesses between availability and a closed bypass.

## Caveats

- `sketchRateLimit` / `mergeableSketch` are experimental; the mergeable form is an estimator, not an exact
  global limiter.
- Sketch limiting requires integer cost.

## What proves it

- `test/sketch/sketch.test.ts` — width/depth from the formulas, never-underestimates over 20k inserts,
  deterministic seeded hashing, `sketchRateLimit` **never over-admits** over 300k hits, bounded memory (10
  vs 100k keys → identical capacity), the error bound, and the bounded false-deny rate.
- `test/security/ip.test.ts` — adversarial: ignores spoofed XFF by default, resists a prepended spoofed
  entry under an allowlist, IPv6 `/64` aggregation collapses a rotating attacker to one key.
- `test/security/keys.test.ts` — deterministic, per-input and per-secret distinct, matches a known
  HMAC-SHA-256 vector.
- `test/http/headers.test.ts` + `policy-name-sanitization.test.ts` — delta-vs-epoch reset contrast,
  `Retry-After` present even with `emit:{}`, and CR/LF stripped from `policyName` (no injection).
- `test/adapters/enforce.test.ts` — fail-open vs fail-closed behavior.
- `test/algorithms/decision-finiteness.test.ts` — every strategy, driven through adversarial construction
  params, either throws a `RangeError` or only emits finite decisions (the finiteness invariant).
- `test/fuzz/*.fuzz.test.ts` — the config parser, IP/XFF, key/cost, and sketch-merge boundaries survive
  arbitrary input: a typed throw or a valid result, never a crash, hang, or `Object.prototype` pollution.

## Source map

`src/sketch/index.ts` · `src/security/ip.ts`, `keys.ts` · `src/http/headers.ts` · the boundary guards in
`src/core/validate.ts`, `src/config/yaml.ts`, `src/algorithms/` · the fail policy lives in
`src/adapters/` ([09](09-adapters.md)).
