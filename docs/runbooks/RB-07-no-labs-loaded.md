# RB-07 — No labs loaded, or lab definitions rejected

**Alerts:** `NoLabsLoaded` (critical), `LabDefinitionErrors` (warning)
**Blast radius:** `NoLabsLoaded` → the catalogue is empty and nothing can start.
`LabDefinitionErrors` → only the rejected labs are missing.

## 1. Confirm it is real

```promql
jtt_labs_loaded        # expected: 114
jtt_lab_load_errors    # expected: 0
```

```bash
curl -s localhost:4000/health | jq '{labsLoaded, labLoadErrors}'
```

## 2. Scope it

Zero labs is a mount or path problem. Non-zero with errors is content.

## 3. Immediate mitigation

None. Labs are read once at startup, so a fix needs a restart either way.

## 4. Diagnose

1. `docker compose logs api | grep '"event":"config.loaded"'` — the startup line
   names every rejected definition with its validation error.
2. `LABS_DIR` must be `/app/labs` in the container, and `./labs` must be
   bind-mounted read-only. `docker compose config | grep -A5 'source: ./labs'`.
3. `docker compose exec api ls /app/labs` — an empty directory is a mount that
   did not attach.
4. A rejected lab is rejected on purpose: duplicate id, duplicate slug, dangling
   prerequisite, prerequisite cycle, unsupported requirement type, or a
   requirement its provider cannot verify. The message says which.

## 5. Fix

Correct the mount or the `lab.yaml`, then `docker compose up -d api`.

## 6. Verify recovery

- `jtt_labs_loaded == 114` and `jtt_lab_load_errors == 0`.
- `GET /api/labs` returns the full catalogue.
- Start one lab from the previously-missing track.

## 7. What this does NOT mean

- **Not a provider problem.** A lab that loads but cannot start is RB-03/RB-09.
  Loading is about the definition file; starting is about the substrate.

## 8. Escalate when

The definitions are correct and unchanged but the mount will not attach.

## 9. Follow-up

Lab definitions are read once at startup, so adding a lab needs a restart. That
is a known limitation, and it is why this alert is worth having: a bad content
deploy is otherwise invisible until a student clicks the missing lab.
