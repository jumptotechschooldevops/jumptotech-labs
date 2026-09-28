# Secret boundaries — BETA-P0-010

Which process holds which secret, what each one refuses at startup, and how the
boundary is proven. The allowlist itself lives in
[`infrastructure/secret-distribution.json`](../infrastructure/secret-distribution.json);
this document explains it.

## 1. Distribution matrix

The full stack: `docker-compose.yml` + `docker-compose.runtime.yml` +
`docker-compose.observability.yml`.

| Secret | postgres | api | terminal | sandboxd | web | prometheus | grafana | Student shell / browser |
|---|---|---|---|---|---|---|---|---|
| `TERMINAL_SESSION_SECRET` | | ✓ sign tokens | ✓ verify tokens | | | | | ✗ |
| `INTERNAL_SERVICE_SECRET` | | ✓ `/internal`, terminal control | ✓ calls `/internal` | | | | | ✗ |
| `NAMESPACE_DERIVATION_SECRET` | | ✓ derive names | | ✓ re-derive refs | | | | ✗ |
| `SANDBOXD_ATTACH_SECRET` | | **refused** | ✓ open broker shell | ✓ verify | | | | ✗ |
| `SANDBOXD_RUNTIME_SECRET` | | ✓ create/destroy | **refused** | ✓ verify | | | | ✗ |
| `SANDBOXD_DOCKER_SECRET` | | ✓ Docker track | **refused** | ✓ verify | | | | ✗ |
| `OIDC_CLIENT_SECRET` | | ✓ code exchange | **refused** | **refused** | | | | ✗ |
| `POSTGRES_PASSWORD` | ✓ | ✓ inside `DATABASE_URL` | **refused** | **refused** | | | | ✗ |
| `OBSERVABILITY_SCRAPE_TOKEN` | | ✓ | ✓ | ✓ | | file mount | | ✗ |
| `GRAFANA_ADMIN_PASSWORD` | | | **refused** | **refused** | | | ✓ | ✗ |
| kind kubeconfig (file) | | ✓ mount | | | | | | ✗ |

✓ = receives it. **refused** = that service's production startup refuses to run
if the variable is present at all. A blank cell = not distributed. Alertmanager
receives nothing.

Per-session credentials (namespace-scoped kubeconfig, sandbox-scoped Docker client
certificate) are fetched by the terminal for one shell, written 0600, and deleted
with it. They are not platform secrets and are outside this matrix.

## 2. Startup rules (`NODE_ENV=production`)

Every service runs `assertProductionSecrets`
([`services/observability/src/secret-policy.ts`](../services/observability/src/secret-policy.ts))
and refuses to start, naming variables and never values, when any of these holds:

| Rule | Detail |
|---|---|
| **Missing** | A secret the service needs is empty. "Needs" is conditional where the capability is: the api needs `SANDBOXD_RUNTIME_SECRET` only with `SANDBOX_BROKER_URL`, and `SANDBOXD_DOCKER_SECRET` only when the Docker track is brokered too; the terminal needs `SANDBOXD_ATTACH_SECRET` only with `TERMINAL_SANDBOX_BROKER_ENABLED`; sandboxd needs `SANDBOXD_DOCKER_SECRET` only with `DOCKER_TRACK_ENABLED`. The api needs a database password whenever a database is configured, and `OIDC_CLIENT_SECRET` whenever `AUTH_MODE=oidc` (BETA-P0-014: a production API nobody could sign in to used to start). |
| **Placeholder** | The value contains `change-me`, `changeme`, `dev-only`, `insecure`, `placeholder`, `example`, `replace-me`, `your-`, `not-a-secret`, `default`… — so every value `.env.example` ships is refused however long it is. |
| **Too short** | Under 32 characters for generated secrets; under 16 for the two the platform is issued (`OIDC_CLIENT_SECRET`, the database password). |
| **Low entropy** | Fewer than 8 distinct characters. |
| **Shared** | Two secrets a service holds have the same value. |
| **Forbidden** | A secret from another service's column is present (the **refused** cells above). |

Additionally, in every environment:

- sandboxd refuses two equal scope secrets (existing), and a
  `NAMESPACE_DERIVATION_SECRET` equal to any scope secret (new);
- every service refuses a scrape token equal to a privileged secret (existing);
- every service's redaction self-test covers the secrets it holds. The api now
  includes `OIDC_CLIENT_SECRET` and `POSTGRES_PASSWORD`, registered for
  exact-value redaction first, because a provider decides their shape.

### The terminal's process identity (SEC-ARCH-2, was BETA-P0-010)

Kubernetes- and Docker-track shells are PTYs the terminal service spawns in its
own container. Two leaks followed from that, in turn:

