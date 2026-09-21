# RB-12 — Terminal connections failing, or PTY drift

**Alerts:** `TerminalConnectionFailures` (warning, >20%), `TerminalPtyDrift`
(warning)
**Blast radius:** students cannot open a shell. Their sandbox and their progress
are unaffected.

Commands use `prod` and `q` from [private-beta-operations.md §1](private-beta-operations.md).

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
| `superseded` | The attach was cancelled: its session ended, or was opened in another tab, while it waited. Not a failure, and not counted as one by `TerminalConnectionFailures` | Nothing, unless it is most of the traffic |

## 3. Immediate mitigation

For `origin_rejected` after a deploy, correcting `ALLOWED_ORIGINS` and running
`prod up -d api terminal` restores service immediately. Everything
else needs step 4 first.

## 4. Diagnose

1. `prod logs terminal | grep '"event":"terminal.connection.rejected"'`
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
6. **A student says the terminal disconnected with "more was pasted or typed
   at once than the terminal accepts":** `"event":"terminal.input.rate_exceeded"`
   names the session. A socket may send a 256 KiB burst and 8 KiB/s after it
   (`services/terminal/src/input-budget.ts`); beyond that the socket and its
   shell are closed, so nothing queues in the terminal service or sandboxd.
   Reconnect restores the shell. Repeated lines for one session are a flood,
   not a paste — RB-08.

## 4b. PTY drift

```promql
sum(jtt_sandboxd_shells_open)
sum(jtt_terminal_connections_open)
```

Two services counting shells from opposite ends. The terminal counts every
socket; sandboxd counts only broker PTYs — container-track shells (Linux,
Ansible, Terraform, CI/CD). Kubernetes and Docker-track shells are local PTYs
in the terminal container, so the terminal's number is normally the larger one
by exactly that many. `TerminalPtyDrift` fires only when sandboxd holds more
than three PTYs beyond the terminal's sockets: a broker PTY that outlived its
socket, which neither service can see alone.

Small transient differences during connect and disconnect are normal.

## 5. Fix

Per section 4.

## 6. Verify recovery

- Connection success ratio above 0.95.
- Open a terminal and run a command.
- `jtt_sandboxd_shells_open` is no larger than `jtt_terminal_connections_open`
  (the difference is the open Kubernetes and Docker-track shells).
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
