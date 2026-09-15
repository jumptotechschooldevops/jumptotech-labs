# RB-19 — Host memory, disk and CPU pressure

**Alerts:** `HostMemoryCritical`, `HostDiskSpaceCritical` (critical);
`HostMemoryPressure`, `HostDiskSpaceLow`, `HostCpuSaturated` (warning)
**Source:** the API container reads `/proc/meminfo`, `/proc/loadavg` and statfs.
The kernel does not namespace these, so they are the host's figures.
`filesystem="container_root"` is Docker's storage: images, containers and named
volumes, PostgreSQL's data included by default. `filesystem="backup_status"` is
the filesystem holding `BACKUP_STATUS_DIR`.
**Blast radius:** a full `container_root` stops sandbox creation and PostgreSQL
writes. Memory exhaustion makes the kernel kill processes, and it can pick
PostgreSQL.

Commands use `prod` and `q` from [private-beta-operations.md §1](private-beta-operations.md).

## 1. Confirm it is real

```bash
q 'jtt:host_memory_available:ratio'
q 'jtt:host_filesystem_available:ratio'
q 'jtt:host_load5_per_cpu:ratio'
free -m
df -h / /var/lib/docker /srv/jumptotech/backups
docker system df
docker stats --no-stream
```

## 2. Scope it

- Which filesystem, and is it growing (`q 'deriv(jtt_host_filesystem_available_bytes[1h])'`)?
- Memory and CPU: which container (`docker stats`)? Five sandboxes at their
  limits (`SANDBOX_MEMORY`, `DOCKER_SANDBOX_MEMORY`) is the designed maximum;
  anything above that is something else.

## 3. Immediate mitigation

- **Stop new launches** if a critical alert fires (operations runbook §3).
- **Disk:** reclaim only what is safe.
  ```bash
  docker container prune --filter "label=jumptotech.io/runtime-owner=$RUNTIME_OWNER_ID"   # stopped platform sandboxes
  docker image prune            # dangling layers only
  ```
  **Never** `docker volume prune` or `docker system prune --volumes`: with the
  stack stopped they delete the PostgreSQL volume. Do not remove
  `jumptotech/lab-*` images; the labs need them. Old backups are removed by the
  script's retention, never by hand below the newest.
- **Memory:** end abandoned sessions ([RB-04](RB-04-capacity.md)), or lower
  `MAX_ACTIVE_SESSIONS` and `prod up -d api` until the cause is known.

## 4. Diagnose

1. Leaked sandboxes: `q 'jtt:sandbox_leak:count'` ([RB-05](RB-05-cleanup-and-leaks.md)).
2. Container logs filling the disk:
   `du -sh /var/lib/docker/containers/* | sort -h | tail`.
3. Prometheus data: 15 days of retention, normally small at this scale.
4. A process outside the stack: `ps aux --sort=-%mem | head`.

## 5. Fix

Whatever section 4 found. A host that is simply too small for five concurrent
labs is a sizing decision, not a fix.

## 6. Verify recovery

- The ratios back above 15% free disk and 10% available memory.
- `ready api 9400`, `prod ps postgres` healthy.
- A lab starts.

## 7. What this does NOT mean

- **Not a container limit.** A single container killed at its own memory limit
  shows `OOMKilled` in `docker inspect` with the host fine: RB-01.
- **Load above the CPU count is not always CPU.** Load average counts
  processes waiting on disk too; check `docker stats` and I/O before blaming
  sandboxes.

## 8. Escalate when

`HostDiskSpaceCritical` on `container_root` with PostgreSQL in the stack, or
memory critical with PostgreSQL restarting.

## 9. Follow-up

Per-container, per-disk and network detail needs a host exporter — DECISION
REQUIRED (operations runbook §8).
