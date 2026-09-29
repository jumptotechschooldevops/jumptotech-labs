# First class — running five students, from the day before to the write-up

A checklist for the first instructor-led class on the platform: one
instructor, up to five students, one host. It puts in order what already
exists. The detail lives in:

- [instructor-guide.md](instructor-guide.md): the classroom view, P0–P3, escalation.
- [private-beta-operations.md](private-beta-operations.md): the `prod`, `ops`, `q`, `alerts` and `ready` helpers.
- [private-beta-incident-response.md](private-beta-incident-response.md): incidents A–U.

**Two people, two kinds of step.**

- **Operator** steps need a shell on the host with the helpers from
  [operations §1](private-beta-operations.md#1-the-production-command).
- **Instructor** steps need only a browser and an INSTRUCTOR or ADMIN account.

If one person does both, they should keep the host shell open all class.

Nothing here deletes anything except `ops end <id> --yes`, which ends **one**
lab, named by its id. There is no command that ends every lab, and there should
not be one.

## 1. The day before

These need an api restart or a student's first sign-in, so they can't be
done five minutes before class.

| # | Who | Do | Why |
|---|---|---|---|
| 1 | Operator | Check `.env`: `MAX_ACTIVE_SESSIONS=5`, `MAX_ACTIVE_SESSIONS_PER_STUDENT=1` | The ceiling the host was sized and validated for. `MAX_ACTIVE_SESSIONS` defaults to 20 when the line is missing ([operations §2](private-beta-operations.md#2-platform-health-check)) |
| 2 | Operator | Decide `MAX_SESSION_MINUTES` (default 60) and `IDLE_TIMEOUT_MINUTES` (default 20; must not exceed the first). For a class with labs estimated at 55–60 minutes (CICD-009, CICD-010, DOCKER-010, DOCKER-011, DOCKER-013), or with long talks between exercises, raise them (for example 90 and 30), then `prod up -d api` | A lab's environment and the student's files are deleted at the limit. Completion is kept. Only labs started after the restart get the new limit. The api can take minutes to come back on a loaded host |
| 3 | Instructor | Every student **and** the instructor signs in once | Signing in creates the account. It can't be granted access or a role before that |
| 4 | Operator | `ops access list --state NONE` lists who signed in and has no access. Grant each: `ops access grant <user-id> --until <end of course> --kind beta --by <you> --reason "<class>"` | Under `ACCESS_POLICY=entitlement` (the production default) a student without a grant can browse but not start a lab ([commercial-access.md §6.2](../commercial-access.md#62-authorize-a-student)) |
| 5 | Operator | Grant the instructor too (`--no-expiry`, `--reason "staff account"`), then `ops role set <user-id> INSTRUCTOR --by <you> --reason "<class>"`. Use `ADMIN` if the instructor must be able to end a student's lab | Only ADMIN can end another person's lab from the browser ([instructor-guide §4](instructor-guide.md#4-ending-a-students-lab)) |
| 6 | Operator | `make private-beta-smoke` after any restart, upgrade or `.env` change | Read-only check that the running stack serves as proven |
| 7 | Instructor | Walk the class's labs yourself: Launch → task → Verify → End. Note each lab's estimated time and any hint students will need | Finds a lab problem before the class does |

## 2. Thirty minutes before

Operator, from the host shell (the health check of
[operations §2](private-beta-operations.md#2-platform-health-check), trimmed to
what a class needs):

```bash
prod ps                               # every service Up; web and postgres (healthy)
alerts                                # nothing critical firing
ops status                            # "new labs: YES", launches not paused, providers up
ops sessions                          # should be empty: nothing left from an earlier class
ready api 9400                        # 200 — database and lab registry ok
ready terminal 9401
ready sandboxd 9402
q 'jtt_sessions_capacity_limit'       # 5
q 'jtt_sessions_per_student_limit'    # 1
q 'jtt:host_filesystem_available:ratio'   # above 0.2
q 'jtt:backup_age:seconds / 3600'         # under 24
q 'jtt:tls_certificate_expiry:seconds / 86400'   # well above 14
```

| If | Then |
|---|---|
| `ops sessions` shows a lab from yesterday | A teardown that never finished holds a slot. [RB-17](RB-17-session-lifecycle.md), then `ops end <id> --yes` for that one id |
| `new labs: NO` | `ops status` says why: launches paused ([RB-21](RB-21-launches-paused.md)), a provider down ([RB-09](RB-09-provider-unavailable.md)), capacity ([RB-04](RB-04-capacity.md)) |
| Disk under 0.2 | [Incident O](private-beta-incident-response.md#o-the-disk-is-nearly-full) before the class, not during it |
| Any service not Up or not ready | [Incident A](private-beta-incident-response.md#a-the-website-is-unavailable) or [J](private-beta-incident-response.md#j-the-api-needs-a-restart). If it isn't fixed in 15 minutes, move the class |

Instructor, in the browser:

- Open **Classroom**. Check that it shows *Students can start labs*, that **Labs running** reads `0 / 5`, and that every lab type the class needs reads **Available**.
- Open **Which labs can run** and find each lab the class will use.

## 3. Five minutes before: the instructor's smoke run

One lab, all the way through, as a student would. Pick a Linux lab
(LINUX-001 takes seconds to start).

1. Sign in. The dashboard loads.
2. Open the lab and press **Launch lab**. It reaches *Ready*, and the terminal shows a prompt.
3. Type `pwd` and press Enter. Output appears.
4. Press **Verify**. It answers *Not complete yet* with a per-check list. That is a Check that **ran**.
5. Press **End lab** and confirm. The page says the lab ended.
6. **Classroom → Labs running** is back to `0 / 5`. **Recently finished** shows your lab with cleanup confirmed.

**Step 6 matters.** The instructor's lab takes one of the five slots. A
demo lab still running when students arrive refuses the fifth student with
*"the platform is full"*. That is the limit working, not an outage. For a live
demo during class, either demo before the students start, or have the operator
raise `MAX_ACTIVE_SESSIONS` to 6. Raise it only if the host was validated for
six.

If any step fails, stop and fix it before students arrive. The step that fails
names the incident: start → [C](private-beta-incident-response.md#c-a-student-cannot-start-a-lab),
terminal → [F](private-beta-incident-response.md#f-the-terminal-disconnected),
Verify → [H](private-beta-incident-response.md#h-verify-does-not-work),
End → [RB-17](RB-17-session-lifecycle.md).

## 4. Tell the students, at the start

Say these out loud. Each one prevents a common support question.

- **Your Support ID** is under the Verify panel. Read it to me when something is wrong.
- **One lab at a time.** Press **End lab** when you finish, before opening the next one.
- **The lab closes after 20 minutes without typing**, and a banner warns you first. Press **Stay active** or type something. Leaving the page open is not activity. *(Use your deployment's numbers.)*
- **Every lab closes N minutes after it starts** (the timer at the top). Press **Verify** as you go. A lab you have passed stays completed after it closes.
- **Reset** gives you a fresh copy of the lab. Your files and shell history are deleted. Your progress and any completion are kept, and the timer does not restart.
- **End lab** deletes the environment. Progress is kept.
- **A reload, a closed tab or a dropped Wi-Fi connection does not lose the lab.** Open the Dashboard and press **Continue lab**.
- **Typing `exit` closes only the shell.** Press **Reconnect** for a new one. Your files are still there.

## 5. During class: what a student says, and what to do

Find the student by name or Support ID in **Classroom**, and read **What
happened** before acting. The table is the short form of
[instructor-guide §3](instructor-guide.md#3-it-doesnt-work-what-to-check).

| Student says | What the platform is doing | Student does | Instructor does | Needs the host? |
|---|---|---|---|---|
| "My lab won't start" | The page gives a reason and a reference. The classroom lists it under **Problems** | Follow the page. Usually **Continue lab** (one already running) or try again | Read the refusal reason ([§3 table](instructor-guide.md#a-student-cant-start-a-lab)). Failed twice → escalate with the Support ID | Only for "failed to start" twice, or for several students |
| "It says capacity reached" | Five labs hold five slots | Wait, or ask a finished classmate to press End | Ask whoever is done to End. An ADMIN can end an abandoned lab. **Not an incident** | No |
| "The terminal is blank" / "it disconnected" | The bar says why, and offers **Reconnect** | Press **Reconnect**. If that fails, reload the page | Lab page **Environment** should say *Reachable*. *Missing* → student Ends and starts again | Several at once: P1, [incident F](private-beta-incident-response.md#f-the-terminal-disconnected) |
| "I refreshed" / "I closed the tab" / "my Wi-Fi dropped" / "I signed in again" | The lab keeps running on the server, until the idle or time limit | Dashboard → **Continue lab** | Nothing | No |
| "Check doesn't work" | Either *Not complete yet* (it ran; the task isn't done) or *Verification could not run* (a platform problem; nothing recorded) | Not complete: read the ✗ notes and the hints. Could not run: wait a minute, then Verify again | Only *could not run* is a platform problem. Repeated for one student → they Reset. Several students → P1 | Several students |
| "Check passed but my progress doesn't show it" | A pass is saved when Verify says *Saved to your progress*. *"could not be saved just now"* means the database was unreachable at that moment | Press **Verify** again **before** End. That retries the save | If it keeps saying so for everyone, the database is down: [incident N](private-beta-incident-response.md#n-postgresql-is-unavailable) | Yes, if it persists |
| "I clicked Reset" | Environment rebuilt from the start. Files, processes and history deleted; progress kept | Start the task again. The terminal reconnects by itself | Nothing. **Needs Reset** after a failed reset → press Reset again, or End and start again | Only if Resets fail for several students |
| "I clicked End by mistake" | The environment and files are gone; the completion (if passed) is kept | Launch the lab again | Nothing can bring the files back | No |
| "My lab disappeared" | The idle or time limit closed it. The page says which | Launch it again | Classroom shows *Expired (inactive)* or *Expired (time limit)*. Consider raising the limits for the next class (§1 row 2) | No |
| "It says Shutting down / Cleaning up" | End is confirming the environment is gone. The slot frees after | Nothing. Wait, or start another lab once it clears | Over 15 minutes → escalate with the Support ID | Yes, over 15 minutes |
| "I can't sign in" | Nothing reaches the platform before sign-in | Check they're using the right account | One student: P2. Several: P1. Nobody: P0 ([incident B](private-beta-incident-response.md#b-sign-in-does-not-work)) | Yes, for several |
| "It says my lab access is not active" | No grant, or it lapsed | Nothing they can do | Operator: `ops access find --email …` then `ops access grant …` (§1 row 4). Takes effect on their next click | Yes (operator) |

**A clean restart for one student** (anything is odd, the environment can't
be trusted, or the student wants to start over):

1. The student presses **End lab** and waits for the page to say it ended.
2. The student presses **Launch lab** again.
3. If End doesn't finish, an ADMIN ends it from the lab's page, or the
   operator runs `ops end <that-one-id> --yes`. Never end a lab you haven't
   identified by Support ID and student name.

**Several students at once** is not something to solve one by one: it's
[incident U](private-beta-incident-response.md#u-all-students-are-affected).
Tell the class, and move to a lab type that still works if the classroom shows
one.

### The operator's screen during class

Keep two things open, and nothing else unless one of them changes:

1. **The alert channel** (or `alerts`). A critical alert is the signal to act;
   everything else is context.
2. **Grafana → JTT — Private Beta Operations, rows 0 and 1.** Twelve tiles, read
   top to bottom:

| Tile | Healthy | If not, read |
|---|---|---|
| Lab starts that succeeded (10 min) | 100% | [incident C](private-beta-incident-response.md#c-a-student-cannot-start-a-lab) |
| Provisioning p95, slowest provider | under 60 s | [E](private-beta-incident-response.md#e-a-lab-is-stuck-starting) |
| Terminal attaches that succeeded | 100% | [F](private-beta-incident-response.md#f-the-terminal-disconnected) |
| API requests without a 5xx · API p95 | ~100% · under 1 s | RB-11 |
| Checks that returned a verdict | 100% | [H](private-beta-incident-response.md#h-verify-does-not-work) |
| Critical / warning alerts firing | 0 | the alert's runbook link |
| Services scraped | 3 | [J](private-beta-incident-response.md#j-the-api-needs-a-restart), [K](private-beta-incident-response.md#k-the-terminal-service-needs-a-restart), RB-06 |
| API ready · PostgreSQL · Container runtime | 1 · 1 · 1 | [N](private-beta-incident-response.md#n-postgresql-is-unavailable), [Q](private-beta-incident-response.md#q-the-docker-daemon-is-failing) |

Then, once or twice an hour, the four that change slowly:

```bash
q 'jtt:sessions_headroom:count'                # slots left; 0 means the next Start is refused
q 'jtt:host_filesystem_available:ratio'        # above 0.2
q 'jtt:host_memory_available:ratio'            # above 0.2
q 'jtt:reaper_seconds_since_success'           # under 120: Ends are being cleaned up
```

**Two readings that are not what they look like** (both measured in the
2026-09-28 observability drill):

- A burst of **resolved** notifications followed by `ServiceDown{job="api"}` is
  the api going away, not everything recovering.
- After any restart of the api, terminal or sandboxd, `ServiceDown` for it
  fires while it starts. On a busy host that can take several minutes. Wait for
  it to resolve before you restart again.

## 6. After class

| # | Who | Do | Looking for |
|---|---|---|---|
| 1 | Instructor | Ask everyone to press **End lab** before leaving | Slots free now, not when the idle limit fires |
| 2 | Instructor | **Classroom → Labs running** reaches `0 / 5`. **Recently finished** shows cleanup confirmed for each | A lab still *Cleaning up* after 15 minutes needs the operator |
| 3 | Operator | `ops sessions` is empty. `ops sessions --recent` lists the class's labs with reasons | Anything still holding a slot: [RB-17](RB-17-session-lifecycle.md) |
| 4 | Operator | `alerts`, and the dashboard's rows 4–5 (starts, resets, ends, reaper) | What failed during class, even if nobody said |
| 5 | Operator | `q 'jtt:host_filesystem_available:ratio'` | Disk after the class, compared with before |
| 6 | Operator | If anything went wrong: `make private-beta-diagnostics ARGS="--since 3h"` | One sanitized bundle, no secrets or student data |
| 7 | Instructor | Write down each incident: time, Support IDs, what the student saw, what fixed it. Note lab content problems (typos, confusing hints) as P3 | The record for the next class ([incident-management.md](incident-management.md)) |

## 7. What the platform can't tell you

- **Whether a terminal is connected right now.** The classroom shows *last
  activity* (typing, Verify, Reset). A student reading instructions for 15
  minutes looks idle.
- **A failed sign-in.** It never reaches the platform. Only the student sees it.
- **What a student typed.** Deliberately never shown.
- **An INSTRUCTOR can't end a lab**, only an ADMIN can. Whether instructors
  should is an open decision
  ([instructor-guide §7](instructor-guide.md#7-what-this-view-does-not-do)).
