# Documentation map

Which document is the authority for what. When two documents describe the same
thing, the one listed here as the authority wins, and the other should link to it
rather than repeat it. Files beat documents: `package.json`, the `Makefile`,
`docker-compose*.yml`, `.env.example` and `.github/workflows/` are the final word
on commands, services, variables and CI.

Every Markdown file under `docs/` appears on this page exactly once, in one of
three kinds, and `services/observability/test/documentation-contract.test.ts`
fails the build for one that does not:

- **Authorities** — current, maintained, and held to the repository: every
  relative link resolves, and every `npm run` script and `make` target they name
  exists.
- **Design and curriculum specifications** — plans and designs, some describing
  things that are not built. Read them as intent, not as instructions.
- **Records** — dated reports of one audit or pass. They describe the repository
  *at that commit* and are not updated afterwards; their links are still
  checked, their commands are not. Do not follow a record's instructions without
  checking the authority.

---

## Authorities

### Start here

| For | Document |
|---|---|
| what the product is; the long-form reference for providers, catalog, verifier, progress, security and limitations | [../README.md](../README.md) |
| a new engineer: toolchain, install, first change, which scripts are safe | [development/getting-started.md](development/getting-started.md) |
| the services, their boundaries and the request flows | [architecture.md](architecture.md) |
| a new operator, or whoever is on call: the map of operator documents | [runbooks/operator-guide.md](runbooks/operator-guide.md) |

### Development

| Subject | Authority |
|---|---|
| local test commands, what each needs, PASS vs SKIPPED | [development/testing.md](development/testing.md) |
| test tiers, the host-execution guard, run-scoped naming | [../test-support/README.md](../test-support/README.md) |
| CI jobs, what each proves, merge readiness, supply chain | [development/ci-and-release-gates.md](development/ci-and-release-gates.md) |
| the real-browser E2E suite and its stack | [development/browser-e2e-private-beta.md](development/browser-e2e-private-beta.md) |
| adding a lab or a verifier check | [development/contributing-labs.md](development/contributing-labs.md) |

### Architecture and platform

| Subject | Authority |
|---|---|
| compose stacks, the runtime broker, ports, what runs where | [runtime-architecture.md](runtime-architecture.md) |
| `RUNTIME_OWNER_ID`, ownership labels, image-tag policy | [runtime-ownership.md](runtime-ownership.md) |
| sign-in, identity, the production auth gates | [authentication.md](authentication.md) |
| which service may hold which secret | [secret-boundaries.md](secret-boundaries.md) |
| logs, metrics, health, alert design | [observability.md](observability.md) |
| what the beta is measured by: indicators, objectives, operator questions | [beta-slo-indicators.md](beta-slo-indicators.md) |
| Kubernetes NetworkPolicy and its enforcement proof | [kubernetes-network-security.md](kubernetes-network-security.md) |
| PodSecurity admission and the namespace policy | [pod-security.md](pod-security.md) |

### Labs and the student product

| Subject | Authority |
|---|---|
| what a student sees, screen by screen | [student-experience.md](student-experience.md) |
| learning paths, stages, skills, the next-lab rule | [learning-paths.md](learning-paths.md) |
| the verifier's requirement vocabulary | [verifier-requirement-vocabulary.md](verifier-requirement-vocabulary.md) |
| Docker-track verifier contracts | [docker/VERIFIER-CONTRACTS.md](docker/VERIFIER-CONTRACTS.md) |
| DOCKER-009 manual verification procedure | [docker/DOCKER-009-MANUAL-TEST.md](docker/DOCKER-009-MANUAL-TEST.md) |

### Production and the private beta

| Subject | Authority |
|---|---|
| a new host: prerequisites, preflight, deployment, smoke, upgrade, rollback | [development/production-host-readiness.md](development/production-host-readiness.md) |
| running the beta day to day; `prod` and the helpers | [runbooks/private-beta-operations.md](runbooks/private-beta-operations.md) |
| incidents A–U, by what you see | [runbooks/private-beta-incident-response.md](runbooks/private-beta-incident-response.md) |
| the alert runbooks RB-01…RB-21 and their index | [runbooks/README.md](runbooks/README.md) |
| backup and restore of PostgreSQL | [runbooks/postgres-backup-restore.md](runbooks/postgres-backup-restore.md) |
| disaster recovery: host loss, reboot, database or runtime loss, a replacement host | [runbooks/disaster-recovery.md](runbooks/disaster-recovery.md) |
| what a recovery drill must record | [releases/disaster-recovery-drill-evidence-template.md](releases/disaster-recovery-drill-evidence-template.md) |
| certificates and the TLS edge | [runbooks/production-tls.md](runbooks/production-tls.md) |
| the five-student release gate | [runbooks/five-student-beta-validation.md](runbooks/five-student-beta-validation.md) |
| diagnostics underneath the runbooks: request tracing, health endpoints | [incident-troubleshooting.md](incident-troubleshooting.md) |
| rehearsed failures | [incident-exercises.md](incident-exercises.md) |
| the private-beta release decision and its conditions | [releases/private-beta-release-gate.md](releases/private-beta-release-gate.md) |
| what a deployment must record | [releases/production-host-evidence-template.md](releases/production-host-evidence-template.md) |
| who may use labs: entitlements, the `ops access` commands, the payment boundary | [commercial-access.md](commercial-access.md) |

