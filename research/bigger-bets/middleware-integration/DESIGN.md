# Middleware Integration — DESIGN (TK-1324)

**Status:** design lock for 0.9.2 (TK-1324..TK-1328).
**Scope:** wire `unifiedAdmission` (0.9.0) and `adaptiveConcurrency` (pre-0.8) into
every existing adapter — express, fastify, koa, nest, hono, fetch, next, remix,
sveltekit, elysia, trpc, lambda, grpc.

---

## §1 Statement of the gap

`Limiter.check(key, cost) → Promise<Decision>` is **stateless**. Every one of
the 15 adapters in `src/adapters/*.ts` consumes that shape and that shape only:

```
gate.limiter.check(key, cost)
  → on allow:   setHeaders, next()
  → on deny:    setHeaders, 429
```

`unifiedAdmission` (0.9.0, `src/admission/unified.ts`) and `adaptiveConcurrency`
(`src/concurrency/adaptive.ts`) do not fit this shape. They expose:

```ts
admit.admit({key, cost}) → Promise<{ decision: Decision; release(opts?): void }>
guard.acquire()          → { ok: boolean; release(opts?): void }
```

The `release(opts?: { dropped?: boolean })` callback **MUST** be invoked exactly
once when the request lifecycle ends. If it is not, the concurrency slot is
held until process exit. Repeated leaks shrink the available slot count
monotonically; the adaptive controller observes no completion samples (no RTT,
no drop), the `gradient2 / aimd` updates never fire, and the inferred limit
stays where it landed before the leak began. With every new request taking a
slot that never returns, `inflight` climbs to the limit and **every subsequent
acquire fails** (returns `{ ok: false }`). The server stops admitting.

**Today, no adapter wires `release()`.** A grep across `src/adapters/*.ts` for
`unifiedAdmission|UnifiedAdmitter|admitter|\.admit\(|\brelease\(` returns
zero matches. Likewise for `adaptiveConcurrency|ConcurrencyGuard|\.acquire\(`.

The only documentation of the wiring is a **comment block** at
`examples/unified.ts:109-129` showing a manual Express pattern:

```ts
res.on("finish", () => release({ dropped: false }));
res.on("close",  () => release({ dropped: true  }));  // client hung up
```

That comment has two latent issues we will fix in this design (§5):

1. `close` fires **after** `finish` on the normal completion path in Node's
   `http.ServerResponse` state machine — so the second call carries
   `dropped: true` on every normal response. Idempotency makes the call a
   no-op, but the comment's framing ("client hung up") is misleading: the
   hook does not actually distinguish hangup from normal completion at the
   call site.
2. If the handler throws synchronously and `next(err)` is invoked without
   a downstream error middleware that calls `res.end()`, **neither hook
   fires** until the socket times out (`server.keepAliveTimeout`, default
   5 s in Node 19+). The slot is leaked for that duration.

