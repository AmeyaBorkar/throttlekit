"""ThrottleKit cross-repo battle test — a realistic, multi-process distributed workload.

Stands up a 3-instance ``throttlekit-server`` fleet sharing one real Redis, then drives every axis from
the Python client (``throttlekit-py``) through BOTH delivery doors — the gRPC ``ServiceBackend`` and the
direct ``RedisBackend`` (vendored Lua -> Redis) — under concurrent, closed-loop load. Each phase asserts
a real-world invariant (distributed cap exactness, concurrency never exceeds the cap, the windowCoupled
overshoot bound, crash-reclaim, heartbeat keep-alive, one-oracle/two-door state sharing, ...) and the run
prints a structured pass/fail report and exits non-zero if any phase fails.

The Node *core* is exercised transitively here (the server IS the core); the core engine's native
in-process path + perf are battle-tested separately by ``npm run bench`` (see this folder's README).

Prerequisites
-------------
* The server is built:           (repo root) ``cd server && npm install && npm run build``
* The Python client is installed: ``pip install throttlekit-py`` (or ``pip install -e .`` in throttlekit-py),
  plus a redis client (``pip install redis``). Run THIS script with that interpreter.
* A Redis is reachable. Override the default with ``THROTTLEKIT_REDIS_URL`` (defaults to the repo's local
  test Redis at ``redis://localhost:6380``).

Run
---
    THROTTLEKIT_REDIS_URL=redis://localhost:6380 python battletest.py
"""

from __future__ import annotations

import os
import random
import socket
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import redis

try:  # Windows consoles default to cp1252, which can't encode glyphs like "->"; force UTF-8.
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

from throttlekit import (
    FixedWindow,
    Gcra,
    RedisBackend,
    ServiceBackend,
    SlidingWindow,
    SlidingWindowLog,
    TokenBucket,
)
from throttlekit.errors import OperationNotSupportedError, PolicyNotFoundError

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.normpath(os.path.join(HERE, "..", "..", ".."))  # research/polyglot/battle-test -> root
SERVER_BIN = os.path.join(REPO_ROOT, "server", "dist", "bin.js")
CONFIG = os.path.join(HERE, "config.yaml")
CRASH_HOLDER = os.path.join(HERE, "crash_holder.py")
REDIS_URL = os.environ.get("THROTTLEKIT_REDIS_URL", "redis://localhost:6380")
RUNID = f"blt{os.getpid()}"
N_FLEET = 3
VENV_PY = sys.executable  # we are launched with the client's interpreter; reuse it for the crash subprocess
SERVER_LOG_DIR = os.path.join(tempfile.gettempdir(), f"tk-battletest-{RUNID}")

r = redis.Redis.from_url(REDIS_URL)
results: list[tuple[str, bool, str]] = []


# --------------------------------------------------------------------------------------------------
# Fleet / infra helpers
# --------------------------------------------------------------------------------------------------
def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_port(port: int, timeout: float = 20.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        with socket.socket() as s:
            s.settimeout(0.5)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.1)
    return False


