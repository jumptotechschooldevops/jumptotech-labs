# RB-07 — No labs loaded, or lab definitions rejected

**Alerts:** `NoLabsLoaded` (critical), `LabDefinitionErrors` (warning)
**Blast radius:** `NoLabsLoaded` → the catalogue is empty and nothing can start.
`LabDefinitionErrors` → only the rejected labs are missing.

Commands use `prod` and `q` from [private-beta-operations.md §1](private-beta-operations.md).
The expected count is the number of `labs/**/lab.yaml` files in the deployed
checkout: `find labs -name lab.yaml | wc -l` (117 at the time of writing;
`npm run validate:labs` prints it too).

## 1. Confirm it is real

```promql
jtt_labs_loaded        # expected: the checkout's lab.yaml count
jtt_lab_load_errors    # expected: 0
```

```bash
prod exec -T api node -e "fetch('http://127.0.0.1:4000/health').then(r=>r.json()).then(b=>console.log(b.data.labsLoaded, JSON.stringify(b.data.labLoadErrors)))"
```

## 2. Scope it

Zero labs is a mount or path problem. Non-zero with errors is content.

## 3. Immediate mitigation

None. Labs are read once at startup, so a fix needs a restart either way.

## 4. Diagnose

1. `prod logs api | grep '"event":"config.loaded"'` — the startup line
   names every rejected definition with its validation error.
2. `LABS_DIR` must be `/app/labs` in the container, and the checkout's `labs/`
   must be bind-mounted read-only there:
   `docker inspect -f '{{range .Mounts}}{{.Source}} -> {{.Destination}} rw={{.RW}}{{println}}{{end}}' <api container>`
   (not `docker compose config`: it prints every secret in `.env`).
3. `prod exec -T api ls /app/labs` — an empty directory is a mount that
   did not attach.
4. A rejected lab is rejected on purpose: duplicate id, duplicate slug, dangling
   prerequisite, prerequisite cycle, unsupported requirement type, or a
   requirement its provider cannot verify. The message says which.

## 5. Fix

Correct the mount or the `lab.yaml`, then `prod up -d api`.

## 6. Verify recovery

- `jtt_labs_loaded` equals the checkout's `lab.yaml` count and `jtt_lab_load_errors == 0`.
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
