# Incident management: severity, roles, messages, postmortem

How to *run* an incident at JumpToTech's size: one or two operators and a class
of students. What to *do* about a specific symptom is elsewhere:
[private-beta-incident-response.md](private-beta-incident-response.md) (by what
you see) and the alert runbooks RB-01…RB-21 ([README.md](README.md), by which
alert fired). This page decides how serious it is, who does what, what you tell
people, and what you write down afterwards.

Nothing here is a contractual commitment to students or customers. Response
times are internal targets.

## 1. Severity

Pick the **highest** row that matches. When unsure, pick the higher one; it is
cheaper to downgrade than to discover an hour later that it was serious.

| Severity | Any of these is true | Examples | Respond | Update people every |
|---|---|---|---|---|
| **SEV-1** | Every or most students blocked (cannot sign in, open the site, or start any lab). **Or** student data may be lost or exposed (progress, accounts). **Or** a security alert (RB-08) that is not already explained. | web or api down (RB-01); PostgreSQL down (RB-02); database lost and being restored; `SecurityEventBurst` or `ScopeDenialDetected` not yet explained; one student reaching another's sandbox | at once, during class; within 1 h otherwise | 30 min |
| **SEV-2** | A core journey broken or unreliable for several students, with the rest of the site working: Start, terminal, Check, Reset or End. **Or** a protection that stops protecting: backups failing (RB-16), cleanup stopped (`ReaperStalled`), alerts not delivered. | `LabStartsFailingHard`; terminals reconnecting for everyone (RB-12); `SandboxdRuntimeDown` (RB-06); `HostDiskSpaceLow` (RB-19); a bad release | within 30 min during class; same working day otherwise | 1 h |
| **SEV-3** | One student, or no student impact yet. | one student's lab stuck (§T); one lab failing Check; a single `BackupLastRunFailed` with the next run due; a warning alert that clears | next working day | when resolved |

Two rules override the table:

- **Possible data loss is SEV-1 until proven otherwise.** Take a backup or keep
  the old database *before* any repair ([postgres-backup-restore.md](postgres-backup-restore.md)).
- **A SEV-2 that lasts longer than one class, or recurs within a week, is
  treated as SEV-1** for the postmortem.

## 2. Roles

Three hats. With one person on duty, that person wears all three and says so in
the first message ("I am leading and fixing this"). With two, split them:
whoever is at the keyboard is the Technical Responder, the other leads and
communicates.

| Role | Owns | Does not |
|---|---|---|
| **Incident Lead** | the severity, the decision to escalate, the timeline, when to declare it resolved | type commands on the host while someone else is |
| **Technical Responder** | diagnosis and repair: the first five minutes of [incident response §1](private-beta-incident-response.md), the runbook, the commands | talk to students mid-repair |
| **Communications** | messages to students and the instructor (§4, §5), on the cadence from §1 | promise times the Technical Responder has not given |

Hand-over: the outgoing lead writes one line in the incident record — current
state, what is being tried, the next update time — and the incoming lead
confirms it before the first leaves.

## 3. The lifecycle

| Step | What to do | Done when |
|---|---|---|
| **1. Detect** | An alert, a student report, or the instructor. Note the time. | a time is written down |
| **2. Acknowledge** | Silence nothing yet. Say in the class channel that you are looking (§4 *Investigating*). Open the incident record (§6, the header). | students know someone is on it |
| **3. Assess** | One student or everyone? Which journey? Data at risk? Choose the severity (§1). `prod ps`, `alerts`, `ops status`; then `make private-beta-diagnostics ARGS="--since 1h"` **before** changing anything. | severity set, archive saved |
| **4. Stabilize** | Stop the damage from growing, not the cause: pause new launches (RB-21) if Starts are failing or the host is under pressure; keep the old database on any restore; do not restart sandboxd first. | nothing is getting worse |
| **5. Communicate** | *Identified* once you know the cause or the workaround. Follow the cadence even with nothing new ("still working on it, next update 14:30"). | cadence kept |
| **6. Recover** | The runbook's repair. Record each command and its time. | the fix is applied |
| **7. Verify** | From the student's side, not the dashboard's: sign in, start a lab, type in the terminal, Check, End (`make private-beta-smoke` on the host). Alerts cleared. `ops status` says new labs: YES. | a real journey worked |
| **8. Close** | *Resolved* message. Un-pause launches. Watch one more class hour. | students told |
| **9. Postmortem** | SEV-1 and SEV-2: within five working days (§6). SEV-3: one line in the record unless it recurs. | written, actions have owners |