- **BETA-P0-010.** The image started the service as `student` (1001), the same
  account as every shell, and Linux lets a same-uid process read a dumpable
  process' `/proc/<pid>/environ` and `/proc/<pid>/mem`. Every shell could read
  `TERMINAL_SESSION_SECRET`, `INTERNAL_SERVICE_SECRET` and
  `SANDBOXD_ATTACH_SECRET`. That fix dropped the whole service to 1001 inside
  the process, which marked it non-dumpable.
- **SEC-ARCH-2.** Every shell still ran as that one uid. One student could list
  `/run/jumptotech`, read another's kubeconfig or Docker client key, write into
  their workspace, and signal their processes and the service. A `nohup`ed
  process outlived its session. Proven live in the release gate soak.

Now every session's shell runs as a uid of its own:

```text
container: root only to exec setpriv; cap_drop ALL + SETUID SETGID CHOWN; no-new-privileges
  └─ setpriv → terminal service: uid jtt-terminal (1002), SETUID/SETGID/CHOWN as ambient caps
       └─ prlimit --nproc → setpriv → env -C <home> → bash
            uid = the session's shell uid (1900000000+, assigned by the api per session)
            no capabilities, no supplementary groups, no_new_privs
```

- **Allocation.** The api assigns the uid when the session row is created:
  `lab_sessions.shell_uid`, `DEFAULT nextval` of a `NO CYCLE` sequence, with
  `UNIQUE` and a range `CHECK` (migration 007;
  [`shell-identity.ts`](../services/lab-orchestrator/src/session/shell-identity.ts)).
  - It is distinct for every session and stable across restarts.
  - It is never reused, and never chosen by a client.
  - It reaches the terminal only on the owner-checked credential exchange.
  - A local-shell session without a valid uid gets no shell.
- **Terminal.** [`services/terminal/src/shell-identity.ts`](../services/terminal/src/shell-identity.ts)
  starts every shell through `setpriv`.
  - `setpriv` clears the inheritable and ambient sets. Without that, a uid
    change between two non-root uids keeps them, and the shell would hold
    `CAP_SETUID`. This was proven by removing the clearing: the shell then
    became root.
  - A session's kubeconfig or Docker key is `0600`, and its home or workspace
    `0700`, all owned by the session's uid, under service-owned `0711` roots
    that nobody can list.
  - At End every process of the uid is killed (`kill -9 -1` run *as* that uid)
    and proven gone, and its files are taken back and removed.
- **Startup gate.** In production the terminal refuses to start in any of these
  cases:
  - it runs as root;
  - it lacks SETUID, SETGID or CHOWN;
  - it holds any capability beyond those three;
  - `no_new_privs` is not set;
  - its uid lies in the shell range.

The service's own secrets stay closed to every shell: no shell shares its uid, so
the kernel refuses `/proc/<pid>/environ`, `/proc/<pid>/mem` and signals. The
proof runs on a real kernel, under the production launch, in
`make test-terminal-isolation` (CI: `terminal-integration`).

## 3. Development

- `make secrets` (run by `make setup`) generates every secret separately into
  `.env` (mode 0600) and prints only names. It replaces empty and placeholder
  values, fails if `openssl` is missing or misbehaves, and refuses duplicates.
  One exception: a placeholder `POSTGRES_PASSWORD` in an `.env` it did not
  create is kept with a warning, because an existing database volume was
  initialised with it.
- The compose files require every secret with `${NAME:?…}`. None is defaulted,
  and none is defaulted to another secret; only `OIDC_CLIENT_SECRET` may be
  empty, which switches browser sign-in off outside production (the api refuses
  to start that way under `NODE_ENV=production`).
- A service run directly (`npm run dev:api`) without `INTERNAL_SERVICE_SECRET` or
  `NAMESPACE_DERIVATION_SECRET` falls back to `TERMINAL_SESSION_SECRET` and logs
  `development_secret_fallback`. Production refuses that.
- Changing `NAMESPACE_DERIVATION_SECRET` (including the first `make secrets` on an
  `.env` that relied on the old fallback) orphans the sandboxes of sessions live
  at that moment. End them first, or run `make sandbox-clean`.

## 4. How it is proven