The alert runbooks, one per alert family:
[RB-01](runbooks/RB-01-service-down.md) ·
[RB-02](runbooks/RB-02-database.md) ·
[RB-03](runbooks/RB-03-lab-start-failures.md) ·
[RB-04](runbooks/RB-04-capacity.md) ·
[RB-05](runbooks/RB-05-cleanup-and-leaks.md) ·
[RB-06](runbooks/RB-06-sandboxd.md) ·
[RB-07](runbooks/RB-07-no-labs-loaded.md) ·
[RB-08](runbooks/RB-08-security-events.md) ·
[RB-09](runbooks/RB-09-provider-unavailable.md) ·
[RB-10](runbooks/RB-10-provisioning-slow.md) ·
[RB-11](runbooks/RB-11-api-errors-and-latency.md) ·
[RB-12](runbooks/RB-12-terminal.md) ·
[RB-13](runbooks/RB-13-verification.md) ·
[RB-14](runbooks/RB-14-auth.md) ·
[RB-15](runbooks/RB-15-tls-edge.md) ·
[RB-16](runbooks/RB-16-backups.md) ·
[RB-17](runbooks/RB-17-session-lifecycle.md) ·
[RB-18](runbooks/RB-18-network-isolation.md) ·
[RB-19](runbooks/RB-19-host-pressure.md) ·
[RB-21](runbooks/RB-21-launches-paused.md)
(there is no RB-20).

---

## Design and curriculum specifications

Not instructions. The AWS track that ships is **simulated** (no credentials, no
AWS API); the documents below describing a real-AWS provider, its configuration
variables (`AWS_TRACK_ENABLED`, `AWS_ORG_LAB_ACCESS_ROLE_ARN`, …) and its
account pool describe a design that is not implemented — nothing reads those
variables.

| Document | What it is |
|---|---|
| [aws-track-architecture.md](aws-track-architecture.md) | design of a real-AWS provider |
| [aws-production-security-spec.md](aws-production-security-spec.md) | security specification for that design, and the 35-lab curriculum |
| [aws-verification-architecture.md](aws-verification-architecture.md) | design of AWS verification |
| [aws-mvp-curriculum.md](aws-mvp-curriculum.md) | AWS curriculum plan |
| [aws-curriculum-source-verification.md](aws-curriculum-source-verification.md) | official-source review of that plan |
| [docker/CURRICULUM-PLAN.md](docker/CURRICULUM-PLAN.md) | Docker-track rebuild plan ("nothing in this document is implemented") |
| [docker/CERTIFICATION-AUDIT.md](docker/CERTIFICATION-AUDIT.md) | Docker-track certification-metadata audit |

---

## Records

Dated; not maintained after their pass. Newest first within each group.

| Record | Date |
|---|---|
| [releases/launch-readiness-20h-report.md](releases/launch-readiness-20h-report.md) | 2026-09-27 |
| [releases/app-security-multi-tenant-audit.md](releases/app-security-multi-tenant-audit.md) | 2026-09-27 |
| [releases/overnight-disaster-recovery-audit.md](releases/overnight-disaster-recovery-audit.md) | 2026-09-21/22 |
| [releases/overnight-cicd-supply-chain-report.md](releases/overnight-cicd-supply-chain-report.md) | 2026-09-21 |
| [releases/overnight-code-health-audit.md](releases/overnight-code-health-audit.md) | 2026-09-26 |
| [releases/overnight-private-beta-certification.md](releases/overnight-private-beta-certification.md) | 2026-09-22 |
| [releases/overnight-commercial-readiness.md](releases/overnight-commercial-readiness.md) | 2026-09-21/22 |
| [releases/overnight-lab-certification-report.md](releases/overnight-lab-certification-report.md) | 2026-09-21 |
| [releases/overnight-devex-documentation-audit.md](releases/overnight-devex-documentation-audit.md) | 2026-09-21 |
| [releases/overnight-scale-resilience-report.md](releases/overnight-scale-resilience-report.md) | 2026-09-21 |
| [releases/overnight-final-hardening-report.md](releases/overnight-final-hardening-report.md) | 2026-09-20/21 |
| [releases/overnight-production-operations-report.md](releases/overnight-production-operations-report.md) | 2026-09-20/21 |
| [development/deployment-readiness-2026-09-19.md](development/deployment-readiness-2026-09-19.md) | 2026-09-19 |
| [development/lab-quality-pass-2026-09-19.md](development/lab-quality-pass-2026-09-19.md) | 2026-09-19 |
| [development/reliability-overnight-2026-09-19.md](development/reliability-overnight-2026-09-19.md) | 2026-09-19 |
| [development/security-redteam-2026-09-19.md](development/security-redteam-2026-09-19.md) | 2026-09-19 |
| [development/beta-operations-2026-09-18.md](development/beta-operations-2026-09-18.md) | 2026-09-18 |
| [development/lab-quality-pass-2026-09-18.md](development/lab-quality-pass-2026-09-18.md) | 2026-09-18 |
| [development/private-beta-launch-readiness-2026-09-17.md](development/private-beta-launch-readiness-2026-09-17.md) | 2026-09-17 |
| [development/private-beta-readiness-2026-09-17.md](development/private-beta-readiness-2026-09-17.md) | 2026-09-17 |
| [development/private-beta-overnight-report.md](development/private-beta-overnight-report.md) | 2026-09-16 |
| [development/catalog-quality-audit.md](development/catalog-quality-audit.md) | 2026-09-16 |
| [development/private-beta-security-audit.md](development/private-beta-security-audit.md) | 2026-09-16 |

`releases/private-beta-release-gate.md` is both: its current verdict and
conditions are authoritative, and its later numbered sections are dated records
of each re-validation.
