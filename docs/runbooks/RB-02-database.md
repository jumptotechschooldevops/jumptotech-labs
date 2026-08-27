# RB-02 — Database unhealthy

**Alerts:** `DatabaseDown` (critical), `DatabasePoolSaturated` (warning),
`ProgressStoreIsMemory` (critical)
**Typical cause:** container stopped, disk full, connection exhaustion
**Blast radius:** sessions, ownership, progress and browser sign-ins. The
catalogue keeps serving from memory, so the site looks alive and nothing works.

## 1. Confirm it is real

```promql
jtt_db_up
jtt_db_pool_connections{state="waiting"}
```

**Read both before deciding what this is.**

| `jtt_db_up` | `waiting` | Meaning |
|---|---|---|
| 0 | — | The database is unreachable. Section 4a. |
| 1 | > 0 | The database is fine; the app is starved of connections. Section 4b. |
| 1 | 0 | Whatever paged you has recovered. Confirm before standing down. |

Those two present identically to a student — everything is slow — and have
completely different fixes. This is the distinction the dashboard exists for.

## 2. Scope it

```bash
docker compose ps postgres
curl -s localhost:9400/readyz | jq '.data.checks[] | select(.name=="database")'
```

## 3. Immediate mitigation

```bash
docker compose restart postgres
docker compose restart api      # only after postgres is accepting connections
```

The API does **not** need a restart for the database to come back — the pool
reconnects and `jtt_db_up` returns to 1 on its own. Restart it only if the pool
is stuck.

## 4a. Diagnose — unreachable

1. `docker compose logs --tail=100 postgres`.
2. `docker compose exec postgres pg_isready` — running but refusing connections
   is different from not running.
3. **Disk.** `df -h`, and `docker system df`. A full disk is the commonest cause
   of a Postgres that starts and then refuses writes.
4. Memory: `docker inspect ... State.OOMKilled`.
5. A dirty shutdown recovering WAL can take minutes. The logs say so; wait
   rather than restarting into the middle of it.

## 4b. Diagnose — pool saturated

1. `jtt_db_query_duration_seconds` p95 by `operation` — one slow operation
   holding connections starves everything else.
2. In psql:
   ```sql
   SELECT pid, state, wait_event_type, now() - query_start AS age
     FROM pg_stat_activity
    WHERE state <> 'idle' ORDER BY age DESC LIMIT 20;
   ```
3. `DB_MAX_CONNECTIONS` too low for the instance count, or a query with no
   index. `statement_timeout` is configured; a query surviving it is a lock.

## 4c. Diagnose — `ProgressStoreIsMemory`

Not an outage. `DATABASE_URL` is unset, so the API is running on the in-memory
store and **a restart will silently discard every student's progress**. It says
so once at startup, in a line nobody re-reads three weeks later. Set
`DATABASE_URL` and redeploy.

## 5. Fix

Per section 4. If the volume is corrupt, restore from backup.

> **There is no backup procedure yet.** PLATFORM-003 did not add one and this
> runbook will not pretend otherwise. A corrupt volume today means losing
> learning history. Backup and restore is PLATFORM-006 scope; until then, treat
> the `postgres-data` volume as the only copy that exists.

## 6. Verify recovery

- `jtt_db_up == 1` for two scrapes.
- `/readyz` 200 with `database: ok`.
- `jtt_migration_version_info` reports `004_auth_sessions` — the schema is
  intact and this is not a fresh, empty volume.
- `jtt_db_pool_connections{state="waiting"} == 0`.
- One lab starts; `jtt_lab_start_total{outcome="success"}` increments.
- One sign-in works; `jtt_auth_sessions_active > 0`.
- `jtt:sandbox_leak:count` back to baseline within two reaper intervals.

## 7. What this does NOT mean

- **Not `ServiceDown`.** The API stays up and keeps serving the catalogue,
  which is why the site looks fine while nothing works.
- **Not a lab-content problem**, even though `LabStartsFailingHard` fires
  alongside — it is inhibited by `DatabaseDown` for exactly this reason.

## 8. Escalate when

Data loss is suspected, `pg_isready` fails after a clean restart, or the volume
will not mount.

## 9. Follow-up

- Attempts open when the database died are closed as `EXPIRED` by the sweeper
  once it is older than the absolute session lifetime. No action needed.
- If the outage exceeded `MAX_SESSION_MINUTES`, expect a burst of reaper
  activity as the backlog clears.
