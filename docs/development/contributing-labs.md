# Contributing labs and verifier checks

The contributor workflow for adding a lab, and for adding a new kind of check
when no existing requirement type fits. It is about *how to contribute*, not
about what makes a lab educationally good. References it leans on:

- the lab schema, the setup engine and hints: [README → The lab catalog](../../README.md#the-lab-catalog)
  and the worked examples in [README → Adding a lab](../../README.md#adding-a-lab);
- the requirement vocabulary and what "unused" means: [verifier-requirement-vocabulary.md](../verifier-requirement-vocabulary.md);
- Docker-track verifier contracts: [docker/VERIFIER-CONTRACTS.md](../docker/VERIFIER-CONTRACTS.md);
- learning paths, stages and skills: [learning-paths.md](../learning-paths.md);
- what the catalog validator checks and why: [catalog-quality-audit.md](catalog-quality-audit.md).

---

## 1. Adding a lab

A lab is data. No TypeScript, route, component or handler is written for one.

1. **Directory.** `labs/<track>/<slug>/lab.yaml`, where `slug` in the file
   equals the directory name and `id` is unique across the catalog
   (`K8S-011`, `LINUX-020`, …). The schema is
   `services/lab-orchestrator/src/lab-definition.ts`; the loader refuses
   unknown keys, duplicate ids and slugs, dangling or cyclic prerequisites, and
   references to third-party training sites.
2. **Environment.** `environment.provider` names the substrate: `kubernetes`,
   `linux`, `terraform`, `docker`, `ansible`, `cicd` (the AWS and CS tracks run
   on `linux`). The loader refuses a requirement the provider cannot verify.
3. **Starting state** (`setup:`), by provider:
   - `manifests:` — Kubernetes objects applied into the session's namespace; no
     `metadata.namespace` (refused);
   - `files:` — starter files copied from the lab directory into the sandbox
     home (`source`, `path`, `mode`; execute bits are always stripped);
   - `seed_scripts:` — platform-authored scripts run as root in a container
     sandbox before the student arrives, then deleted;
   - `verify:` — requirements that must hold *before* the student is handed the
     environment, so a broken setup fails at Start rather than at Verify.
4. **Requirements.** `requirements:` lists checks from the closed vocabulary in
   `services/lab-orchestrator/src/requirements.ts`. The student's checklist
   and the verifier read the same list. Pick existing types first — the
   catalog uses far fewer than the verifier registers.
5. **Learning path — required.** Place the lab in the flagship path,
   `labs/learning-paths/devops-engineer.yaml`, exactly once, in a stage whose
   order respects the lab's prerequisites. `validate:labs` fails with
   `LEARNING_PATH_COVERAGE` for a lab that is not placed. New skills go in
   `labs/learning-paths/skills.yaml` ([learning-paths.md → How to add a skill](../learning-paths.md#how-to-add-a-skill)).
6. **Validate.**

   ```bash
   npm run validate:labs              # exit 1 on any error; one line per finding
   npm run validate:labs -- --strict  # warnings fail too
   ```

   It loads the catalog through the same registry the api uses, plus the
   repository rules (setup assets read through the providers' own loaders,
   seeding collisions, symlinks, executable bits, unreferenced files, files
   named like a solution). It needs no Docker, cluster or database, and it is
   the `gates` CI step.
7. **See it.** With `make up` running, `labs/` is bind-mounted into the api:
   `docker compose -f docker-compose.yml -f docker-compose.runtime.yml restart api`,
   then `curl -s localhost:4000/health | jq '.data | {labsLoaded, labLoadErrors}'`.

## 2. Testing a lab

What runs automatically, without writing a test:

| Suite | Covers every lab that… | Runs in |
|---|---|---|
| `validate:labs` | exists | `gates` |
| `services/verifier/test/catalog-starter-state.test.ts` (and `-kubernetes`, `-docker`) | can be modelled statically: its starting state does not already pass Verify | `gates` (`npm test`) |
| `services/lab-orchestrator/test/labs-integration.test.ts` | is a Kubernetes lab: provisioned, solved, verified, reset and torn down on a real cluster | `kind-integration` |

What a contributor adds:

- **A per-lab verification suite** for a sandbox lab whose shortcuts matter:
  `services/verifier/test/<lab-id>-verification.test.ts`, against the in-memory
  sandbox in `services/verifier/test/sandbox-fake.ts`. The established shape
  (see `cs-001-verification.test.ts`): the correct solution passes; each
  plausible shortcut fails; the failure detail describes what was *observed*,
  never the expected value (a check that prints the answer is an answer key).
- **A real-runtime suite** only when the fake cannot answer the question: the
  Docker track's `docker0NN-integration.test.ts`, the Networking track's
  `net0NN-integration.test.ts`. Name it `*-integration.test.ts`, gate it, skip
  with `context.skip(reason)`, and add it to the CI job that runs its family —
  `ci-gate-wiring.test.ts` checks that integration suites are wired somewhere.

## 3. Adding a new kind of check

Only when no existing type can express the requirement.

1. **Declare it** in `services/lab-orchestrator/src/requirements.ts`: its zod
   schema and its **family** (kubernetes, filesystem, terraform, linux, docker,
   ansible, cicd, …). The family decides which reader answers it and which
   providers may use it.
2. **Implement it** in `services/verifier/src/handlers/` and register it in
   `services/verifier/src/registry.ts`. The handler tables are mapped types over
   each family's requirement union, so a type with no handler — or a handler
   registered against the wrong reader — does not compile.
3. **Keep it read-only.** A handler gets a reader already scoped to one
   session's sandbox. It must not take a namespace, container name or command
   from lab content; anything it runs must be on the allow-list the sandbox
   provider enforces.
4. **Test it** in `services/verifier/test/`: pass, fail, and the observed detail
   for each, plus whatever shortcut the new check exists to catch.
5. `npm run typecheck`, `npm test`, `npm run validate:labs`.

## 4. Checklist

- [ ] `lab.yaml` under `labs/<track>/<slug>/`, `slug` = directory name, unique `id`.
- [ ] Starting state through `setup.manifests` / `files` / `seed_scripts`, and a
      `setup.verify` that proves it.
- [ ] Requirements from the existing vocabulary, or a new type per §3.
- [ ] Placed once in `labs/learning-paths/devops-engineer.yaml`.
- [ ] `npm run validate:labs` exits 0; `npm test` passes (starter-state guard).
- [ ] A per-lab verification suite for any lab with a plausible shortcut.
- [ ] Started, verified, reset and ended once on `make up`, or the PR says it was not.