The gap is real, broader than `unifiedAdmission` alone (it inherits from
`adaptiveConcurrency`'s pre-existing lifecycle shape), and silent in
production. **The fix is per-framework lifecycle wiring inside the library,
not in user code.**

---

## §2 Lit synthesis

Three relevant strands of prior art, none of which solves this in our shape:

**(a) Concurrency-control libraries that expose `acquire()/release()`.**
Netflix's `concurrency-limits` (Java, 2017) and its JS port both expect the
caller to wire release; their bundled Servlet filter does this for the
Servlet API explicitly. The general lesson: shipping a primitive without
shipping at least one framework adapter that wires its lifecycle is the
trap (Netflix's filter is ~200 lines and the README points at it before the
primitive). We are repeating this mistake; this design fixes it.

**(b) Node HTTP response state machine** (`http.ServerResponse` —
[Node docs](https://nodejs.org/api/http.html#class-httpserverresponse)). The
two events we care about:

  - **`finish`** — emitted *exactly once* after `response.end()` returns,
    i.e. after the last data byte has been flushed to the OS socket buffer.
    Indicates the response was *handed off*; does **not** guarantee the
    client received it.
  - **`close`** — emitted exactly once when the underlying connection is
    closed for *any* reason. On normal HTTP/1.1 close-after-write, this
    fires *after* `finish` (the response was handed off, then the
    connection closed). On client hang-up before `end()`, this fires
    *without* a prior `finish`. On HTTP/2, the semantics map to the
    underlying stream's close — same invariant: `close` always fires;
    `finish` fires iff the response completed.

The reliable disambiguator: subscribe to both; the *first* event that fires
classifies the lifecycle. `close before finish` ⇒ aborted (dropped=true);
`finish first` ⇒ completed (dropped=false). The second event is a no-op
under our idempotent release. This pattern is what Express's own
`compression`, `body-parser`, and `morgan` use to detect abort vs complete.

**(c) Lambda + serverless invocation lifecycle.** The handler-return shape
makes lifecycle trivial: the runtime guarantees exactly one return (or one
rejected promise). API Gateway proxy integration: a thrown error → 502;
a returned `5xx` status code → still counts as a delivered response. So
the `dropped` semantics differ slightly: thrown ⇒ dropped=true; returned
5xx ⇒ dropped=false (the application chose to surface failure, but the
runtime delivered a response). We will document this as policy D-M-2.

---

## §3 Architectural options

Three coherent options. We picked C; the others are documented for the
record.

### Option A — single library-internal helper

Ship `withReleaseLifecycle(decision, release, hooks)` where `hooks` is a
discriminated union of `{ kind: "node-res"; res: NodeRes } | { kind: "stream"; stream: ReadableStream } | { kind: "manual"; signal: AbortSignal }`. Users
call it inside their own middleware.

**Why rejected.** Users *already* call this manually today; codifying the
helper shaves boilerplate but does not move the safety frontier. The whole
point is to make the lifecycle wiring **the library's responsibility, not
the user's**. Option A leaves the failure mode in place.

### Option B — monolithic per-framework adapter

`expressMiddleware({ rate?, concurrency?, cost? })` taking the same axes
as `unifiedAdmission` but mixed with the existing rate-only adapter
options. Single export per framework.

**Why rejected.** Three reasons. (1) Backwards-compat: today
`expressRateLimit({ strategy: ... })` is documented for ~2 years; widening
its option shape risks breakage. (2) Discoverability: a user wanting *just*
adaptive concurrency would import `expressMiddleware({ concurrency })`,
which reads as "the middleware" even though it's one of three. (3)
`unifiedAdmission` and `adaptiveConcurrency` have meaningfully different
shapes (the former is a composition, the latter a primitive); collapsing
them into one entry point hides that.

### Option C — per-primitive, per-framework adapter (selected)

Two new exports per framework:

```
expressUnifiedAdmission({ admitter, key?, fail?, ... })
expressAdaptiveConcurrency({ guard, key?, fail?, ... })
```

The user passes a prebuilt `UnifiedAdmitter` (from `unifiedAdmission(...)`)
or `ConcurrencyGuard` (from `adaptiveConcurrency(...)`). The adapter is
responsible for: (a) calling `.admit()` / `.acquire()`; (b) emitting
standards headers from the combined Decision; (c) wiring `release()` to
the request lifecycle with the correct `dropped` value; (d) handling deny
and store-outage paths consistently with the existing rate-limit adapter.

**Why selected.**
- Mirrors the existing per-primitive split — `rateLimit` → 14 adapters,
  now `unifiedAdmission` → 14 and `adaptiveConcurrency` → 14.
- Zero breaking changes — no existing API changes; new exports only.
- Each adapter is small (~80 lines) and isolated; per-framework
  lifecycle quirks (express finish/close vs hono try-finally vs lambda
  handler-return) live in one place.
- The same `createGate` / `nodeClientIp` / `trustFrom` / `edgeClientIp`
  helpers in `src/adapters/core.ts` carry over.

Trade-offs accepted:
- 14 frameworks × 2 primitives = 28 new exports. Sizeable but bounded.
- Some frameworks have one lifecycle path; others have two (sync vs async
  routes). We pick the lowest-common-denominator per framework.

---

## §4 Per-framework lifecycle table

The table below is the authoritative mapping. **Subscribe order matters:**
release MUST be wired BEFORE the handler runs, so that a synchronous throw
inside the handler still triggers the close hook.

| Framework | Lifecycle hook(s) for release | dropped detection | Notes |
|---|---|---|---|
| **express** | `res.on("finish", …)` + `res.on("close", …)` | `dropped = !res.writableEnded` at first-fire | Standard Node `http.ServerResponse` semantics. |
| **fastify** | `reply.raw.on("finish", …)` + `reply.raw.on("close", …)` | same as express | Fastify's `reply.raw` is the underlying Node response. |
| **koa** | `ctx.res.on("finish", …)` + `ctx.res.on("close", …)` | same as express | `ctx.res` is the Node response. We could also use the `await next()` try/finally pattern; we choose finish/close for consistency with express. |
| **nest** | Interceptor with `tap(... ) / finalize(…)` from `rxjs` | `dropped = throwError caught` | Nest guards run pre-handler; only interceptors can wrap completion. The guard variant denies pre-handler but cannot release on completion — so we ship BOTH: a guard for deny + an interceptor for release. |
| **hono** | `try { await next(); } finally {}` around the inner handler | `dropped = catch block was entered` | Hono's middleware contract is `(c, next) => Promise<Response>`. The `finally` fires after `await next()` resolves or rejects. |
| **fetch** (Web) | Wrap response body with `TransformStream` that fires on `close` | `dropped = stream errored or cancelled` | `TransformStream.flush` runs on natural close. Cancellation triggers `cancel()`. We treat both as completion; cancellation is `dropped=true`. |
| **next** | Same as `fetch` for App Router route handlers; same as `express` for legacy `pages/api` | depends on path | Next.js middleware itself is fetch-style; `pages/api` is express-shaped. We ship the fetch-style by default and document the pages/api opt-in. |
| **remix** | Wrap response with the same `TransformStream` as `fetch` | `dropped = stream errored or cancelled` | Remix loaders/actions return `Response`. Throwing returns a thrown `Response` — we treat the throw as `dropped=true`. |
| **sveltekit** | Wrap response with the same `TransformStream` as `fetch` | `dropped = stream errored or cancelled` | SvelteKit's `handle` hook returns `Response`. |
| **elysia** | `onBeforeHandle` for admit; `onAfterHandle` + `onError` for release | `dropped = onError fired` | Elysia's lifecycle gives us both hooks cleanly. |
| **trpc** | `try { await next(); } finally {}` in middleware | `dropped = catch block was entered` | Same as hono. The "response" is whatever next() returns. |
| **lambda** | `try { return await handler(...); } catch { release({dropped: true}); throw; } finally { release({dropped: false}) }` | `dropped = handler threw OR result.statusCode >= 500` (configurable) | Synchronous lifecycle. Default policy: thrown ⇒ dropped, returned ⇒ not (even 5xx, since the runtime delivered). User can override via `dropOn5xx: true`. |
| **grpc** | Wrap the `sendUnaryData` callback to release on call | `dropped = error !== null OR code !== OK` | The callback fires exactly once per call. |

**Test exhaustively.** The exactly-once-release property test (TK-1327)
will fuzz the event ordering on each framework's lifecycle model:
finish-before-close, close-before-finish, finish-twice (defensive), error
mid-handler, close-after-finish-after-error, etc.

---

## §5 The `dropped` decision matrix

Per D-M-2, `dropped` is **a property of the response state, not the
handler outcome**. The disambiguator is "did a response complete its
lifecycle normally?", not "did the handler succeed?".

| Event | Response completed? | `dropped` | Rationale |
|---|---|---|---|
| Handler returns 200 OK, response written | yes (finish fires) | `false` | Normal success. |
| Handler returns 4xx, response written | yes (finish fires) | `false` | Application chose to deny; not an overload signal. |
| Handler returns 5xx, response written | yes (finish fires) | `false` (default) | Application surfaced a failure but the runtime delivered a response. Lifecycle nominally completed. (Overridable on lambda via `dropOn5xx`.) |
| Handler throws, error middleware writes 5xx | yes (finish fires) | `false` | Same as above — Express's error path still emits a response. |
| Handler throws, NO error middleware writes anything | no (close without prior finish) | `true` | Connection dies; adaptive controller correctly contracts. |
| Client disconnects mid-stream | no (close without prior finish) | `true` | Server can't deliver; treat as overload signal (the handler's continued work is now wasted). |
| Server-side timeout middleware fires | no (close without prior finish) | `true` | Same as client disconnect. |
| Process killed mid-request | no (close without prior finish in graceful shutdown; nothing in SIGKILL) | `true` | Whatever the framework can observe. |

**Why "response state, not handler outcome"?** Because the adaptive
concurrency controller is measuring *system capacity*, not *application
correctness*. A handler that returns 500 in 50 ms is data: capacity exists,
the application is unhappy. A handler that hangs for 30 s and is cut by a
client disconnect is also data: capacity is saturated.

**Lambda special-case.** Lambda has no notion of "response state mid-flight"
— the runtime owns the lifecycle and a return is final. We use the
thrown-vs-returned axis as the proxy: throwing means the runtime had to
serialize the error itself, which is the closest signal to "the handler
gave up." Default `dropOn5xx: false` (a returned 5xx is application policy).

---

## §6 Algorithm: exactly-once-release wrapping

The "first fire wins" pattern, used by every node-server adapter:

```ts
// Inside the adapter, after admit succeeded:
let released = false;
const fire = (dropped: boolean): void => {
  if (released) return;       // idempotent: second hook is a no-op
  released = true;
  release({ dropped });
};
res.on("finish", () => fire(false));   // normal completion
res.on("close",  () => fire(true));    // first-fire only matters if !finish
//   → after finish, close still fires but `released` is true → no-op
//   → before finish (client hangup), close fires first → dropped=true
```

The race condition this addresses: in some Node versions, `close` can fire
*synchronously* after `end()` returns (HTTP/1.1 keep-alive disabled
or `Connection: close`), interleaving with the `finish` emit. The first-fire
semantics make this a no-op regardless of order. We confirm via the property
test (TK-1327).

For wrap-style frameworks (hono, koa-via-await, trpc):

```ts
const { decision, release } = await admitter.admit({ key, cost });
// emit headers, deny short-circuit, etc.
let outcome: "ok" | "thrown" = "ok";
try {
  await next();
} catch (e) {
  outcome = "thrown";
  throw e;
} finally {
  release({ dropped: outcome === "thrown" });
}
```

The `try/finally` is dropped=safe even if the body throws inside `finally`
(`release` is idempotent — we've called it at most once). The inner `throw`
inside `catch` re-raises so the framework's own error handler still runs.

For fetch/web-stream wrap (next, remix, sveltekit, fetch):

```ts
const response = await handler(request);
const wrapped = new Response(
  response.body?.pipeThrough(new TransformStream({
    flush() { release({ dropped: false }); },   // natural end
    // cancel() is called by the consumer to abort
  })) ?? null,
  { status: response.status, headers: response.headers },
);
// Plus an `abort` listener on the request.signal if available, mapping to
// release({dropped: true}) on the first-fire principle.
return wrapped;
```

If `response.body` is `null` (the handler returned a body-less response,
e.g. 204 or a manual `new Response(null, ...)`), release fires immediately
with `dropped: false` (the lifecycle is already complete).

---

## §7 Header rendering

For `unifiedAdmission`: the combined Decision (post-`combineDecisions`)
carries the field-wise MIN/MAX/AND across configured axes. We render it
via `gate.headersFor(decision)` exactly like the rate-limit adapter does —
the standards headers (`RateLimit`, `RateLimit-Policy`, `Retry-After`)
are agnostic to which axis bound the decision.

For per-axis observability — required by TK-1008 (OTel
`tk.binding_axis` attribute) — we expose `admitter.lastDecisions()` as
the snapshot of which axes contributed. The adapter calls this **inside the
admit's await result**, before any subsequent admit can mutate it, and
hands the snapshot to `onLimited?(req, res, decision, axes)` and
`handler?(req, res, decision, axes)` so the custom denial path can see the
binding axis.

For `adaptiveConcurrency`: the `Decision` from the lease-shim carries
`limit`, `remaining`, `resetAt: now`, `retryAfterMs: max(1, lastRtt)`.
This is sufficient for the standards headers; the slot semantics don't
have a clean `RateLimit-Reset` analog (the slot frees by event, not by
clock), but the MAX-aggregation in `combineDecisions` (when composed with
rate/cost) handles this correctly already.

---

## §8 `lastDecisions` snapshot timing

`admitter.lastDecisions()` is shared state on the `UnifiedAdmitter` — it
returns a snapshot of the *most recent* admit's per-axis decisions. In a
concurrent request handler, a second admit can mutate this state before
the first handler reads it.

**Resolution.** The adapter captures the snapshot **immediately** after
the `await admit.admit(...)` resolves, in the same microtask, before
yielding to any awaited downstream work:

```ts
const { decision, release } = await admitter.admit({ key, cost });
const axes = admitter.lastDecisions();   // captured in the same microtask
// ... headers, deny, next() ...
```

The microtask discipline (single-threaded JS) guarantees no other admit
can run between the two lines. This is the same pattern Express's
`compression` adapter uses to capture per-request state.

**Failure mode if we got this wrong:** the `onLimited` hook and the
`handler` callback would see another concurrent request's binding axis —
a logging confound, not a correctness bug. Still worth getting right.

---

## §9 Test substrate (mock req/res)

For TK-1327's property test, we need a deterministic mock of each
framework's lifecycle:

**Node-style** (express, fastify, koa):
```ts
class MockRes extends EventEmitter {
  writableEnded = false;
  finish(): void { this.writableEnded = true; this.emit("finish"); }
  close(): void { this.emit("close"); }
  setHeader(): void {}
  status(): this { return this; }
  // ...
}
```

The test generator picks a random valid event sequence: `[finish]`,
`[finish, close]`, `[close]`, `[close, finish]` (defensive), `[]` (timeout
case — neither fires), and asserts the adapter calls release exactly once
with the right `dropped` value.

**Wrap-style** (hono, koa-async, trpc): mock the `next()` function with
a `Promise<void>` that resolves or rejects per generator choice.

**Fetch-style** (next, remix, sveltekit, fetch): construct a real `Response`
with a `ReadableStream` body that can be consumed normally or cancelled.

**Lambda/grpc**: trivial — handler-return or callback-invocation.

The test covers each adapter with `numRuns: 200` random workloads × 5 event
patterns = 1000 timelines per adapter. The invariant: `release` called
exactly once per admit-success, with the correct `dropped`.

---

## §10 API surface (per-framework exports)

All new exports added in 0.9.2. None replace anything; the existing
`rateLimit` adapters stay as-is.

### Express
```ts
// src/adapters/express.ts (additions)
export function expressUnifiedAdmission(options: ExpressUnifiedAdmissionOptions): RequestHandler;
export function expressAdaptiveConcurrency(options: ExpressAdaptiveConcurrencyOptions): RequestHandler;

export type ExpressUnifiedAdmissionOptions = CommonAdapterOptions & {
  admitter: UnifiedAdmitter;
  key?: (req: Request) => string;
  cost?: number | ((req: Request) => number);
  onLimited?: (req, res, decision, axes) => void;
  onError?: (req, res, err) => void;
  handler?: (req, res, decision, axes) => void;
  /** If true, treat 5xx responses as `dropped: true`. Default false. */
  dropOn5xx?: boolean;
};
export type ExpressAdaptiveConcurrencyOptions = /* same shape, no `axes` */;
```

### Fastify, Koa, Nest, Hono, Fetch, Next, Remix, SvelteKit, Elysia, Trpc, Lambda, Grpc
Same shape per framework, with the framework-native types substituted
(`FastifyRequest` for `Request`, `Context` for `(req, res)`, etc.).

### Naming convention (D-M-13)
- `<framework>UnifiedAdmission` and `<framework>AdaptiveConcurrency`.
- No `WithRelease` suffix — the lifecycle is the whole point, not an
  opt-in.
- The function takes a *prebuilt* `UnifiedAdmitter` / `ConcurrencyGuard`
  (not the axes directly). Building inline is a small ergonomic loss but
  keeps the adapter focused on lifecycle wiring; users can always
  `const admitter = unifiedAdmission({...})` once and pass it in.

### Imports (D-M-14)
- The new exports are added to the **same module** as the existing
  rate-limit adapter (e.g. `throttlekit/express` now exports
  `expressRateLimit`, `expressUnifiedAdmission`, `expressAdaptiveConcurrency`).
- The package exports map in `package.json` already lists each adapter
  module; no new entry points needed.

---

## §11 Composition + L2/federation

The lease-shim (`leaseAsAdmission`) already bridges `ConcurrencyGuard` →
Decision-shaped admission with a separate `release`. No changes needed.

When 0.10.0 lands distributed adaptive concurrency, the
`ConcurrencyGuard` produced by `distributedAdaptiveConcurrency(...)` will
satisfy the same interface (per DR-18 in PLAN.md §6.7: "concurrent slot =
leased token released by EVENT"). The adapter wiring is unchanged — the
release call flows through to whichever guard underlies the admitter.

**Forward-compat invariant (D-M-12):** `expressAdaptiveConcurrency` MUST
accept any `ConcurrencyGuard`, including future distributed variants. We
type the option as `ConcurrencyGuard`, not as the in-process implementation.

---

## §12 Failure modes (additions to docs/FAILURE-MODES.md)

| Mode | Behavior | Recovery |
|---|---|---|
| Forgetting to use the adapter (calling `admit.admit()` directly without lifecycle wiring) | Silent slot leak — adaptive concurrency limit collapses to zero | Use the adapter |
| `admit.admit()` throws (Redis hiccup) | Adapter applies `fail` policy: `open` → next() with no slot; `closed` → 503 | Restore Redis |
| Handler throws AND no error middleware | `close` fires (no `finish`) → `release({dropped: true})` → adaptive correctly contracts | None needed |
| Client hangup mid-stream | Same as above; `close` first | None needed |
| Slow Lua-fused Redis EVALSHA | Same as rate-limit adapter: fail policy applies | Restore Redis |
| Slot held by handler that hangs forever | Slot is held until server-side timeout. **Recommend** wiring a timeout middleware AHEAD of the admission middleware so the timeout-triggered close releases the slot | Add timeout middleware |
| `dropOn5xx: true` and handler returns 500 | release fires with `dropped: true`, adaptive contracts | Application bug |

---

## §13 Decision records

**D-M-1 — Architectural choice: per-primitive, per-framework adapter.**
Rejected: Option A (helper) leaves the failure surface in user code;
Option B (monolithic per-framework) breaks the existing rate-limit
adapter's contract. See §3.

**D-M-2 — `dropped` is a property of the response state, not the handler
outcome.** Default policy table in §5. Override via `dropOn5xx: true` on
lambda (only — other frameworks already observe the close signal
correctly).

**D-M-3 — Exactly-once-release is enforced by first-fire wins + Lease
idempotency.** A per-request `released` flag in the adapter closure, plus
the existing `Lease.release` idempotency, makes the invariant a no-op to
violate. See §6.

**D-M-4 — Headers render from `combineDecisions`.** The combined Decision
is the input to `gate.headersFor`. No new header families. See §7.

**D-M-5 — `lastDecisions()` is captured in the same microtask as the
await result.** Single-threaded JS guarantees no interleaving. See §8.

**D-M-6 — Adapters use `admit.admit()` (async) only.** `admitSync` would
fail on any Redis-backed configuration; the adapter is always async
already. See §6.

**D-M-7 — Web-Request adapters use `TransformStream` for lifecycle
detection.** Falls back to "release on Response creation" if body is null.
See §6.

**D-M-8 — trpc, hono adapters use try/finally wrap pattern.** Same
shape; the `finally` block carries `dropped = thrown`. See §6.

**D-M-9 — gRPC release fires on `sendUnaryData` callback invocation.**
`dropped` iff `error != null || code !== OK`. See §4.

**D-M-10 — Lambda release fires on handler-return or handler-throw.**
Default: thrown ⇒ dropped, returned ⇒ not (even 5xx). Override via
`dropOn5xx: true`. See §5.

**D-M-11 — Nest ships BOTH a guard and an interceptor.** Guards run
pre-handler (deny path); interceptors wrap completion (release path).
Users register both. We could collapse to interceptor-only, but the
guard pattern is the idiomatic deny path in Nest; we mirror it.

**D-M-12 — Adapters accept any `ConcurrencyGuard`, not just the
in-process implementation.** Forward-compat with 0.10.0's distributed
guard. The interface is the substrate; the implementation is opaque.

**D-M-13 — Naming: `<framework>UnifiedAdmission` /
`<framework>AdaptiveConcurrency`.** No `WithRelease` suffix.

**D-M-14 — Exports added to existing adapter modules.** No new
entry points. `throttlekit/express` etc. now export three functions each.

---

## §14 Open questions / future work

**Q1: Should we offer a "build inline" form?**
Today: `expressUnifiedAdmission({ admitter: unifiedAdmission({...}) })`.
Could add: `expressUnifiedAdmission({ rate, concurrency, cost })` that
builds the admitter internally. Defer to 0.9.3 — the inline form is
discoverable but adds an option-shape dimension and we want to ship the
core fix first.

**Q2: Should we offer a "release on Response.body finalization" for
streaming responses?**
Today's design releases on `TransformStream.flush`, which fires when the
stream's readable side closes. For an SSE / chunked-streaming endpoint,
this is "when the last chunk has been sent". For a paused / never-ending
stream, the slot is held for the connection lifetime — which is correct
(the resource IS in use). No change needed; documenting this in
failure-modes.

**Q3: Should `dropOn5xx` be the default?**
We argue no in §5. But it's a policy choice; user feedback may push us
to flip the default in a future major release. The flag is opt-in for
now, opt-out later if needed.

**Q4: Adapter for raw Node http handlers?**
There's no `src/adapters/http.ts` today. The lambda + grpc adapters cover
the non-framework cases. Defer.

**Q5: Should the adapter also surface OpenTelemetry spans?**
The OTel attribute hook for `tk.binding_axis` (TK-1008) is already wired
in `src/observability/otel.ts`. The adapter doesn't need to emit a new
span; the existing limiter span carries the binding axis attribute via
`lastDecisions()`. No change.

---

## §15 References

- `src/admission/unified.ts` — `unifiedAdmission` + `UnifiedAdmitter`
- `src/admission/lease-shim.ts` — `leaseAsAdmission`
- `src/concurrency/adaptive.ts` — `adaptiveConcurrency` + `ConcurrencyGuard`
- `src/adapters/core.ts` — `createGate`, `nodeClientIp`, `edgeClientIp`,
  `trustFrom`
- `src/adapters/express.ts`, `src/adapters/fastify.ts`,
  `src/adapters/hono.ts`, etc. — existing rate-limit adapter pattern
- `examples/unified.ts` — the manual-wiring comment block we are
  replacing
- `research/bigger-bets/unified/DESIGN.md` §4.2.2 — admission ordering
- `research/bigger-bets/PLAN.md` §6.7 — DR-18 (concurrent slot
  semantics)
- Node `http.ServerResponse` docs — finish/close event semantics
- Netflix `concurrency-limits` (Java) Servlet filter — prior art for
  framework-bundled lifecycle wiring

---

**Status:** design locked. TK-1325 (node-server adapters) is the next
step — implements express + fastify + koa + nest variants per §4 and §6,
with the per-adapter test matrix from §9.