## 4. Status messages

Short, factual, no guesses about cause before you know it, no blame, no
internal names (hosts, services, error codes other than a reference). Always
say what the reader should do and when they will hear next.

**Investigating**

> We're looking into a problem with *[starting labs / the terminal / signing in
> / the site]* that started around *[time]*. *[Labs that are already running
> keep working. / Please don't start new labs for now.]* Next update by *[time]*.

**Identified**

> We've found the cause of the *[problem]*: *[one plain sentence, e.g. "the
> server that builds lab environments stopped responding"]*. We're fixing it
> now and expect *[it back by time / an update by time]*. *[What to do meanwhile.]*

**Monitoring**

> A fix is in place and *[starting labs / terminals]* are working again. We're
> watching it closely. If you still see a problem, tell us and include the time
> and the reference shown on the error.

**Resolved**

> The *[problem]* from *[start]* to *[end]* is resolved. *[What was affected, e.g.
> "Labs started in that window may have closed; your saved progress was not
> affected."]* *[What to do, e.g. "Start the lab again."]* Sorry for the
> interruption.

## 5. Messages during a class

For the instructor to read out or paste. Adapt the words; keep the facts.

| Situation | Message |
|---|---|
| Lab starts temporarily unavailable (launches paused, capacity, Start failing) | "Starting new labs isn't working right now. If your lab is already open, keep going; it's not affected. Don't press Start repeatedly. I'll tell you when to try again." |
| Terminals reconnecting (terminal or sandboxd restart) | "Terminals are reconnecting. Your files in the lab are still there. Wait for the terminal to say Connected, or press Reconnect after a minute. Anything a command was doing when it dropped may need running again." |
| Lab stopped mid-way (restart during Start, database restore) | "Some labs closed during the problem. Your completed labs and saved progress are safe. Press Start to get a fresh environment. Work inside the old one isn't kept." |
| Sign-in not working | "Sign-in is having a problem. If you're already signed in, don't sign out. If you aren't, wait. I'll tell you when it works." |
| Planned maintenance | "At *[time]* the lab platform will be unavailable for about *[minutes]*. Finish or end your lab before then; unfinished environments are closed. Your saved progress is kept." |
| Service restored | "Everything is working again. If your lab closed, start it again. If anything still looks wrong, tell me the time and what you saw." |

## 6. Incident record and postmortem

Keep one file per incident next to the diagnostics archive (off the host, with
the backups' access controls; it can contain student session ids). The header
is filled during the incident; the rest afterwards. Blameless: describe what
the system and the procedures allowed, not who got it wrong.

```markdown
# Incident YYYY-MM-DD — <one-line summary>

Severity: SEV-? (initial SEV-?, changed at HH:MM because …)
Lead / Responder / Comms: …
Status: open | monitoring | resolved
Diagnostics archive: <file name>, sha256 <…>
Release: <commit: `q 'jtt_build_info'` (label `commit`), or the deploy record when it says unknown>

## Summary
Two or three sentences: what broke, for whom, for how long, how it was fixed.

## Impact
Students affected (count), journeys affected, duration (start → resolved),
data lost or at risk (none / what, and the recovery point used), labs that had
to be restarted.

## Timeline (UTC)
| Time | Event (detection, each decision, each command, each message sent) |

## Detection
How we found out (alert name / student / instructor), and the gap between
start and detection. Would an alert have caught it sooner?

## Root cause
The technical cause, as far as it is known. "Unknown" is an allowed answer.

## Contributing factors
Conditions that made it worse or slower to fix (load, a missing alert, a
runbook step that was wrong, a decision still open).

## Resolution
What fixed it, and how it was verified from the student's side.

## What worked
## What did not

## Corrective actions
| Action | Type (prevent / detect / mitigate / document) | Owner | Due | Tracking link |
```

Every corrective action has an owner and a date, or is explicitly declined with
a reason. A runbook step that was wrong during the incident is fixed in the
same week.