| Proof | Runs | Shows |
|---|---|---|
| `services/observability/test/compose-secret-distribution.test.ts` | `npm test` | each compose service references exactly its allowlist; no secret defaulted or chained; no `env_file`; the kubeconfig, scrape-token, Docker socket and web TLS key mounts go only to their owners; credential-carrying ports are never published beyond loopback (BETA-P0-011); every development port on loopback, production exactly 443 and 80, and PostgreSQL alone with the api on its network (BETA-P0-012, [runtime-architecture.md §11](runtime-architecture.md)) |
| `node scripts/check-secret-distribution.mjs` (`make secrets-check`) | CI `gates`, laptop | the same, through `docker compose config` with sentinel values and a scrubbed environment; prints names only |
| `services/observability/test/tls-edge-contract.test.ts` | `npm test` | BETA-P0-017: the web TLS key stays out of git (`.gitignore`), every build context (`.dockerignore`), every Dockerfile `COPY`, the browser bundle and every service's source; the certificate gate and `scripts/tls-install.sh` never print, copy or hash the key beyond its public half ([runtime-architecture.md §12](runtime-architecture.md)) |
| `services/observability/test/tls-certificate-health.test.ts`, `tls-edge-integration.test.ts` | `npm test`; `make test-tls-edge` (CI `tls-edge-integration`) | no key material in any report, check output, install output or edge container log, including every refusal |
| `services/observability/test/secret-policy.test.ts` | `npm test` | the rules above; refusals never contain values; the setup script uses the same placeholder list |
| `apps/api/test/secret-boundaries.test.ts` | `npm test` | api gates; provider-shaped secrets pass the self-test and are redacted; no sentinel secret in `/health`, `/auth/*`, a refused `/internal` call, a 404, metrics or logs |
| `services/terminal/test/secret-boundaries.test.ts` | `npm test` | terminal gates; the drop order and production refusals; the image and compose wiring the drop depends on |
| `services/sandboxd/test/config-secrets.test.ts` | `npm test` | sandboxd gates, derivation-key distinctness |
| `apps/web/test/no-server-secrets.test.ts` | `npm test` | the bundle reads only `VITE_API_URL`/`VITE_TERMINAL_WS_URL`; no `define`/`envPrefix`; the image gets no other build args |

Manual, and worth repeating on a release candidate:

```bash
# Per-session shell identities, and the service's secrets closed to every
# shell, on a real kernel under the production launch (SEC-ARCH-2):
make test-terminal-isolation

# The environ probe, against the real image: a process with a session shell uid
# and a clean environment must find no readable environ carrying a secret.
docker build -f infrastructure/docker/terminal.Dockerfile -t jumptotech/terminal:probe .
# run it as docker-compose.yml does (cap_drop ALL + SETUID/SETGID/CHOWN,
# no-new-privileges, the 0711 tmpfs mounts owned by 1002), then:
docker exec -u 1900000999:1900000999 <container> env -i PATH=/usr/bin:/bin sh -c \
  'for d in /proc/[0-9]*; do tr "\0" "\n" < $d/environ 2>/dev/null | grep -q "^TERMINAL_SESSION_SECRET=." && echo "LEAK ${d#/proc/}"; done; true'

# The bundle, built with sentinel secrets in the environment:
TERMINAL_SESSION_SECRET=sentinel-$(openssl rand -hex 8) npx vite build --outDir /tmp/web-dist apps/web
grep -r sentinel- /tmp/web-dist && echo LEAK
```

## 5. Remaining risks and deferred decisions

- **Shells no longer share a uid with each other or with the service
  (SEC-ARCH-2).**
  - Closed:
    - one student reading another's kubeconfig, Docker key or workspace;
    - signalling another's processes or the service;
    - a process outliving its session.
  - What remains is shared by design:
    - **`/tmp`** is one directory (mode `1777`), so a file a student
      deliberately leaves there world-readable can be read by another. Homes
      and workspaces are `0700`.
    - **The container's pid limit** is shared too. Each shell's own
      `RLIMIT_NPROC` bounds one student, but `pids_limit` bounds everyone
      together.
- **Root and capability-holding helpers.**
  - The container's init (`docker-init`) is root and holds the container's
    capabilities. It runs no student input.
  - The service, and the `esbuild` helper `tsx` starts, run as `jtt-terminal`
    holding SETUID, SETGID and CHOWN. No shell can signal, trace or read them.
  - A compiled image would have no `esbuild` helper.
- **`TERMINAL_SESSION_SECRET` is symmetric.** The terminal holds the key that
  mints tokens, not only one that verifies them. The API re-checks ownership on
  every credential fetch, which bounds this; asymmetric signing would remove it.
- **No secret manager.** Secrets are environment variables from `.env`, visible to
  anyone who can `docker inspect` the host. Choosing a store (Vault, a cloud
  secret manager, Kubernetes Secrets with encryption at rest), file-based
  delivery, and a rotation procedure are infrastructure decisions this story
  deliberately does not make.
- **Secrets in transit.** The sandboxd scope secrets travel in a request header.
  Since BETA-P0-011, production refuses plaintext to anything but loopback or a
  declared single-host bridge, and verifies TLS otherwise. See
  [runtime-architecture.md §8](runtime-architecture.md#8-the-application-tier-and-the-runtime-tier-beta-p0-011).
  `INTERNAL_SERVICE_SECRET` (api ⇄ terminal) and the scrape token are still
  plaintext on the wire, so both hops must stay on one private network.
- **Grafana and Postgres are third-party images.** Their secrets are required by
  compose and generated by `make secrets`, but no code of ours can refuse a weak
  value inside them.
- **Database authentication without a password** (client certificates, IAM) is
  refused in production today, because a configured database without a password
  fails the gate. A deployment that needs it has to extend the gate deliberately.
