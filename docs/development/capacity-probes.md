# Capacity probes

Two bounded, manual tools that answer "how many students can this platform take
at once, and what runs out first?" Neither runs in CI. A capacity number means
something only on the host it was measured on, and a shared CI runner (or a
laptop running other stacks) measures the neighbours as much as the platform.

| Tool | Measures | Needs | Wall time |
|---|---|---|---|
| `npm run capacity:control-plane` | the api's own CPU, event loop and memory per student, with a fake runtime | nothing but `npm ci` | ~30 s |
| `npm run capacity:classroom -- …` | a real class: sign-in, Start burst, terminals, Check, Reset, End, cleanup | a running E2E stack (`e2e/stack.sh up`) | 2–15 min |

Both are read the same way: **MEASURED** for the student counts actually run,
**EXTRAPOLATED** for anything above that, and never the other way round.

## 1. Control plane: `scripts/capacity/control-plane.ts`

```bash
npm run capacity:control-plane                   # 5, 10, 25 and 50 students
npm run capacity:control-plane -- --students 5   # one size
```

The real `createApp` (session manager, session guard, admission under the
capacity lock, verifier bookkeeping, progress service) runs in a child process
over `FakeContainerRuntime`, which answers at once, with in-memory session and
progress stores. The parent drives each phase (sign-in, catalog, Start burst, ten
status polls each, the resume list, terminal grants, Check burst, Reset burst,
End burst) and the child reports its **own** CPU time, event-loop utilisation,
event-loop delay and memory for that phase.

Trust `apiCpuMsPerRequest` over latency on a busy machine. Latency moves with
whatever else the host runs, but CPU time per request moves far less.

What it does **not** include: PostgreSQL round trips (the stores are in
memory), the Docker host, sandbox creation, the terminal service. Its numbers
are a lower bound on api cost, and they isolate the question "is the api the
bottleneck?" from the runtime.

Result on 2026-09-27 (main `d59cb06` + the list fix; a laptop at load 26–31),
second of two runs:

| Students | Start burst max | Poll p95 | Poll CPU | Check CPU | Event-loop delay p99 | RSS |
|---|---|---|---|---|---|---|
| 5 | 41 ms | 6.7 ms | 0.63 ms | 3.5 ms | ≤ 19 ms | 138–142 MiB |
| 10 | 36 ms | 13 ms | 0.51 ms | 2.1 ms | ≤ 19 ms | 125–138 MiB |
| 25 | 61 ms | 26 ms | 0.56 ms | 1.1 ms | ≤ 51 ms | 138–141 MiB |
| 50 | 104 ms | 38 ms | 0.45 ms | 0.9 ms | ≤ 56 ms | 131–148 MiB |

Every response in every phase was 200. At the browser's real cadence (one
status poll per student every 15 s) fifty students need about 1.5 ms of api CPU
a second. The api is not what limits a class. The sandbox runtime is.

### Churn: does the api keep anything per session?

```bash
npm run capacity:control-plane -- --students 10 --churn 150 --checks-per-cycle 1
```

Ten students start, poll, open a terminal grant, Check and End, 150 times over,
against one api process. Every 25 cycles the child forgets finished sessions
(what the reaper's retention sweep does), empties the fake runtime's own call
log, forces GC, and reports heap, RSS and its active handles and timers.
`CAPACITY_SNAPSHOT_DIR=<dir>` also writes a heap snapshot at the first and last
sample, for diffing.

Result on 2026-09-27 (1 500 sessions, every response 200): heap growth
0.3–1.25 KB per session and noisy, RSS flat at 141–147 MiB, no timer and no
socket left behind. A snapshot diff attributes what remains to one record per
session carrying the session id and two timestamps. That is the progress
attempt, kept in memory by this probe and in PostgreSQL in production. **No
per-session leak in the api.** Before the fake's call log was emptied the same
run showed ~4 KB per session, all of it the fake remembering every seed script
it was handed. That is why the probe empties it.

## 2. A real class: `scripts/capacity/classroom.ts`

```bash
E2E_PROJECT=jtt-cap E2E_WEB_PORT=33720 E2E_API_PORT=34720 E2E_TERMINAL_PORT=34721 \
E2E_POSTGRES_PORT=55720 E2E_OIDC_PORT=39720 bash e2e/stack.sh up

npm run capacity:classroom -- \
  --web http://127.0.0.1:33720 --oidc http://127.0.0.1:39720 \
  --owner jtt-cap --project jtt-cap \
  --students 5 --extra-students 1 \
  --labs LINUX-001,LINUX-005,NET-006,CS-005,NET-007 > classroom.json

bash e2e/stack.sh down        # with the same E2E_* variables
```

N students sign in through the E2E stack's test identity provider, press Start
in the same second, open their terminals over the real WebSocket protocol, type,
share the host with one noisy neighbour (`seq` of a fixed size), press Check,
press Reset, reconnect, and End. `--extra-students` are over the ceiling: the
E2E stack sets `MAX_ACTIVE_SESSIONS=5`, so a sixth Start must be refused
cleanly. Every request goes through the nginx edge, the path a browser takes.

Terminal attaches follow the browser's own retry schedule (`AUTO_RECONNECTS` in
`WorkspacePage.tsx`) on the same transient codes, so `attempts > 1` means a
student would have seen "reconnecting…" before the prompt.

Lab ids are the catalog ids (`LINUX-001`), not directory names.

**Bounds.** At most 25 students; one `seq` of at most a million lines; every wait
has a deadline. Nothing is removed except through End Lab, and a run that
fails part-way still Ends every session its students hold (it asks each
student's `GET /api/sessions`, so a Start whose answer never arrived is ended
too). It refuses non-loopback targets and a stack whose runtime owner already
has sandboxes.

**Reading it.** Every resource sample carries `host`: the Docker host's load
average, available memory, swap and pressure-stall figures. Read every latency
against it. On 2026-09-27 the shared development VM ran at load 160–640 with
CPU pressure (`psi.some avg10`) of about 90 %, and a plain `docker rm -f` of an
idle container took 1.8–23 s. Latencies from such a host are INCONCLUSIVE for
capacity. What stays meaningful on any host is whether each Start either
succeeded or was refused cleanly, whether terminals became usable, and whether
every sandbox, network and volume was gone after End.

The report's `verdict` is `FAIL` on any broken contract: a Start that neither
succeeded nor was refused cleanly, a terminal that never answered, a sandbox,
network or volume left after End, or a session still listed as live.

## 3. On the beta host

Run both before the first class, and after any change to the host or to
`MAX_ACTIVE_SESSIONS`:

1. `capacity:control-plane` on the host itself: confirms the api's headroom.
2. `capacity:classroom` against a staging stack on the same host, with the
   class size you intend to admit and the labs you intend to teach. Compare
   `host.psi` during the Start burst with the idle sample. Sustained CPU
   pressure above ~20 % during a burst of N means N is the limit on this
   hardware, whatever the latencies say.

Record the results in the production-host evidence
([releases/production-host-evidence-template.md](../releases/production-host-evidence-template.md)).
