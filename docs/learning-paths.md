# Learning paths and skill progression

JumpToTech Labs has more than a hundred labs across nine tracks. A beginner
should not have to work out an order from that list. A **learning path** puts
the labs in the order that makes each skill easier to learn, and answers the
question every student asks: *what should I learn next?*

This document is for instructors, curriculum authors and developers. It
describes the model, where it lives, how progress and the next lab are
calculated, and how to change any of it.

## Contents

- [What it is — and is not](#what-it-is--and-is-not)
- [Architecture](#architecture)
- [Source of truth](#source-of-truth)
- [The DevOps Engineer path](#the-devops-engineer-path)
- [Stage model](#stage-model)
- [Skill model](#skill-model)
- [Lab mapping](#lab-mapping)
- [Curriculum gaps](#curriculum-gaps)
- [Progress calculation](#progress-calculation)
- [Prerequisites](#prerequisites)
- [What should I do next? — the recommendation rule](#what-should-i-do-next--the-recommendation-rule)
- [API](#api)
- [Student interface](#student-interface)
- [Security boundaries](#security-boundaries)
- [Validation](#validation)
- [How to add a skill](#how-to-add-a-skill)
- [How to map a new lab](#how-to-map-a-new-lab)
- [How to add a learning path](#how-to-add-a-learning-path)
- [Tests](#tests)
- [Known limitations](#known-limitations)

## What it is — and is not

A learning path **is** an ordered arrangement of existing labs into stages, with
the skills each stage teaches, why each lab is where it is, and honest notes
about what the curriculum does not cover yet.

A learning path **is not**:

- **a source of progress.** It records nothing about any student. A lab counts
  as completed only when Verify passed it, exactly as before.
- **a gate.** Nothing stops a student — or an instructor sending a student —
  from opening and launching any lab. `prerequisitesEnforced` is still `false`
  on the lab API.
- **a change to labs.** Lab ids, lab URLs (`#/labs/LINUX-001`), lab definitions
  and runtime behaviour are untouched. A path only points at labs.
- **AI.** The next lab is chosen by a fixed, documented, tested rule.

## Architecture

```text
labs/learning-paths/skills.yaml             skill catalog (path-independent)
labs/learning-paths/devops-engineer.yaml    one path: stages → skills → labs
            │
            ▼  loaded at API startup, validated against the lab registry
services/lab-orchestrator/src/learning-paths.ts     schema, validation, LearningPathCatalog
services/lab-orchestrator/src/learning-progress.ts  pure progress + recommendation rule
            │
            ▼
apps/api/src/routes/learning-paths.ts       GET /api/learning-paths(/:pathId)
apps/api/src/routes/me.ts                   GET /api/me/learning-paths/:pathId
            │                                 (joins stored progress, provider readiness,
            ▼                                  and the caller's own running lab)
apps/web  #/paths, #/paths/:id, #/paths/:id/stages/:stageId, Dashboard, Progress
```

Why this shape:

- **Data beside the labs.** Path files live under `labs/`, which the API already
  mounts read-only (`/app/labs`). No new service, no new container, no new
  environment variable, no migration.
- **The domain in the orchestrator package**, next to the lab registry it
  validates against. The progress rule is a pure function of its inputs, so it is
  unit-tested without a server.
- **The join in the API.** Stored progress (`services/progress`), provider
  readiness and the caller's sessions are already there; the browser receives the
  finished answer and never computes a status.
- **No database change.** Progress through a path is *derived* from the existing
  `lab_progress` rows on every request. Changing a path never needs a backfill.

## Source of truth

| What | Where |
|---|---|
| Skills | `labs/learning-paths/skills.yaml` |
| Paths, stages, lab placement, why, core/optional, stage prerequisites, gap notes | `labs/learning-paths/<path-id>.yaml` |
| Lab titles, durations, difficulty, track, lab-to-lab prerequisites | each lab's own `lab.yaml` (never copied into a path) |
| Whether a student completed a lab | `services/progress` (`lab_progress.status = COMPLETED`, set only by a passing Verify) |
| Whether a lab can be started right now | provider readiness (`ProviderRegistry.statuses()`) |
| Whether the student has a lab running | the session store, filtered to the caller's own sessions |

Nothing about paths is hard-coded in React. The web app knows one constant —
the id of the flagship path the navigation link opens (`FLAGSHIP_PATH_ID` in
`apps/web/src/lib/learningPath.ts`).

## The DevOps Engineer path

Fourteen stages, in the order a beginner should meet them. Every one of the 117
labs is placed in exactly one stage. Counts below are for the catalog at the time
of writing; the API always reports live numbers.

| # | Stage | Labs (core + extra) | Required before it | Not covered yet |
|---|---|---|---|---|
| 1 | Foundations | CS-001–005, CS-011 (core); CS-006–010, CS-012, CS-013 (extra) | — | — |
| 2 | Linux | LINUX-001–010, -014, -017, -019 (core); -011, -016, -018 (extra) | — | — |
| 3 | Networking | NET-002–008, NET-022 | — | DNS |
| 4 | Git & Software Delivery | *none* | — | Git fundamentals, branching, pull requests |
| 5 | Containers & Docker | DOCKER-001–008, -010–012 (core); -009, -013, -014 (extra) | Linux | — |
| 6 | CI/CD | CICD-001–010 | — | — |
| 7 | Cloud & AWS (simulated) | AWS-001–009, -012, -018 | — | EC2, S3 |
| 8 | Infrastructure as Code | TF-001–006, -011, -012 (core); -016, -017, -018, -025, -026 (extra) | — | modules, drift, troubleshooting |
| 9 | Kubernetes | K8S-001–005, NET-024, K8S-008, NET-025, K8S-009–014, -016 (core); -006, -007, -015, -018, -019 (extra) | Containers & Docker | namespaces, Ingress, NetworkPolicy, PodDisruptionBudgets |
| 10 | Configuration Management | ANSIBLE-001–010 | Linux | — |
| 11 | Helm & GitOps | *none* | Kubernetes | Helm charts, releases, GitOps, Argo CD |
| 12 | Observability & SRE | K8S-017 | — | metrics, alerting, SLOs |
| 13 | DevSecOps & Production Readiness | LINUX-015 | — | scanning, runtime security, TLS, production readiness |
| 14 | Production Engineering | *none* | — | cross-system troubleshooting, incident response, projects, interview prep, practical assessment |

Every stage also lists **recommended** earlier stages (for example, Networking
recommends Linux); see the path file.

Seven placements cross track or provider lines, each from the lab's own content:

- **LINUX-006** (*Networking Basics*) stays in Linux because LINUX-007 requires
  it, but it is mapped to the networking skills it teaches (addresses, ports, HTTP).
- **CICD-001** also gives evidence for *software delivery concepts*, a skill of
  the Git stage. The Git stage is still "Coming soon": one CI lab is not Git.
- **K8S-017** (*Ship a Log File with a Sidecar*) is placed in Observability: its
  subject is how logs reach collection tools.
- **LINUX-015** (*Least-Privilege sudo Delegation*) is placed in DevSecOps: its
  subject is least privilege, verified by what a policy refuses.
- **NET-022** (*Port Publishing*) is a Networking-track lab on the Docker
  provider, placed in Networking — two stages before Containers & Docker. See
  `docs/development/catalog-quality-audit.md` for why that ordering is flagged.
- **NET-024** and **NET-025** are Networking-track labs about Services, placed in
  Kubernetes. Both record their findings in a ConfigMap, so they follow K8S-004;
  NET-025 reads EndpointSlices, which list only ready Pods, so it follows
  K8S-008 (probes). Their `lab.yaml` prerequisites say the same.

## Stage model

```yaml
- id: kubernetes                # kebab-case, unique in the path
  title: Kubernetes
  summary: >-                   # what the student will learn, in plain words
  why: >-                       # why it matters in real DevOps work
  objectives: [ ... ]           # 1–10 things they will be able to do
  prerequisites:
    - stage: docker
      kind: required            # or: recommended
  skills: [kubernetes.pods, ...]   # skills this stage owns
  coming_soon: >-               # optional: what is missing, said where it is missing
  labs:                         # recommended order
    - lab: K8S-001
      skills: [kubernetes.pods]
      why: Creates a first Pod and confirms it is both running and ready.
    - lab: K8S-006
      optional: true            # extra practice
      skills: [kubernetes.batch]
      why: Runs a one-off task to completion with a Job.
```

**Core and extra practice.** A stage is *complete* when its core labs are
verified. Extra-practice labs (`optional: true`) deepen a stage without holding a
student back, and are still counted in lab totals. Core was chosen from content:
a lab that other core labs build on is core; a deeper or alternative topic (for
example Python programming in Foundations, Jobs and CronJobs in Kubernetes) is
extra practice.

## Skill model

A skill is something a student can be good at, or not yet: `linux.permissions`,
`networking.ports`, `kubernetes.probes`, `terraform.state`. Skills are:

- **coarser than a lab's own `skills:` tags** (`kubernetes.pods.create`), which
  are untouched and still shown on lab pages;
- **path-independent**, so a future SRE or Cloud path reuses the same ids;
- **owned by exactly one stage** of a path, but **practised by any lab** placed in
  that path. `security.least-privilege` belongs to DevSecOps and is practised by
  AWS-002, AWS-005, K8S-012 and LINUX-015.

A skill's status is derived from the labs that practise it:

| Labs practising it | Status |
|---|---|
| none | **Coming soon** |
| all verified | **All labs completed** |
| any attempted or verified | **In progress** |
| otherwise | **Not started** |

**Foundation for skill intelligence.** Because every skill resolves to the labs
that practise it (`ResolvedLearningPath.labsForSkill`, and `labIds` in the API),
a future interview or assessment feature can map *weakness → skill → labs*
without changing this model. That feature is not built.

## Lab mapping

Every lab was placed from its `lab.yaml` — task, objectives, skills and
prerequisites — not from its id. For each lab the path records the stage, the
position in the stage, the path skills it practises, whether it is core, and one
sentence on *why it belongs there*. Difficulty, duration and title are read from
the lab, never restated.

Order within a stage must agree with the lab's own prerequisites (see
[Validation](#validation)). Where a track's numbering and the teaching order
differ, the path follows teaching order: for example TF-011 (*Reading and Saving an
Execution Plan*) comes straight after TF-001.

## Curriculum gaps

A gap is **derived from data**, never declared as a status:

- a **stage with no labs** is *Coming soon*;
- a **skill no lab in the path practises** is *Coming soon*.

Adding a lab and placing it closes the gap with no other edit. There is no field
that can mark a skill or stage as covered without a lab behind it. `coming_soon`
is only an explanatory note, and a test fails if a stage with a gap has no note.

Gaps are never counted: they add nothing to any total, can never be *Completed*,
and a *Coming soon* stage never blocks a later one. A stage whose available labs
are all verified but which still has gaps is labelled **Available labs completed**,
not *Completed*.

Gaps in the DevOps Engineer path today were determined from the repository (lab
definitions, lab skills and the verifier vocabulary): no Git, Helm, Argo CD or
GitOps labs; no DNS lab; no metrics, alerting or SLO labs; no TLS, image-scanning
or runtime-security labs; no Kubernetes namespace, Ingress, NetworkPolicy or
PodDisruptionBudget labs; no Terraform modules, drift or troubleshooting labs; no
EC2 or S3 labs; no cross-system incident, project, interview or assessment labs.

## Progress calculation

Inputs, per request: the caller's stored per-lab statuses, the path, provider
readiness, and the caller's running sessions. Only two stored statuses exist:

- `COMPLETED` — Verify passed (absorbing: reset, end and expiry never remove it);
- `IN_PROGRESS` — a launch was *attempted*, including one the platform refused.

| Figure | Exactly what it counts |
|---|---|
| Path labs `completed of total` | verified labs placed in the path ÷ labs placed in the path |
| Core labs `completed of total` | the same, core labs only |
| Stage `core.completed of core.total` | verified core labs in the stage ÷ core labs in the stage |
| Stage `labs.completed of labs.total` | all labs in the stage |
| Skill `labs.completed of labs.total` | verified labs practising the skill ÷ labs practising it |

No percentage is sent by the API. Progress bars are drawn from the two numbers
beside them. Curriculum gaps are not labs and appear in no denominator.

**Stage status**, in order of precedence:

```text
no labs in the stage                               COMING_SOON   "Coming soon"
every core lab verified                            COMPLETED     "Completed" / "Available labs completed"
any lab attempted or verified                      IN_PROGRESS   "In progress"
a required prerequisite stage not satisfied        LOCKED        "Earlier stage first"
otherwise                                          NOT_STARTED   "Not started"
```

A prerequisite stage is *satisfied* when it is COMPLETED or COMING_SOON.

## Prerequisites

There are two layers, and neither blocks launching a lab.

**Lab prerequisites** are the existing `prerequisites:` in `lab.yaml` — still
advisory, still validated by the lab registry, still shown as *Recommended first*.
The path must place every lab after its prerequisites.

**Stage prerequisites** are declared in the path:

- `recommended` — advice shown on the stage page (*recommended*, with *done*, *not yet*,
  or *coming soon* for a prerequisite stage that has no labs — never *done*).
- `required` — the stage shows **Earlier stage first** until the earlier stage's
  core labs are verified, and the next-lab rule will not *start* the stage early.

Deliberately, even `required`:

- never stops a student opening or launching any lab (the stage page says so:
  *You can still open any lab here*);
- does not stop a student who has already started a stage from being offered its
  next lab;
- is satisfied by a *Coming soon* stage, so a missing curriculum can never lock
  anything;
- depends on core labs only, so one extra-practice lab cannot hold a student back.

Only four stages have a required prerequisite (Docker ← Linux, Kubernetes ←
Docker, Ansible ← Linux, Helm & GitOps ← Kubernetes).

## What should I do next? — the recommendation rule

Deterministic: the same inputs always give the same answer, and every answer
carries its reason in words. Implemented in `computeLearningPathProgress`
(`services/lab-orchestrator/src/learning-progress.ts`).

1. **A running lab comes first.** If the caller has a lab in `CREATING … ENDING`,
   the answer is *RESUME_ACTIVE* — continue or end it. This honours the one lab
   per student limit. If the session store cannot be read, the answer is
   *ACTIVE_SESSION_UNKNOWN* and no lab is suggested, rather than risking a
   suggestion to start a second one.
2. **Otherwise, pick a stage.** Among stages that have labs and whose core labs are
   not all verified, in this order:
   1. stages the student has already started (any lab attempted or verified), in
      path order;
   2. the first stage after the last stage with a verified lab — or, if that stage
      waits on an unsatisfied *required* stage, that earlier stage (*"Linux comes
      before Containers & Docker, the next stage…"*);
   3. every other stage whose required prerequisites are satisfied, in path order
      — reached only when nothing above can be started on this deployment
      (*"…the earliest unfinished stage … that can be started on this platform
      right now"*).
3. **Pick a lab in that stage**, skipping labs whose provider cannot run on this
   deployment:
   - an attempted core lab (*CONTINUE_ATTEMPT*); else
   - the first unverified core lab in recommended order (*NEXT_IN_STAGE*, or
     *START_STAGE* for a stage not yet started); but if that lab's own `lab.yaml`
     prerequisite is not verified, that prerequisite first (*PREREQUISITE_FIRST*).
   If nothing in the stage can start, try the next stage in the list.
4. **Every core lab verified:** the first extra-practice lab in path order
   (*EXTRA_PRACTICE*).
5. **Nothing left:** *PATH_COMPLETE* when every placed lab is verified, otherwise
   *NONE_AVAILABLE* (what remains cannot be started here right now).

Examples, from the real path (and pinned by tests):

| Student | Answer |
|---|---|
| New | CS-001 — *Start here. Foundations is the first stage of the DevOps Engineer path.* |
| Verified LINUX-001…007, nothing else | LINUX-008 — *Next in Linux. Finish the Linux stage before starting Networking.* |
| Verified all of Networking, nothing else | LINUX-001 — *Linux comes before Containers & Docker, the next stage of the DevOps Engineer path.* |
| Verified all of Networking and LINUX-001 | LINUX-002 — *Next in Linux.* (no "before starting Networking": it is already done) |
| Has LINUX-001 running | LINUX-001 — *You have a lab running. Continue it, or end it, before starting another…* |
| Every lab verified | *You have completed every lab currently available…* (gaps stay Coming soon) |

Rule 2.1 is why a student who skipped Foundations and went straight to Linux is
not sent back to CS-001: they continue where they are. Rule 2.2 is why a student
who skipped ahead is not walked past a stage that a later stage requires. The
*"Finish X before starting Y"* sentence is only added when Y has not been started.

**Per-stage next lab.** Each stage also reports `nextLabId` — the lab that stage
would continue with (attempted core, first unverified core, then extra practice),
ignoring availability. The stage page shows it as *Next step*; the dashboard and
path page show the path-wide recommendation above.

## API

All three routes sit behind the same `authenticate`, CORS allow-list and origin
guard as `/api/labs`. None takes a body or a student parameter. They also share
one **rate limit** of 600 requests a minute per client address
(`apps/api/src/rate-limit.ts`), counted before authentication; beyond it the API
answers `429 RATE_LIMITED` with `Retry-After`.

### `GET /api/learning-paths`

```json
{ "learningPaths": [ { "id": "devops-engineer", "title": "DevOps Engineer", "summary": "…", "audience": "…",
    "totals": { "stages": 14, "comingSoonStages": 3, "labs": 117, "coreLabs": 94, "skills": 113,
                "gapSkills": 29, "estimatedMinutes": { "core": 3445, "all": 4355 } } } ],
  "count": 1 }
```

### `GET /api/learning-paths/:pathId`

The path, with each stage's `summary`, `why`, `objectives`, `comingSoon`,
`prerequisites` (`stageId`, `title`, `kind`), `estimatedMinutes`, `skills`
(`id`, `title`, `description`, `labIds` — empty means Coming soon) and `labs` in
recommended order (`labId`, `title`, `summary`, `track`, `trackTitle`,
`difficulty`, `durationMinutes`, `optional`, `why`, `skills`, `prerequisites`,
`availability: { available }`).

Errors: `400 INVALID_LEARNING_PATH_ID` (the id is not echoed), `404
LEARNING_PATH_NOT_FOUND` for an id no file defines, and `503
LEARNING_PATH_UNAVAILABLE` for a path that is defined but was refused at startup
(the reason is on `/health`) — so a broken lab definition is never presented to
students as a wrong address.

### `GET /api/me/learning-paths/:pathId`

```json
{ "student": { "studentId": "…", "authenticated": true, "identitySource": "authenticated", "durable": true },
  "pathId": "devops-engineer",
  "overall": { "labs": { "total": 117, "completed": 7, "inProgress": 1, "notStarted": 109 },
               "core": { "total": 94, "completed": 7 },
               "stages": { "total": 14, "completed": 0, "comingSoon": 3 },
               "skills": { "total": 113, "completed": 3, "comingSoon": 29 } },
  "currentStageId": "linux",
  "stages": [ { "stageId": "linux", "status": "IN_PROGRESS", "prerequisitesMet": true,
                "prerequisites": [ { "stageId": "foundations", "kind": "recommended", "met": false } ],
                "labs": { "total": 16, "completed": 7, "inProgress": 0 }, "core": { "total": 13, "completed": 7 },
                "nextLabId": "LINUX-008" } ],
  "skills": [ { "skillId": "linux.filesystem", "status": "IN_PROGRESS", "labs": { "total": 3, "completed": 2 } } ],
  "labs": [ { "labId": "CS-001", "status": "NOT_STARTED" } ],
  "recommendation": { "kind": "NEXT_IN_STAGE", "labId": "LINUX-008", "labTitle": "Filesystem Usage and Disk Space",
                      "stageId": "linux", "reason": "Next in Linux. Finish the Linux stage before starting Networking." } }
```

Errors: `400` / `404` / `503 LEARNING_PATH_UNAVAILABLE` as above; `503
PROGRESS_UNAVAILABLE` when stored progress cannot be read — never an empty,
all-zero payload.

`GET /health` additionally reports `learningPathsLoaded` and
`learningPathLoadErrors`.

## Student interface

| Route | Page |
|---|---|
| `#/paths` | every learning path |
| `#/paths/devops-engineer` | the path: stages in order with status, current stage, verified progress, next lab |
| `#/paths/devops-engineer/stages/kubernetes` | one stage: what and why, labs in order, skills, prerequisites, next step |

- **Navigation:** *Learning Path*, after Dashboard, marked current on all three.
- **Dashboard:** the old *Next up* panel is replaced by the path panel — path
  progress, current stage, and the next lab with its reason and **Continue
  learning** (or **Start learning** for a new student). While a lab is running the
  panel explains the one-lab rule and the running-lab panel keeps the only
  *Continue lab* button.
- **Progress page:** after *Overall*, the path's stages (status, core labs) and
  **Skills**, grouped by stage, each with its status and *n of m labs*; then the
  existing per-track lists and history.
- Existing lab, track, catalog and workspace URLs are unchanged.

**Loading, empty and error states.** Each request has its own state. If the path
loads but progress does not, the stages are still shown without statuses, with
*Try again*. If the path cannot load, the page says so with *Try again*; an
unknown path or stage shows *Learning path not found* / *Stage not found*.

**Accessibility.** One `h1` per page, stage and lab lists are ordered lists,
statuses are words with decorative marks hidden from screen readers, progress
bars are `role="progressbar"` with a name and bounds, the current stage is
labelled *You are here*, links carry the lab id for screen readers, and focus
moves to the page on navigation. No new animation.

**Responsive.** The path and stage layouts collapse to one column below 900px,
with progress and the next step first (they come first in the document, so the
visual order and the tab order agree); rows and badges wrap; long titles break
instead of overflowing. A real-Chrome check at 1280, 820 and 390 px found no
horizontal overflow and no axe WCAG 2.1 A/AA violations on the dashboard, path,
stage, progress, catalog and lab pages.

## Security boundaries

- **No other student's progress.** The `me` route resolves the student from the
  authenticated caller (`resolveStudent`). A `studentId` query parameter, body
  field or the development header selects nobody (tested).
- **No session capability.** The recommendation uses only lab ids from the
  caller's own sessions. No session id, sandbox name, namespace or terminal token
  is in any learning-path payload (tested by key and by value).
- **No grading or runtime detail.** Requirements, setup, reset, hints and provider
  failure reasons are not served; availability is a bare boolean.
- **No browser access to internal services.** The browser calls only the three
  API routes above. Nothing new reaches `sandboxd`, the terminal service,
  `/internal`, Docker, Kubernetes or the database.
- **Rate limited before authentication.** A flood of learning-path requests —
  including forged credentials — is refused with `429 RATE_LIMITED` before any
  token is verified or progress read. The budget is per client address: the API
  trusts exactly one proxy hop (the web tier's nginx), so a student's address, not
  nginx's, is the key, and an address a client prepends to `X-Forwarded-For` is
  ignored. It is an in-memory, per-process budget, which is the whole budget for
  the single-instance private beta.
- **No secrets.** Path files are curriculum text; the loader reads only
  `labs/learning-paths/*.yaml`, through the existing read-only mount.
- Capacity, session limits, authentication, NetworkPolicy, Pod Security, TLS,
  backup/restore and observability are unchanged.

## Validation

At API startup the catalog is loaded and validated against the lab registry. A
path that fails is **refused** (not partially served), and each reason is logged
and reported on `/health`. The tests require the shipped paths to load with no
errors, so a broken path cannot merge.

Refused, with a precise message:

- schema: unknown keys, missing required metadata (e.g. `stages[0].labs[0].why: Required`);
- a lab id that does not exist in the catalog;
- a lab placed more than once;
- a skill not in `skills.yaml`, a skill owned by two stages, or a lab skill no stage declares;
- a duplicate stage id;
- a stage prerequisite that is unknown, itself, later in the path, or circular;
- a lab placed before one of its own `lab.yaml` prerequisites, or whose
  prerequisite is not in the path;
- a core lab that depends on an optional one;
- a stage with labs but no core lab;
- a path file whose name does not match its id.

The same rules, plus the repository-level ones (lab layout, setup assets loaded
through the providers' own loaders, flagship coverage, content hygiene), run
without a server:

```sh
npm run validate:labs            # one line per finding; exit 1 on any error
npm run validate:labs -- --json  # the structured report
```

CI runs it in the `gates` job. See `docs/development/catalog-quality-audit.md`.

## How to add a skill

1. Add it to `labs/learning-paths/skills.yaml`: a dotted id (domain first), a
   plain-words `title`, and a one-sentence `description` a beginner can follow.
2. Add the id to the `skills:` of exactly one stage in each path that should
   teach it.
3. Map it on the labs that genuinely practise it. With no lab it appears as
   *Coming soon*; add or update that stage's `coming_soon` note.
4. Run `npx vitest run test/learning-paths.test.ts --root services/lab-orchestrator`.

## How to map a new lab

A new lab under `labs/` makes `learning-paths.test.ts` fail until it is placed —
that is intended.

1. Read the lab's `lab.yaml`: task, objectives, skills, prerequisites.
2. Choose the stage its subject belongs to, and place it after its prerequisites.
3. Give it the path skills it really practises, one sentence of `why`, and
   `optional: true` if it is extra practice (a core lab cannot depend on an
   optional one).
4. If it closes a gap, update or remove that stage's `coming_soon` note.
5. Run `npm run validate:labs`, then the orchestrator and API learning-path suites.

## How to add a learning path

1. Create `labs/learning-paths/<id>.yaml` (the file name must equal `id`), reusing
   skills from `skills.yaml` and adding any new ones there.
2. It appears at `GET /api/learning-paths` and `#/paths` with no code change.
   Paths need not include every lab; only the flagship path is tested for that.
3. The *Learning Path* navigation link and the dashboard panel open the flagship
   path (`FLAGSHIP_PATH_ID`); change that constant only to change the flagship.

## Tests

| Suite | Covers |
|---|---|
| `services/lab-orchestrator/test/learning-paths.test.ts` | shipped paths load clean, stage order, every lab placed once, prerequisite order, gaps explained, no invented Git/Helm labs; every validation rule; catalog loading |
| `services/lab-orchestrator/test/catalog-validation.test.ts` | the shipped catalog validates with no errors; each whole-catalog rule against a one-defect fixture (duplicate id, unknown prerequisite, cycle, layout, missing setup asset, seeding collision, symlink, unknown skill, unplaced lab, invalid path reference) |
| `services/verifier/test/catalog-starter-state.test.ts` | no lab graded by reading the sandbox passes Verify on its untouched starter files |
| `services/lab-orchestrator/test/learning-progress.test.ts` | no progress, partial, attempted-not-completed, completed stage, Coming soon never blocks, went-ahead student, prerequisite first, running-lab precedence, unknown sessions, extra practice, path complete, skill progress, unavailable labs, determinism; the real path's new-student, LINUX-001…007 and all-complete answers |
| `apps/api/test/learning-paths-api.test.ts` | routes, totals from the catalog, gaps, no internal keys, 400/404, 401, verified-only completion through Start → Verify → End, running-lab precedence, no session id, student isolation vs query/header, 503 on progress outage, unknown session store, `/health` |
| `apps/web/test/learning-path.test.tsx` | routes, loading, stage list statuses in words, current stage, gaps, "Available labs completed", progress outage, API outage, unknown path/stage, stage detail, Coming soon stage, not locked, running lab, navigation focus |
| `apps/web/test/dashboard.test.tsx` | path panel, continue journey, running lab, progress outage, path outage |
| `apps/web/test/navigation.test.tsx` | six sections, Learning Path marked on stage pages |

## Known limitations

- **One path.** The model supports many; only DevOps Engineer is written.
- **Progress means "attempted" or "verified".** A launch refused for capacity
  still marks a lab *In progress* (existing behaviour of `services/progress`), so
  it can be offered as *continue this lab*.
- **Availability is per provider**, re-read on each request; a lab whose
  provider is down is skipped by the next-lab rule and marked on the stage page.
- **Not personalised beyond the rule.** No time, hint-usage or difficulty signals
  are used, and nothing is learned from other students.
- **Lab pages do not yet show which stage a lab belongs to.**
- **Skill ids in `lab.yaml` are not unified** (for example LINUX-011 uses
  `permissions.*`); paths use their own skill catalog rather than rewriting labs.
