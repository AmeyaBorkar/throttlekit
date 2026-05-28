# Federation real-cluster eval

The reproducible harness behind the federation §4.4 numbers in
`research/bigger-bets/federation/DESIGN.md`. The contribution of bet #77
is most credible when an operator can run the same scaffolding on a real
fly.io / GCP / AWS multi-region cluster and reproduce the Δ = 0 bound +
the utilization recovery vs static partition.

This subtree:

- `docker-compose.yml` — four-Redis local cluster (regional1/2/3 +
  global-coordinator). `regional1..3` are reserved for TK-906 multi-
  process regional escrow; the global coordinator is what `replay.ts`
  currently exercises.
- `replay.ts` — drives an Azure-trace-like skewed workload through K=3
  regions sharing the coordinator; injects cross-region latency
  in-process via a `LatencyProxy` so the docker-compose works without
  toxiproxy / `tc qdisc` privileges.
- `README.md` — this file.

The cloud-run (TK-910) re-uses this same `replay.ts` against real
endpoints; the docker-compose path is for CI + local dev.

## Quickstart

```sh
# 1. Spin up the local cluster.
docker compose -f research/bigger-bets/federation/eval/docker-compose.yml up -d

# 2. Wait a few seconds for the containers to settle.
sleep 3

# 3. Run the replay. Output is JSON on stdout.
npx tsx research/bigger-bets/federation/eval/replay.ts > result.json

# 4. Inspect.
cat result.json | python -m json.tool

# 5. Tear down.
docker compose -f research/bigger-bets/federation/eval/docker-compose.yml down
```

## Output schema

```json
{
  "config": {
    "globalLimit": 1000,
    "regionLatencyMs": 100,
    "batch": 16,
    "windowMs": 60000,
    "windows": 3,
    "skew": 0.6,
    "offeredMultiplier": 1.2
  },
  "metrics": {
    "offered": 3600,
    "admitted": 2950,
    "uOffered": 0.819,
    "uCapacity": 0.983,
    "overshoot": 0,
    "coordTrips": 187,
    "coordTripsPerRequest": 0.052,
    "latencyMs": { "p50": 0.1, "p95": 102.4, "p99": 103.1 },
    "perWindowAdmits": [983, 992, 975]
  }
}
```

Key numbers:

- `overshoot` should be **0** — the headline Δ = 0 claim.
- `uCapacity` should be **close to 1** (typically > 0.95) — the
  utilization recovery vs static partition's L/K (PLAN.md / DESIGN.md
  §4 / baselines.md §2).
- `coordTripsPerRequest` should be **≈ 1/batch** (here, 1/16 = 0.0625) —
  the amortization argument.
- `latencyMs.p99` is dominated by `regionLatencyMs` on cache-miss
  requests; in-region hits are sub-ms.

## Tuning knobs

All driven by env vars; defaults are documented in `replay.ts`:

| Env var | Default | What it does |
|---|---:|---|
| `TK_FED_COORD_URL` | `redis://localhost:16380` | Coordinator URL (override for cloud) |
| `REGION_LATENCY_MS` | `100` | Injected cross-region RTT (set 0 for local) |
| `GLOBAL_LIMIT` | `1000` | Per-window budget L |
| `BATCH` | `16` | Per-region escrow size |
| `WINDOW_MS` | `60000` | Window length (60s) |
| `WINDOWS` | `3` | Number of windows to drive |
| `SKEW` | `0.6` | Workload skew (0=uniform, 1=all-on-us-east) |
| `OFFERED_MULT` | `1.2` | Offered load multiplier (1.2× global budget) |

## Cloud-run notes (for TK-910)

Replace `TK_FED_COORD_URL` with a real cloud Redis endpoint
(`redis://your-elasticache:6379`, etc.) and set `REGION_LATENCY_MS=0`
(the network now provides real RTT instead of simulated). Run
`replay.ts` from three separate cloud nodes (one per region) and merge
the per-node JSON outputs.

For the paper-quality eval, point each replay node at the same
coordinator URL but vary the `SKEW` env across runs to characterize the
recovery curve as a function of skew — this regenerates the table in
`baselines.md` §3 with real cross-region latency.

## What is NOT in this scaffolding

- **Real cross-region latency.** Simulated via `LatencyProxy` for the
  local docker-compose. The eval in TK-910 uses real network latency.
- **Multi-process regional escrow** (TK-906+). The current `replay.ts`
  uses per-process escrow; the `regional1..3` Redis containers in the
  compose file are reserved for that work.
- **Failure injection.** Outages aren't injected here; the failure-mode
  tests in `test/federation/failure-modes.test.ts` cover that
  exhaustively under controlled conditions.
- **Cost recording.** Coordinator round trips are counted; the
  utility-per-cost analysis (admit/RTT, admit/$) is part of TK-910's
  paper writeup.