def start_server(port: int) -> tuple[subprocess.Popen, object]:
    os.makedirs(SERVER_LOG_DIR, exist_ok=True)
    log = open(os.path.join(SERVER_LOG_DIR, f"server-{port}.log"), "w")
    proc = subprocess.Popen(
        [
            "node",
            SERVER_BIN,
            "--config",
            CONFIG,
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--redis",
            REDIS_URL,
            "--redis-prefix",
            RUNID,
        ],
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    return proc, log


def clean_keys() -> int:
    keys = list(r.scan_iter(match=f"{RUNID}:*", count=2000))
    if keys:
        r.delete(*keys)
    return len(keys)


def record(name: str, ok: bool, detail: str) -> None:
    results.append((name, ok, detail))
    mark = "PASS" if ok else "FAIL"
    line = f"  [{mark}] {name}: {detail}"
    try:
        print(line, flush=True)
    except UnicodeEncodeError:  # never let a glyph in a detail string masquerade as a phase failure
        print(line.encode("ascii", "replace").decode("ascii"), flush=True)


def run_phase(name: str, fn) -> None:
    print(f"\n=== {name} ===", flush=True)
    t0 = time.time()
    try:
        ok, detail = fn()
        record(name, ok, f"{detail}  ({time.time() - t0:.1f}s)")
    except Exception as exc:  # a phase blowing up is itself a failure, not a crash of the harness
        record(name, False, f"EXCEPTION {type(exc).__name__}: {exc}  ({time.time() - t0:.1f}s)")


def calibrate_rate(be: ServiceBackend, policy: str, key: str, guess: int) -> int:
    """Single-thread: how many requests are admitted from a fresh key before the first denial."""
    allowed = 0
    for _ in range(guess * 3 + 20):
        if be.check(policy, key).allowed:
            allowed += 1
        else:
            break
    return allowed


# --------------------------------------------------------------------------------------------------
# Phase A — distributed rate cap: 3 servers, one shared limit, exact count (the flagship)
# --------------------------------------------------------------------------------------------------
def phase_distributed_rate(fleet: list[ServiceBackend]):
    cap = calibrate_rate(fleet[0], "api", f"calib-api-{RUNID}", 200)
    assert cap == 200, f"expected gcra burst cap 200, calibrated {cap}"

    keys = [f"apiK{i}-{RUNID}" for i in range(3)]
    allowed = {k: 0 for k in keys}
    lock = threading.Lock()

    # Build a shuffled work list: 2*cap requests per key, each routed round-robin to one of 3 servers.
    work = []
    for k in keys:
        for i in range(cap * 2):
            work.append((k, fleet[i % len(fleet)]))
    random.shuffle(work)

    def do(item):
        k, be = item
        if be.check("api", k).allowed:
            with lock:
                allowed[k] += 1

    with ThreadPoolExecutor(max_workers=24) as ex:
        list(ex.map(do, work))

    per_key = list(allowed.values())
    ok = all(v == cap for v in per_key)
    naive = len(fleet) * cap
    return ok, (
        f"3 servers / shared Redis, {len(work)} reqs over 3 keys -> allowed/key={per_key} "
        f"(each must == {cap}; a naive per-instance limiter would leak up to {naive}/key)"
    )


def phase_read_surface(fleet: list[ServiceBackend]):
    pk = f"peek-{RUNID}"
    p1 = fleet[0].peek("api", pk)
    p2 = fleet[0].peek("api", pk)
    non_consuming = p1.remaining == p2.remaining and p1.allowed
    fleet[0].check("api", pk)
    p3 = fleet[0].peek("api", pk)
    # A consuming check reduces remaining by ~1. Allow a drop of 2: on a non-monotonic wall clock
    # (notably Windows Date.now()) a tiny backward step between the check and this peek can knock the
    # gcra `remaining` floor down one extra cell. The allow/deny *decision* is unaffected (the 18s
    # emission interval dwarfs any ms-scale jitter) — only this introspection field is boundary-sensitive.
    decrements = 1 <= (p1.remaining - p3.remaining) <= 2
    fc = fleet[0].forecast("api", f"fc-{RUNID}")
    forecast_ok = fc.spendable_now > 0
    cm = fleet[0].check_many("api", [f"cm1-{RUNID}", f"cm2-{RUNID}", f"cm3-{RUNID}"])
    many_ok = len(cm) == 3 and all(d.allowed for d in cm)
    ok = non_consuming and decrements and forecast_ok and many_ok
    return ok, (
        f"peek non-consuming={non_consuming} (rem {p1.remaining}=={p2.remaining}), "
        f"peek-after-check decrements={decrements} ({p1.remaining}->{p3.remaining}), "
        f"forecast.spendable_now={fc.spendable_now}, check_many={[d.allowed for d in cm]}"
    )


def phase_wrong_axis_errors(fleet: list[ServiceBackend]):
    checks = {}
    try:
        fleet[0].admit("api", "x")
        checks["admit_on_rate"] = False
    except OperationNotSupportedError:
        checks["admit_on_rate"] = True
    try:
        fleet[0].debit("api", "x", 5)
        checks["debit_on_rate"] = False
    except OperationNotSupportedError:
        checks["debit_on_rate"] = True
    try:
        fleet[0].check("checkout", "x")
        checks["check_on_admitter"] = False
    except OperationNotSupportedError:
        checks["check_on_admitter"] = True
    try:
        fleet[0].check("does-not-exist", "x")
        checks["unknown_policy"] = False
    except PolicyNotFoundError:
        checks["unknown_policy"] = True
    ok = all(checks.values())
    return ok, f"operational faults map correctly: {checks}"


# --------------------------------------------------------------------------------------------------
# Phase B — direct door (RedisBackend): every strategy enforces, atomically under concurrency
# --------------------------------------------------------------------------------------------------
def phase_direct_door_strategies(_fleet):
    specs = [
        ("gcra", Gcra(limit=100, period_ms=3_600_000, burst=100), 100, "exact"),
        ("tokenBucket", TokenBucket(capacity=80, refill_per_sec=1), 80, "range"),
        ("fixedWindow", FixedWindow(limit=90, window_ms=3_600_000), 90, "exact"),
        ("slidingWindow", SlidingWindow(limit=70, window_ms=3_600_000, buckets=10), 70, "exact"),
        ("slidingWindowLog", SlidingWindowLog(limit=60, window_ms=3_600_000), 60, "exact"),
    ]
    detail = []
    all_ok = True
    for kind, strat, cap, mode in specs:
        rb = RedisBackend(r, strat, prefix=f"{RUNID}:direct:{kind}")
        key = f"k-{kind}"
        allowed = 0
        for _ in range(cap * 2):
            if rb.check(key).allowed:
                allowed += 1
            else:
                break
        if mode == "exact":
            ok = allowed == cap
        else:  # token bucket may pick up <1 refilled token over the sub-second loop
            ok = cap <= allowed <= cap + 2
        all_ok = all_ok and ok
        detail.append(f"{kind}={allowed}/{cap}{'' if ok else ' !!'}")

    # Atomicity: 16 threads hammer one fresh gcra key; the Lua must admit exactly the cap (no double-spend).
    rb = RedisBackend(r, Gcra(limit=100, period_ms=3_600_000, burst=100), prefix=f"{RUNID}:direct:atom")
    akey = "atomic"
    got = {"n": 0}
    lock = threading.Lock()

    def hit(_):
        if rb.check(akey).allowed:
            with lock:
                got["n"] += 1

    with ThreadPoolExecutor(max_workers=16) as ex:
        list(ex.map(hit, range(300)))
    atom_ok = got["n"] == 100
    all_ok = all_ok and atom_ok
    detail.append(f"atomic(16 threads,300 reqs)={got['n']}/100{'' if atom_ok else ' !!'}")
    return all_ok, "; ".join(detail)


# --------------------------------------------------------------------------------------------------
# Phase C — one oracle, two doors, one bucket: service-door + direct-door share Redis state
# --------------------------------------------------------------------------------------------------
def phase_two_doors_one_bucket(fleet: list[ServiceBackend]):
    # Discover the exact Redis key the service door writes for ("api", <key>), so the direct backend
    # can be pointed at the same bucket.
    probe = f"xdoor-probe-{RUNID}"
    fleet[0].check("api", probe)
    found = [k.decode() for k in r.scan_iter(match=f"*{probe}*", count=1000)]
    assert len(found) == 1, f"probe matched {found}"
    full = found[0]
    assert full.endswith(probe)
    direct_prefix = full[: -len(probe)].rstrip(":")

    rb = RedisBackend(r, Gcra(limit=200, period_ms=3_600_000, burst=200), prefix=direct_prefix)

    key = f"shared-{RUNID}"
    combined = service_n = direct_n = 0
    for i in range(400):
        if i % 2 == 0:
            if fleet[0].check("api", key).allowed:
                service_n += 1
                combined += 1
        else:
            if rb.check(key).allowed:
                direct_n += 1
                combined += 1
    # One shared bucket ⇒ ~200 combined (NOT 400). Both doors must have drawn from it.
    ok = abs(combined - 200) <= 1 and service_n > 0 and direct_n > 0
    return ok, (
        f"key='{full}' reached by both doors; combined allowed={combined} "
        f"(service={service_n}+direct={direct_n}); two separate buckets would give 400"
    )


# --------------------------------------------------------------------------------------------------
# Phase D — cost axis (LLM-gateway token budget): per-tenant isolation, stops at the budget
# --------------------------------------------------------------------------------------------------
def phase_cost_axis(fleet: list[ServiceBackend]):
    budget, chunk, tenants = 100_000, 1000, 4
    out: dict[str, tuple] = {}
    lock = threading.Lock()

    def stream(tkey):
        admitted = 0
        first_deny = False
        allowed_after_deny = 0
        for _ in range(budget // chunk + 10):
            d = fleet[0].debit("completions", tkey, chunk)
            if d.allowed:
                admitted += chunk
                if first_deny:
                    allowed_after_deny += 1
            else:
                first_deny = True
        with lock:
            out[tkey] = (admitted, first_deny, allowed_after_deny)

    ts = [threading.Thread(target=stream, args=(f"tenant{i}-{RUNID}",)) for i in range(tenants)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()

    ok = all(
        budget <= adm < budget + chunk and deny and after == 0 for (adm, deny, after) in out.values()
    )
    summary = ", ".join(f"{k.split('-')[0]}={v[0]}" for k, v in sorted(out.items()))
    return ok, (
        f"{tenants} tenants stream in {chunk}-token debits; each admits {summary} "
        f"(budget={budget}; stops in [{budget},{budget + chunk}); none admitted after deny; isolated per key)"
    )


# --------------------------------------------------------------------------------------------------
# Phase E — concurrency axis: in-flight never exceeds the pinned cap under heavy oversubscription
# --------------------------------------------------------------------------------------------------
def phase_concurrency(fleet: list[ServiceBackend]):
    cap, workers, duration = 8, 40, 3.0
    st = {"live": 0, "max": 0, "granted": 0, "denied": 0}
    lock = threading.Lock()
    stop = time.time() + duration
    key = f"checkoutMain-{RUNID}"

    def worker():
        while time.time() < stop:
            adm = fleet[0].admit("checkout", key)
            if adm.allowed:
                with lock:
                    st["live"] += 1
                    st["granted"] += 1
                    st["max"] = max(st["max"], st["live"])
                time.sleep(random.uniform(0.015, 0.045))
                with lock:
                    st["live"] -= 1
                adm.release()
            else:
                with lock:
                    st["denied"] += 1
                time.sleep(0.002)

    threads = [threading.Thread(target=worker) for _ in range(workers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    ok = st["max"] <= cap and st["max"] == cap and st["denied"] > 0
    return ok, (
        f"{workers} workers vs cap={cap} for {duration}s -> max concurrent in-flight={st['max']} "
        f"(must be <= {cap} and reach {cap}); granted={st['granted']}, denied={st['denied']}"
    )


# --------------------------------------------------------------------------------------------------
# Phase F — unified rate x concurrency: the correct axis binds, and is reported
# --------------------------------------------------------------------------------------------------
def phase_unified(fleet: list[ServiceBackend]):
    # (i) concurrency binds: hold slots so the cap (4) is the binding constraint
    cap, workers, duration = 4, 16, 2.0
    st = {"live": 0, "max": 0, "conc_deny": 0, "rate_deny": 0, "granted": 0}
    lock = threading.Lock()
    stop = time.time() + duration
    key_cc = f"uaCC-{RUNID}"

    def worker():
        while time.time() < stop:
            adm = fleet[0].admit("unified-api", key_cc)
            if adm.allowed:
                with lock:
                    st["live"] += 1
                    st["granted"] += 1
                    st["max"] = max(st["max"], st["live"])
                time.sleep(random.uniform(0.05, 0.1))
                with lock:
                    st["live"] -= 1
                adm.release()
            else:
                with lock:
                    if adm.binding_axis == "concurrency":
                        st["conc_deny"] += 1
                    elif adm.binding_axis == "rate":
                        st["rate_deny"] += 1
                time.sleep(0.003)

    threads = [threading.Thread(target=worker) for _ in range(workers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    conc_ok = st["max"] <= cap and st["conc_deny"] > 0

    # (ii) rate binds: admit+release immediately (concurrency never > 1) so GCRA burst (50) is the wall
    key_rate = f"uaRATE-{RUNID}"
    allowed = rate_deny = conc_deny2 = 0
    for _ in range(120):
        adm = fleet[0].admit("unified-api", key_rate)
        if adm.allowed:
            allowed += 1
        elif adm.binding_axis == "rate":
            rate_deny += 1
        elif adm.binding_axis == "concurrency":
            conc_deny2 += 1
        adm.release()
    rate_ok = 49 <= allowed <= 51 and rate_deny > 0 and conc_deny2 == 0

    ok = conc_ok and rate_ok
    return ok, (
        f"(i) concurrency-bound: max in-flight={st['max']}<= {cap}, concurrency-denials={st['conc_deny']}; "
        f"(ii) rate-bound: allowed={allowed}~=50, rate-denials={rate_deny}, concurrency-denials={conc_deny2}"
    )


# --------------------------------------------------------------------------------------------------
# Phase G — crash safety: a killed client's held slots are reclaimed on lease-TTL expiry
# --------------------------------------------------------------------------------------------------
def phase_crash_reclaim(fleet: list[ServiceBackend], port0: int):
    key = f"crash-{RUNID}"
    target = f"127.0.0.1:{port0}"
    proc = subprocess.Popen(
        [VENV_PY, CRASH_HOLDER, target, "checkout", key, "8"],
        stdout=subprocess.PIPE,
        text=True,
    )
    line = proc.stdout.readline().strip()  # "HELD 8"
    held = int(line.split()[1])
    assert held == 8, f"holder grabbed {held}/8"

    before = fleet[0].admit("checkout", key)
    full_blocked = not before.allowed
    before.release()

    proc.kill()  # SIGKILL: no graceful Release, no heartbeat → orphaned leases
    proc.wait()

    # lease TTL is 2s and the server sweeps every 1s; give it generous margin
    deadline = time.time() + 8.0
    reclaimed = False
    while time.time() < deadline:
        adm = fleet[0].admit("checkout", key)
        if adm.allowed:
            adm.release()
            reclaimed = True
            break
        time.sleep(0.5)

    ok = full_blocked and reclaimed
    return ok, (
        f"child held 8/8 (9th blocked={full_blocked}); after SIGKILL the orphaned slots were "
        f"reclaimed on TTL expiry (admit succeeded again={reclaimed})"
    )


# --------------------------------------------------------------------------------------------------
# Phase H — heartbeat keeps a long hold alive past the lease TTL
# --------------------------------------------------------------------------------------------------
def phase_heartbeat(port0: int):
    target = f"127.0.0.1:{port0}"
    key = f"hb-{RUNID}"
    c1 = ServiceBackend(target, heartbeat_interval=1.0)
    c2 = ServiceBackend(target)
    try:
        adm = c1.admit("single", key, heartbeat=True)  # cap=1 policy
        assert adm.allowed and adm.held
        time.sleep(3.5)  # well past the 2s TTL; the pump beats every 1s
        adm2 = c2.admit("single", key)  # the slot must still be held (not reclaimed)
        still_held = (not adm2.allowed) and (not adm.reclaimed)
        adm2.release()
        adm.release()  # now free it
        adm3 = c2.admit("single", key)
        freed = adm3.allowed
        adm3.release()
    finally:
        c1.close()
        c2.close()
    ok = still_held and freed
    return ok, (
        f"heartbeated cap-1 hold survived 3.5s > 2s TTL (2nd admit blocked={still_held}, "
        f"not reclaimed); after release the slot freed (3rd admit={freed})"
    )


# --------------------------------------------------------------------------------------------------
# Phase I — two-tier leased: the windowCoupled overshoot bound holds across the fleet
# --------------------------------------------------------------------------------------------------
def phase_leased_overshoot(fleet: list[ServiceBackend]):
    limit = 500
    key = f"leased-{RUNID}"
    allowed = {"n": 0}
    lock = threading.Lock()
    work = [fleet[i % len(fleet)] for i in range(limit * 3)]  # demand 3x the budget
    random.shuffle(work)

    def do(be):
        if be.check("leased-api", key).allowed:
            with lock:
                allowed["n"] += 1

    with ThreadPoolExecutor(max_workers=24) as ex:
        list(ex.map(do, work))

    n = allowed["n"]
    naive = len(fleet) * limit
    # windowCoupled ⇒ total admitted across the whole fleet <= limit (fleet-size-independent).
    ok = n <= limit and n >= int(limit * 0.6)
    return ok, (
        f"3-server fleet, {len(work)} reqs (3x budget) on one leased key -> total allowed={n} "
        f"(windowCoupled bound: <= {limit}; a naive per-instance limiter would admit up to {naive})"
    )


# --------------------------------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------------------------------
def main() -> int:
    print(f"ThrottleKit battle test — runid={RUNID}", flush=True)
    print(f"Redis: {REDIS_URL}  |  fleet: {N_FLEET} servers  |  config: {CONFIG}", flush=True)
    print(f"Server bin: {SERVER_BIN}", flush=True)
    if not os.path.exists(SERVER_BIN):
        print(f"FATAL: server is not built ({SERVER_BIN}). Run `npm run build` in server/.")
        return 1
    try:
        assert r.ping()
    except Exception as exc:
        print(f"FATAL: Redis not reachable at {REDIS_URL}: {exc}")
        return 1
    clean_keys()

    ports = [free_port() for _ in range(N_FLEET)]
    procs = []
    logs = []
    print(f"\nStarting fleet on ports {ports} (shared Redis, prefix={RUNID}) ...", flush=True)
    for p in ports:
        proc, log = start_server(p)
        procs.append(proc)
        logs.append(log)
    for p in ports:
        if not wait_port(p):
            print(f"FATAL: server on :{p} did not come up — see {SERVER_LOG_DIR}/server-{p}.log")
            for pr in procs:
                pr.terminate()
            return 1
    print("Fleet is up.", flush=True)

    fleet = [ServiceBackend(f"127.0.0.1:{p}") for p in ports]
    try:
        run_phase("A. distributed rate cap (3 servers, one limit, exact count)", lambda: phase_distributed_rate(fleet))
        run_phase("A2. read surface (peek / forecast / check_many)", lambda: phase_read_surface(fleet))
        run_phase("A3. operational faults (UNIMPLEMENTED / NOT_FOUND)", lambda: phase_wrong_axis_errors(fleet))
        run_phase("B. direct door — all 5 strategies + Lua atomicity", lambda: phase_direct_door_strategies(fleet))
        run_phase("C. one oracle, two doors, one shared bucket", lambda: phase_two_doors_one_bucket(fleet))
        run_phase("D. cost axis — per-tenant token budgets (LLM gateway)", lambda: phase_cost_axis(fleet))
        run_phase("E. concurrency axis — in-flight never exceeds the cap", lambda: phase_concurrency(fleet))
        run_phase("F. unified rate x concurrency — correct binding axis", lambda: phase_unified(fleet))
        run_phase("G. crash safety — orphaned leases reclaimed on TTL", lambda: phase_crash_reclaim(fleet, ports[0]))
        run_phase("H. heartbeat — long hold survives past the TTL", lambda: phase_heartbeat(ports[0]))
        run_phase("I. two-tier leased — windowCoupled overshoot bound", lambda: phase_leased_overshoot(fleet))
    finally:
        for be in fleet:
            be.close()
        print("\nTearing down fleet ...", flush=True)
        for proc in procs:
            proc.terminate()
        for proc in procs:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        for log in logs:
            log.close()
        removed = clean_keys()
        print(f"Cleaned {removed} Redis keys under {RUNID}:*", flush=True)

    # ---- report ----
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print("\n" + "=" * 96)
    print(f"BATTLE TEST REPORT — {passed}/{total} phases passed")
    print("=" * 96)
    for name, ok, _detail in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    print("=" * 96, flush=True)
    return 0 if passed == total else 2


if __name__ == "__main__":
    sys.exit(main())
