# RB-12 — Terminal connections failing, or PTY drift

**Alerts:** `TerminalConnectionFailures` (warning, >20%), `TerminalPtyDrift`
(warning)
**Blast radius:** students cannot open a shell. Their sandbox and their progress
are unaffected.

## 1. Confirm it is real

```promql
jtt:terminal_connection_failure:ratio10m
sum by (outcome) (rate(jtt_terminal_connections_total[10m]))
```

## 2. Scope it — `outcome` names the subsystem

| outcome | Meaning | Where to look |
|---|---|---|
| `origin_rejected` | The browser's Origin is not on the allow-list | `ALLOWED_ORIGINS` |
| `auth_timeout` | No auth frame arrived in time | Client or network |
| `unauthorized` | The session token was rejected | Secret mismatch or clock skew |
| `unauthenticated` | First frame was not `auth` | A client bug |
| `capacity` | `TERMINAL_MAX_SESSIONS` reached | Capacity |
| `no_credentials` | The API would not release session credentials | API / ownership |
| `shell_start_failed` | The PTY would not start | `sandboxd` — RB-06 |

## 3. Immediate mitigation

For `origin_rejected` after a deploy, correcting `ALLOWED_ORIGINS` and running
`docker compose up -d api terminal` restores service immediately. Everything
else needs step 4 first.

## 4. Diagnose

1. `docker compose logs terminal | grep '"event":"terminal.connection.rejected"'`
   — one line per refusal with its outcome.
2. **`unauthorized`:** `TERMINAL_SESSION_SECRET` must match between `api` and
   `terminal` exactly. Tokens are time-bounded, so host clock skew presents the
   same way.
3. **`no_credentials`:** the API refused to release them. Since PLATFORM-010 it
   re-checks the token's `uid` against the live session record, so a session
   that changed owner or ended is refused correctly. Follow the `requestId` into
   the API log.
4. **`shell_start_failed`:** the broker. Check `jtt_sandboxd_runtime_up` and go
   to RB-06.
5. **`origin_rejected`:** the rejected origin is in the log *message* — it is
   attacker-chosen and unbounded, so it is deliberately not a field or a label.

## 4b. PTY drift

```promql
sum(jtt_sandboxd_shells_open)
sum(jtt_terminal_connections_open)
```

Two services counting the same shells from opposite ends. Sustained
disagreement means a PTY outlived its socket or vice versa — a leak neither
service can see alone, which is why the comparison exists.

Small transient differences during connect and disconnect are normal.

## 5. Fix

Per section 4.

## 6. Verify recovery

- Connection success ratio above 0.95.
- Open a terminal and run a command.
- `jtt_terminal_connections_open` and `jtt_sandboxd_shells_open` agree.
- `jtt_terminal_bytes_total` increases — the shell is actually carrying data,
  not merely connected.

## 7. What this does NOT mean

- **Not a sandbox outage.** A student's sandbox and their progress survive a
  terminal failure entirely.
- Close code 4410 is a session ending normally, and 4408 is an idle or expiry
  close. Neither is a fault.

## 8. Escalate when

Failures persist after the secret and origin are verified, or drift keeps
growing after a broker restart.

## 9. Follow-up

The terminal keeps its session map in process and its workspaces on local disk,
so it cannot yet be run with more than one replica. That is PLATFORM-006 scope.
