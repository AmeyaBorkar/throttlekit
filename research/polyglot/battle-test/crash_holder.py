"""A worker that grabs N concurrency leases and then holds them forever — until it is killed.

Used by the battle test's crash-safety phase: the parent fills a policy's cap from this child, kills
it with SIGKILL (no graceful release, no heartbeat), and then asserts the server reclaims the orphaned
slots once their lease TTL lapses. From the server's side this is indistinguishable from a real client
crash.

    python crash_holder.py <host:port> <policy> <key> <n>

Prints `HELD <count>` once it has grabbed the leases (so the parent can synchronize), then blocks.
"""

import sys
import time

from throttlekit import ServiceBackend

target, policy, key, n = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])

backend = ServiceBackend(target)
held = []
for _ in range(n):
    adm = backend.admit(policy, key)  # default: no heartbeat
    if adm.allowed:
        held.append(adm)

print(f"HELD {len(held)}", flush=True)

# Hold the slots open until the parent kills us. We deliberately never release and never heartbeat.
while True:
    time.sleep(3600)
