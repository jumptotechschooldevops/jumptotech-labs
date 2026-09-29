# Instructor guide — running a class from the browser

For whoever is teaching. It answers "a student says something is wrong, what
do I check?" using the **classroom view** at `#/classroom` in JumpToTech Labs.
You shouldn't need a terminal on the server, Docker, `kubectl` or SQL for
anything here. Where you would, this guide says **escalate**.

Before a class, work through [first-class.md](first-class.md): the day-before,
30-minute and 5-minute checklists, and what to tell students.

DevOps has its own documents: [operator-guide.md](operator-guide.md) (the
map), [private-beta-operations.md](private-beta-operations.md) and
[private-beta-incident-response.md](private-beta-incident-response.md).

## 1. Getting access

Every account starts as a student. An operator gives your account a role
([private-beta-operations.md §7.4](private-beta-operations.md#74-making-someone-an-instructor-or-an-administrator)).
You need to have signed in once first.

| Role | Can |
|---|---|
| **INSTRUCTOR** | See every student's lab, find students, read what happened. Can't end anyone's lab. |
| **ADMIN** | All of the above. Can also **end a student's lab**, and sees operator detail (sandbox name, namespace, raw reason) for escalations. |

After the role is given, reload the page. **Classroom** appears in the top
navigation. A student who types `#/classroom` gets "Not available for your
account": the server refuses them, whatever the page shows.

## 2. What the classroom shows

The page refreshes itself every 15 seconds while it's open. **Refresh** asks
straight away. If a refresh fails, the page keeps what it last knew and says
*"Could not refresh — showing what was true at 10:04:31"*.

- **Labs running `4 / 5`**: how many of the platform's lab slots are taken.
  At `5 / 5` it says *Classroom capacity reached*.
- **Can students start labs?** says *Students can start labs* or, if not, why
  not: capacity full, launches paused for maintenance, a kind of lab
  unavailable.
- **Lab types** lists each kind of lab (Linux, Docker, Kubernetes, …) as
  Available, Unavailable or Not offered. **Which labs can run** lists every lab.
- **Find a student or a lab** takes a name, an email, or the **Support ID** a
  student reads out to you.
- **Needs attention** lists labs with a problem, and what to do about it.
- **Labs in progress** shows every running lab: student, lab, state, when it
  started, the student's last activity, and the last Check.
- **Problems in the last hour** lists refused and failed starts, Checks that
  could not run, failed Resets, and cleanups still running. A Check that ran
  and found the lab unfinished is *not* a problem, and isn't listed.
- **Recently finished** covers the last few minutes, with whether cleanup was
  confirmed.

Click a Support ID for **one lab's page**: its state, what needs doing,
whether the platform can still reach the environment, how many Checks and
Resets, and **What happened**, the lab's timeline. Click a student's name for
their running lab, recent activity and last 20 attempts.

### Lab states

| State | Means |
|---|---|
| Starting | The environment is being built. Seconds for a Linux lab, a minute or two for Kubernetes. |
| Running | Ready to use. |
| Resetting | The student pressed Reset. |
| **Needs Reset** | A Reset failed or was interrupted. The environment can't be trusted. |
| Cleaning up | The lab is ending, and its slot frees when cleanup is confirmed. |
| Ended by student / Ended by staff | Finished, and cleanup confirmed. |
| Expired (inactive) | No activity for 20 minutes (`IDLE_TIMEOUT_MINUTES`). |
| Expired (time limit) | Reached 60 minutes (`MAX_SESSION_MINUTES`). |
| **Failed to start** | Provisioning failed. Nothing is left running. |

These are the platform's defaults; your deployment may set others.

### The Support ID

In the lab workspace, under the Check panel, every student sees
**Support ID `sess-…`**. When a student says "my lab doesn't work", ask for it
and paste it into the find box. It goes straight to their lab. It still works
after the lab has ended: the timeline is kept for 30 days. The ID gives
nobody any access.

## 3. "It doesn't work": what to check

### A student can't sign in

The classroom view can't see a failed sign-in, because nothing reaches the
platform until sign-in succeeds.

1. Find them by email. **No match** means they've never signed in
   successfully. Check they're using the right account with the identity
   provider.
2. If **only this student** is affected, the account is probably the
   problem. Treat it as **P2**.
3. If **several students** can't sign in, it's **P1**. If **nobody** can,
   it's **P0**. Escalate either way ([incident B](private-beta-incident-response.md#b-sign-in-does-not-work)).

### A student can't start a lab

Look at **Can students start labs?**, then find the student and read
**Recent activity**. A refused Start is recorded with the reason:

| You see | Means | Do |
|---|---|---|
| Start refused — classroom capacity was full | All slots taken | See [capacity](#capacity-is-full) |
| Start refused — the student already had a lab running | One lab per student | They should open their running lab (**Continue lab** on the Dashboard) or end it first |
| Start refused — this kind of lab is unavailable right now | That runtime is down | Other kinds of lab still work. **P1** if the class needs it: escalate |
| Start refused — the student's lab access is not active | Their access hasn't been granted, or has lapsed | An operator grants it ([commercial-access.md §6](../commercial-access.md#6-operator-runbook)) |
| Start refused — starting labs is paused for maintenance | Launches paused on purpose | Running labs keep working. Ask DevOps when it ends |
| Lab failed to start | Admitted, then provisioning broke | They can press Start again. If it fails twice, or for several students, escalate with the Support ID |

The slot is released when a start is refused or fails. **Labs running**
confirms it.

### Capacity is full

`5 / 5` means five labs hold the platform's five slots. The sixth student to
press Start is told the platform is full, and the refusal appears under
**Problems** with their name. That's the designed limit, not an outage.

To free a slot:

- ask a student who's finished to press **End Lab**;
- an **ADMIN** can end an abandoned lab (see [§4](#4-ending-a-students-lab));
- idle labs close by themselves after 20 minutes without activity.

A slot held by a lab that's **Cleaning up** frees when cleanup finishes. If
the slots are full of cleanups that never finish, that's
[End is stuck](#end-is-stuck).

### The terminal disconnected

The student's page says why (*Disconnected after a period of inactivity*,
*…opened in another tab*, …) and offers **Reconnect**. The classroom view
doesn't see the terminal connection itself. It sees **Last activity**
(typing, Check, Reset, Continue).

1. The student presses **Reconnect**. If that doesn't work, they reload the
   page: the lab and their work are still there, and the page reattaches.
2. On the lab's page, **Environment** should say *Reachable*. If it says
   *Missing* or *Not reachable*, the environment is gone or broken. The
   student should press **End Lab** and start again.
3. Several students disconnected at once is **P1**: escalate
   ([incident F](private-beta-incident-response.md#f-the-terminal-disconnected)).

### Check returned an error

There are two different things a student may call "Check failed":

- **Check ran — not complete yet**. The Check worked and graded their lab as
  unfinished. The student's work is the issue, not the platform. Help them
  with the lab.
- **Check could not run (platform problem)**. The platform couldn't read the
  environment, so no grade was given and nothing counts against the student.
  The lab is flagged under **Needs attention**.
  1. The student waits a minute and presses **Check** again.
  2. If it keeps failing for **one** student, they can Reset, or End and
     start again. That's **P2**.
  3. If it's failing for **several** students, it's **P1**: escalate with the
     Support IDs.

### Reset failed

The lab shows **Needs Reset**, and the timeline says *Reset failed*.

1. The student presses **Reset** again. Most failures are transient.
2. If it fails again, the student presses **End Lab** and starts the lab
   again. Their saved progress and completed labs are kept.
3. A Reset stuck on *Resetting* for over 10 minutes becomes Needs Reset
   automatically.
4. Several students hitting failing Resets is **P1**: escalate.

### End is stuck

The lab shows **Cleaning up**. The platform keeps retrying until the
environment is confirmed gone, and only then frees the slot.

- **Under 5 minutes**: normal. Wait.
- **5 to 15 minutes**: *Cleanup has been running for N minutes*. Nothing to
  do yet; the platform retries every minute.
- **Over 15 minutes**: flagged as a problem. **Escalate** with the Support ID.
  Don't ask the student to do anything. Their part is done.

The timeline's **Cleanup confirmed** line is the proof cleanup finished,
whoever ended the lab.

## 4. Ending a student's lab

**ADMIN only.** Use it when a student has left, is stuck, or a lab holds a
slot the class needs. Prefer asking the student to press End Lab.

1. Open the lab's page (Support ID, or click it in the classroom).
2. Press **End this student's lab…**. The confirmation names the **student,
   the lab and the Support ID**. Check they're the ones you mean.
3. Press **End lab**.

The environment and everything the student did in it are deleted. Their
progress and completed labs are kept, and they can start again. Their page
says the lab ended. The lab shows **Ended by staff**, and the timeline records
that staff ended it. The server records which account did it, and nobody else
can end a lab from this page. If cleanup isn't confirmed straight away, the
page says so, and the platform keeps retrying.

An INSTRUCTOR can't end a student's lab. The button isn't shown, and the
server refuses the request.

## 5. How urgent is it?

| Level | What | Examples | Do |
|---|---|---|---|
| **P0** | The platform is unavailable to everyone | The site doesn't load, nobody can sign in, *Students cannot start new labs* with the database or every lab type named | Tell the class, then escalate to DevOps **immediately** |
| **P1** | Several students are blocked | A lab type unavailable that the class needs, Check errors or failed Resets for several students, cleanups stuck over 15 minutes holding slots | Escalate **now**, with the Support IDs. Move the class to a lab type that works if you can |
| **P2** | One student is blocked | One student's lab failed to start twice, their Check keeps erroring, Reset keeps failing | Try the steps in §3. Escalate during working hours with the Support ID |
| **P3** | Minor | A typo in instructions, a confusing hint, a cosmetic problem | Note it and report it after class |

Capacity full (`5 / 5`) is not an incident. It's the limit working.

## 6. When to escalate, and what to send

Escalate to DevOps (whoever deployed the stack, until on-call is decided,
per [operations §8](private-beta-operations.md#8-decision-required)) for any
P0 or P1, and for:

- a lab still **Cleaning up** after 15 minutes;
- **Environment: Missing** on a lab the platform thinks is running, for more
  than one student;
- the classroom saying *Finished labs are not being cleaned up*;
- the classroom page itself saying *The platform could not answer* or
  *Lab sessions cannot be read right now*.

Send the **Support IDs**, the time it started, how many students, and what
the classroom showed. An ADMIN can include the operator detail from the lab's
page. Never send screenshots of a student's terminal, passwords or anything
from `.env`.

## 7. What this view does not do

- It never shows a student's terminal, what they typed, their answers or any
  credential. That's deliberate.
- It shows **last activity**, not whether a terminal is connected right now.
- It doesn't change the catalog, grant access or change roles. Operators do
  those ([private-beta-operations.md §7](private-beta-operations.md#7-stuck-sessions-cleanup-and-the-rest)).
- An INSTRUCTOR can't end a lab. Only an ADMIN can.
