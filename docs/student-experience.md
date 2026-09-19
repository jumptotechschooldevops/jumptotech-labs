# The student experience (private beta)

What a student sees in JumpToTech Labs, what each screen is built from, and
where the edges are. Written for instructors, operators and whoever changes
`apps/web` next.

Every state the UI shows comes from the API. The only prose the UI adds on its
own is informational: environment descriptions (`apps/web/src/lib/environmentInfo.ts`),
error explanations (`apps/web/src/lib/errors.ts`) and the Help page. None of
that text decides whether an action is allowed.

## Contents

- [Navigation](#navigation)
- [Dashboard](#dashboard)
- [Learning path](#learning-path)
- [Lab catalog](#lab-catalog)
- [Tracks](#tracks)
- [Lab page and Launch](#lab-page-and-launch)
- [Workspace](#workspace)
- [Terminal](#terminal)
- [Verify](#verify)
- [Reset](#reset)
- [End lab](#end-lab)
- [Session states](#session-states)
- [Capacity](#capacity)
- [Progress](#progress)
- [Common student errors](#common-student-errors)
- [Resuming a running lab](#resuming-a-running-lab)
- [Accessibility](#accessibility)
- [Testing and the browser smoke](#testing-and-the-browser-smoke)
- [Known limitations](#known-limitations)

## Navigation

Hash routes, one per page (`apps/web/src/lib/router.ts`):

| Route | Page |
|---|---|
| `#/` | Dashboard |
| `#/labs?track=&q=&level=&status=` | Lab catalog (filters live in the URL) |
| `#/labs/LINUX-001` | Lab page: read, then Launch |
| `#/labs/LINUX-001/workspace` | The running lab |
| `#/tracks` | All tracks |
| `#/tracks/linux` | One track |
| `#/paths` | All learning paths |
| `#/paths/devops-engineer` | The DevOps Engineer learning path |
| `#/paths/devops-engineer/stages/linux` | One stage of a learning path |
| `#/progress` | Saved progress and attempt history |
| `#/help` | How labs work, and what to do when something goes wrong |

Anything else shows **Page not found**; an unknown address no longer quietly
falls back to the catalog. No URL ever contains a session id.

The top bar has six links (Dashboard, Learning Path, Labs, Tracks, Progress, Help). The
current one is marked with `aria-current="page"`, and every page sets the
document title. When the student has a lab running, an **Active lab** link
appears next to their name and goes straight back into it.

## Dashboard

| Panel | Source | When the source is unavailable |
|---|---|---|
| Welcome, *name* | `GET /auth/session` | — (the app is not mounted signed out) |
| You have a lab running | `GET /api/sessions` | "We could not check whether you have a lab running", with Try again |
| How a lab works | shown while the student has no attempts | — |
| DevOps Engineer path — path progress, current stage, next lab and why | `GET /api/learning-paths/devops-engineer` + `GET /api/me/learning-paths/devops-engineer` | "We could not load your learning path" or "Progress is unavailable right now", each with Try again — never a zero, never a guessed lab |
| Recent activity | `GET /api/me/attempts?limit=5` | the error, with Try again |
| Your progress | `GET /api/me/progress` | "Progress is unavailable right now" — never a zero |
| Tracks | `GET /api/labs` + progress | counts only, no bars |

The path panel replaced the earlier **Next up** rule, so the dashboard gives one
answer to "what next". The next lab is chosen by the API's deterministic
learning-path rule and its reason is printed beside it; while a lab is running,
the panel explains the one-lab rule and the running-lab panel keeps the only
*Continue lab* button. See [docs/learning-paths.md](learning-paths.md).

## Learning path

`#/paths/devops-engineer` lists the fourteen stages of the DevOps Engineer path in
order, each with its status in words (*Not started*, *In progress*, *Completed*,
*Available labs completed*, *Earlier stage first*, *Coming soon*), its core-lab
count and a *You are here* marker, beside verified path progress and the next lab.
A stage page shows what the stage teaches and why it matters, its labs in
recommended order, its skills, the stages recommended before it and the next step.
Stages and skills with no labs are shown as *Coming soon* and never counted.
Prerequisites are advice: every lab stays one click away. The model, the
progress rules and the recommendation rule are in
[docs/learning-paths.md](learning-paths.md).

## Lab catalog

All labs, loaded once per visit (`GET /api/labs`) and filtered in the browser:

- **Search** matches every word against the lab id, title, summary, topic,
  track, difficulty and skills.
- **Track**, **Difficulty** and **Status** are native selects. Status only
  appears when progress was read; it cannot filter by data it does not have.
- Results are grouped by track in the API's track order, and labs within a
  track by their declared `order`.
- A live "Showing N of M labs" line announces changes to screen readers.
- No matches → "No labs match" with **Clear filters**.

Each card shows the lab id, title, summary, estimated time, topic, recommended
prerequisites, difficulty, and — where progress was read — **In progress** or
**Completed**. Untouched labs carry no status badge. The card's action is
**View lab** (to the lab page) or, for a lab running for this student,
**Continue lab** (to the workspace).

## Tracks

`#/tracks` lists every track with its tagline, lab and topic counts, difficulty
range and completed-of-total. `#/tracks/<id>` groups the track's labs by topic,
in order, and shows the student's progress, a *Start here* / *Next* link, and a
description of the lab environment.

Everything comes from `labs/<track>/track.yaml` and the lab definitions. The one
track-specific sentence in the UI is about AWS: *AWS labs are simulated. They
run in a Linux sandbox and use no AWS account, no AWS credentials, and create no
AWS resources.* That is what the AWS track actually is today
(`labs/aws/track.yaml`, `docs/aws-track-architecture.md`).

## Lab page and Launch

Before anything is created the student sees the task, **What Verify checks**
(the requirement labels — never the expected values), scenario, objectives,
recommended prerequisites, documentation, skills, related certification topics
(explicitly *not* an award), the environment they will get, and a short **Good
to know** list.

The launch panel shows exactly one of:

| Situation | Shown |
|---|---|
| This lab is running for the student | **Continue lab** |
| A launch is in flight | "Preparing your lab environment…" |
| Another of the student's labs uses their quota | "You already have a lab running" + **Continue *LAB-ID*** |
| The platform cannot run this lab (`availability.available: false`) | "This lab cannot be started right now" and what to do; no button. The provider's own `availability.reason` (hosts, addresses, daemon errors) is for operators and is not shown |
| Otherwise | **Launch lab** |

Launch is single-flight (`ActiveSessionContext.launch`): repeated clicks, or two
buttons, send one `POST /api/labs/:id/start`. The page moves to the workspace
immediately and shows provisioning there. Because the request belongs to the app
rather than the page, leaving mid-provisioning does not lose the result.

Hints are not offered before launch: a revealed hint is recorded against an
attempt, and there is none yet.

## Workspace

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ LINUX-001 · Linux                       [Ready] [✓ Completed]  Time left 42:10 │
│ Files and Directories                               [Verify] [Reset] [End lab] │
├───────────────────────────┬──────────────────────────────────────────────────┤
│ Your task                 │ ● Terminal: Connected   Linux container          │
│ What Verify checks (1/2)  │                                                  │
│ Hints                     │   student@lab:~$ _                               │
│ Scenario · Objectives     │                                                  │
│ Documentation · Skills    ├──────────────────────────────────────────────────┤
│                           │ VERIFICATION  ✗ Not complete yet — 1 of 2 …       │
└───────────────────────────┴──────────────────────────────────────────────────┘
```

Below 960px the panes stack and the page scrolls. The workspace is designed for
laptop and desktop screens; it works on a tablet, and on a phone it is usable
but cramped.

## Terminal

A real xterm.js terminal on the terminal service's WebSocket. The page never
simulates output.

| Terminal bar says | Meaning | What happens |
|---|---|---|
| Connecting… | socket open, waiting for the shell | — |
| Connected | shell ready | keystrokes go to the PTY |
| The shell exited. | the student typed `exit` | **Reconnect** opens a new shell in the same environment |
| Disconnected after a period of inactivity. | the terminal service's idle timer | **Reconnect** |
| Connection to the terminal was lost. Reconnecting… | abnormal close (e.g. network), or a terminal/broker restart | up to six automatic reconnects (1, 3, 6, 10, 15, 25 s — about a minute), then **Reconnect**. Before the first connection the overlay says *Trying again…* instead of asking. A reconnect that succeeds, or one the student asks for, cancels the pending automatic one |
| The terminal’s access expired. | token refused | one new token is minted automatically |
| Disconnected — this terminal was opened in another tab or window. | close 4410 while the session is still running: the terminal service keeps one shell per session, so opening the workspace elsewhere takes the terminal over | **Reconnect** takes it back |
| (ended summary) | close 4410 because the lab ended | the session is re-read and the ended summary replaces the terminal; no reconnect |

Reconnect always asks `POST /api/sessions/:id/terminal` for a fresh token first.
A container-backed Reset replaces the container, so the workspace reconnects the
terminal itself afterwards.

**Keyboard:** the terminal needs Tab for shell completion, so **Shift+Tab**
leaves it (the bar says so while connected). Clicking the terminal focuses it.

## Verify

`POST /api/sessions/:id/check`. Enabled only while the session is `ACTIVE` and
nothing else is running; a double click sends one check.

| State | Looks like |
|---|---|
| Not verified yet | an invitation, or "You have already completed this lab" |
| Checking | spinner, "Checking your environment…" |
| Passed | green "Lab passed — every check passes"; "Saved to your progress" on the check that completed it |
| Failed | amber "Not complete yet — N of M checks passing", every check with ✓ / ✗ / –, the verifier's own detail, and "What to look at next" |
| System error | red "Verification could not run … not a mistake in your work", with the reference code |

The checklist in the instructions panel is marked with the last result. Check
details are the verifier's words about what it observed; expected values are not
in the payload, so the UI cannot show them. A system error (HTTP 503 from the
check route) is never displayed as a failed task, and nothing is recorded for it.

## Reset

Behind a confirmation, because it destroys the student's work. The dialog text
follows the sandbox:

- **Kubernetes** (`sandboxKind: namespace`): removes the objects the student
  created and restores the lab's starting resources; the terminal stays
  connected.
- **Containers** (`sandboxKind: container`): replaces the environment with a
  fresh one; files, processes and shell history are lost; the terminal
  reconnects automatically.

Both: saved progress and any completion are kept, and the time limit is not
extended. A reset that fails leaves the session `DEGRADED`: the workspace says
"Your environment needs a reset" and offers only Reset and End.

## End lab

Behind a confirmation ("This cannot be undone"). On success the workspace
replaces the terminal and every control with a summary: whether the lab was
completed, **Launch a fresh environment** (or Continue, if another lab is
running), **Back to labs** and **Dashboard**.

A completed lab leads on. The summary reads the path's recommendation
(`GET /api/me/learning-paths/devops-engineer`) after End, so the finished lab is
counted, and when it names a lab to open next it shows that lab, the API's
reason, and **Continue learning** straight to its page; **Continue the learning
path** stays as the secondary link. When it names none (the end has not finished,
the path is complete, progress cannot be read) the path link is the main action.
A passing Verify says the same thing ahead of time: press End lab when you are
done to free the environment and see the next lab.

If cleanup is still running (`503 DESTROY_FAILED` with the session `ENDING`) the
workspace shows "Your lab is still shutting down — you do not need to press End
lab again", keeps polling, and moves to the summary when the API reports
`ENDED`.

## Session states

The workspace renders the last payload the API returned and never advances a
status on its own. Transitional states are polled every 3 seconds, steady ones
every 15. Polling is not activity.

Answers can arrive out of order, so three rules hold regardless:

- A session the page has seen end (or vanish) never becomes live again. A
  Verify that answers after End cannot bring back the controls; the attempt it
  recorded is still shown.
- Verify does not apply the session copy in the check's response — the API reads
  it *before* checking — but re-reads the session, so an idle warning the check
  answered goes away at once.
- A Reset or End dialog closes by itself once its action is no longer possible
  (the lab expired, is ending, or needs a reset), rather than sending a request
  the API would refuse. *Launch again* starts with no verdict, and with the new
  attempt's hints (none), not the previous attempt's.

| Status | Student sees | Actions |
|---|---|---|
| `CREATING` | Preparing your lab environment… | none |
| `ACTIVE` | the terminal | Verify, Reset, End lab |
| `RESETTING` | Resetting your lab environment… | none |
| `DEGRADED` | Your environment needs a reset | Reset, End lab |
| `EXPIRING` | Time is up — removing your environment… | none |
| `ENDING` | Shutting down your lab environment… | none |
| `ENDED` / `EXPIRED` / `FAILED` | summary, no terminal | Launch again, Back to labs |
| (404 on poll) | This lab environment no longer exists | Launch again, Back to labs |

## Capacity

The private beta runs with `MAX_ACTIVE_SESSIONS=5` and
`MAX_ACTIVE_SESSIONS_PER_STUDENT=1` (see `.env.example`).

- **Platform full** — `503 LAB_CAPACITY_REACHED`: "All lab environments are in
  use … Please try again in a few minutes." The API's message includes the
  platform total; the student UI deliberately does not repeat it, and nothing
  about other students is shown.
- **Student already has a lab** — `429 STUDENT_SESSION_LIMIT_REACHED`: the lab
  page usually knows in advance (from `GET /api/sessions`) and shows **Continue**
  instead of Launch. If another tab started a lab after the page loaded, the
  refusal refreshes the session list and turns into the same Continue link.
  The UI never suggests starting another lab.

A refusal describes the moment it was made. It is shown on the lab's page and
workspace, and forgotten as soon as the student navigates anywhere else, so it is
never announced again later as if it were new (`ActiveSessionContext`). A
per-student refusal is also dropped once no other lab is running.

Operators still see both as distinct metric outcomes and log fields
(`capacity_reached` vs `student_limit_reached`); nothing about that changed.

## Progress

`#/progress` reads saved history only. Between *Overall* and the per-track lists
it shows the DevOps Engineer path (each stage's status and core labs, and the next
lab) and **Skills**, grouped by stage, each with *n of m labs* completed. A lab is **In progress** once a launch has
been attempted — including one the platform refused (capacity or the per-student
limit), which the attempt history shows as *Could not start* — and **Completed** only when Verify has passed every check; ending,
resetting or losing an environment never removes a completion. Percentages are
the API's own (`completed ÷ catalog total`). When the identity is a development
one, or the deployment has no database, the page says so.

## Common student errors

Every error shows a title, what happened, what to do, and a small **Reference**
(the API code) to quote to an instructor. Mapping: `apps/web/src/lib/errors.ts`.

| Reference | Student sees |
|---|---|
| `LAB_CAPACITY_REACHED` | All lab environments are in use — try again in a few minutes |
| `STUDENT_SESSION_LIMIT_REACHED` | You already have a lab running — continue it or end it |
| `PROVIDER_UNAVAILABLE` | This kind of lab is unavailable right now |
| `SESSION_PROVISION_FAILED` | Your lab environment could not be prepared — try again |
| `API_UNREACHABLE` | Cannot reach JumpToTech Labs — check your connection |
| `AUTH_*` | Your sign-in has expired (the sign-in gate then takes over) |
| `SESSION_NOT_FOUND` | This lab environment no longer exists |
| `SESSION_NOT_ACTIVE` | Your environment is not ready for that |
| `ENVIRONMENT_UNREACHABLE` | Verification could not run — not a mistake in your work |
| `SESSION_RESET_FAILED` | The reset did not finish — Reset again or End lab |
| `DESTROY_FAILED` | Your lab is still shutting down — no need to press End again |
| `PROGRESS_UNAVAILABLE` | Progress is unavailable right now |
| `RATE_LIMITED` | Too many requests — wait a minute |
| `CHECK_IN_PROGRESS` | A check is already running — press Verify again in a few seconds |
| `INTERNAL_ERROR`, `UNEXPECTED_ERROR` | Something went wrong on the platform / in this page — try again or reload |
| anything else, on an action (launch, verify, reset, end, terminal) | plain words for that action — never the provider's message, which is raw kubectl or exec output (`SETUP_FAILED`, `EXEC_FAILED`, `KUBECTL_UNAVAILABLE` …); an unknown Verify error is always "not a mistake in your work" |
| anything else, while reading a page | the API's own message, never a generic "Something went wrong" |

Operator remediation text that names commands (`docker compose ps`, …) is not
shown to students; the reference code leads operators to the runbooks
(`docs/runbooks/`).

## Resuming a running lab

Two owner-scoped API routes, added for this work (`apps/api/src/routes/sessions.ts`):

- `GET /api/sessions` — the caller's own occupying sessions (`CREATING` …
  `ENDING`), their lab titles and attempts, and the caller's own quota. No
  parameters, no other student's sessions, no terminal token, nothing about
  platform occupancy. Kept off `/api/me`, whose payloads never carry session ids.
- `POST /api/sessions/:sessionId/terminal` — a fresh terminal token for an
  `ACTIVE` session, through the same `sessionGuard` and the owner-only
  `session:terminal` action (instructors and admins cannot attach). Same binding
  (`sid` + `uid`) and TTL rule as Start Lab, via one shared `issueTerminalGrant`.
  It is not activity. Tests: `apps/api/test/student-session-resume.test.ts`.

The browser keeps terminal tokens in memory only. Nothing is written to Web
Storage, IndexedDB or cookies (enforced by `apps/web/test/token-storage.test.tsx`).

## Accessibility

- Semantic landmarks (`header`, `nav[aria-label=Main]`, `main`), a skip link,
  breadcrumbs, one `h1` per page.
- Focus moves to the page on navigation; dialogs trap focus, start on Cancel,
  close on Escape (unless the action is running) and restore focus.
- Status changes are announced through a small number of polite live regions
  (result counts, terminal state, session state, verification); errors caused
  by an action use `role="alert"`.
- Checklist and progress marks (✓ ✗ ◐) carry text equivalents.
- Text colours meet WCAG AA on their surfaces; every control has a visible
  `:focus-visible` ring; animation is disabled under `prefers-reduced-motion`.

## Testing and the browser smoke

`npm test --workspace @jumptotech/web` runs, among the older suites:

| File | Covers |
|---|---|
| `student-logic.test.tsx` | routes, error mapping, safe lab prose, terminal close codes, environment copy |
| `learning-path.test.tsx` | path and stage routes, statuses in words, gaps, progress and API outages, unknown path/stage, not locked, running lab |
| `catalog.test.tsx` | search, filters, URL, grouping, progress badges, empty/error states |
| `lab-detail.test.tsx` | launch double-click, running lab, per-student limit, capacity, unavailable, not found |
| `workspace.test.tsx` | resume + token mint, readiness gating, Verify states, Reset/End confirmation and outcomes, terminal reconnect rules, idle warning |
| `workspace-components.test.tsx` | dialog keyboard behaviour, verification panel states |
| `navigation.test.tsx` | nav, `aria-current`, titles, focus, active-lab indicator, not found |
| `dashboard.test.tsx` | every dashboard panel, including unavailable sources |
| `student-flow.test.tsx` | dashboard → catalog → launch → verify → reset → verify → end → dashboard |
| `launch-refusal.test.tsx` | a refused launch is forgotten once the student moves on |
| `LabTerminal.test.tsx` | what the terminal puts on the wire, typed-ahead input, close reasons, safe error lines |

**Browser E2E.** Playwright runs the real stack in a real browser: `npm run
test:e2e` locally and the `browser-e2e` job in CI (`e2e/`, and
[docs/development/browser-e2e-private-beta.md](development/browser-e2e-private-beta.md)).
The critical path (`e2e/tests/student-critical-path.spec.ts`) signs in, finds
LINUX-001, launches it, fails and then passes Verify, opens a hint, reloads (the
session, the result and the hint survive), ends the lab and follows the
summary's next lab to its page. Other specs cover Reset, reload while creating,
a second tab, five students plus a refused sixth, isolation, and injected
failures. The manual release smoke below remains useful against a stack that is
already up (`make beta-validate`):

1. `make up`, open http://localhost:3000 and sign in. **Development mode has no
   browser sign-in:** `/auth/session` answers signed-out and the gate reads *no
   identity provider configured* (true on main before this work too), while every
   `/api` request without a credential resolves to the development student. Run
   the smoke against an OIDC-configured stack, or — as the pre-merge validation
   did — have the *test browser only* answer `GET /auth/session` with that
   development identity. Nothing else is intercepted.
2. Dashboard shows *How a lab works* and the *DevOps Engineer path* panel with its next lab. Open **Labs**, search `files`.
3. Open LINUX-001, **Launch lab**. Provisioning shows, then *Terminal: Connected*.
4. **Reload the page.** The workspace comes back connected (a new token is minted).
5. Press **Verify** before doing anything: *Not complete yet*, checks marked ✗.
6. Do the task; **Verify**: *Lab passed*, *Completed* badge.
7. **Reset** → confirm: terminal reconnects to a fresh container; files are gone.
8. In a second tab open LINUX-002 → *You already have a lab running* + Continue.
9. **End lab** → confirm: summary, no terminal. The top-bar *Active lab* disappears.
10. Dashboard: 1 completed, nothing running. Resize the window to ~400px: no horizontal scrolling outside the terminal.

## Known limitations

- **Workspace on phones** is cramped; the design target is laptop/desktop.
- **Screen readers and the terminal.** xterm.js's screen-reader mode is not
  enabled; terminal output is not announced. Instructions, verification and all
  controls are accessible.
- **Global capacity cannot be shown before Launch** without disclosing platform
  occupancy to students; it is explained when the API refuses.
- **Provisioning progress is not streamed.** Start Lab is one request; the
  workspace shows elapsed time, then the steps the API reports once it returns.
- **The countdown is re-seeded on each poll**, so it can drift by up to one poll
  interval between polls; the server's deadline is authoritative.
- **Hints are per attempt.** The workspace reopens the hints this attempt already
  revealed (read from `GET /api/me/attempts/:attemptId`, not reported again), so
  a reload or a return to the lab keeps them. A fresh launch is a new attempt and
  starts with none. When progress cannot be read, the panel starts closed.
- **The next lab is a fixed rule**, not personalised guidance (see
  [docs/learning-paths.md](learning-paths.md#what-should-i-do-next--the-recommendation-rule)).
- **An API outage is slow to show.** When the API is unreachable, the web proxy
  answers only after its upstream timeout (about a minute in the pre-merge run),
  so a page shows *Loading…* until then, and then the error with Try again.
- **One terminal per lab.** Opening the workspace in a second tab or window takes
  the terminal over; the first tab says so and offers Reconnect.
- **Development mode cannot sign in from a browser** (see the smoke checklist).
  This predates the student-experience work and is unchanged by it.
