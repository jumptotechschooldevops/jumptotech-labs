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
| **Missing** | A secret the service needs is empty. "Needs" is conditional where the capability is: the api needs `SANDBOXD_RUNTIME_SECRET` only with `SANDBOX_BROKER_URL`, and `SANDBOXD_DOCKER_SECRET` only when the Docker track is brokered too; the terminal needs `SANDBOXD_ATTACH_SECRET` only with `TERMINAL_SANDBOX_BROKER_ENABLED`; sandboxd needs `SANDBOXD_DOCKER_SECRET` only with `DOCKER_TRACK_ENABLED`. The api needs a database password whenever a database is configured. |
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

### The terminal's process identity

Kubernetes- and Docker-track shells are PTYs spawned by the terminal service, in
its container, as `student` (uid 1001). The image used to start the service as
that same account, and Linux lets a same-uid process read a dumpable process'
`/proc/<pid>/environ` and open its `/proc/<pid>/mem`. Every such student could
read `TERMINAL_SESSION_SECRET`, `INTERNAL_SERVICE_SECRET` and
`SANDBOXD_ATTACH_SECRET`. Verified in a container before the fix; see §4.

The image now starts as root with `cap_drop: ALL` plus `SETUID` and `SETGID`, and
the service drops to 1001 before anything else
([`services/terminal/src/process-identity.ts`](../services/terminal/src/process-identity.ts)).
The uid change makes the kernel mark the process non-dumpable, which closes both
files to other uid-1001 processes, and clears both capabilities. In production
the service refuses to start without `TERMINAL_DROP_TO_UID`, or when it did not
start as root and so could not drop.

## 3. Development

- `make secrets` (run by `make setup`) generates every secret separately into
  `.env` (mode 0600) and prints only names. It replaces empty and placeholder
  values, fails if `openssl` is missing or misbehaves, and refuses duplicates.
  One exception: a placeholder `POSTGRES_PASSWORD` in an `.env` it did not
  create is kept with a warning, because an existing database volume was
  initialised with it.
- The compose files require every secret with `${NAME:?…}`. None is defaulted,
  and none is defaulted to another secret; only `OIDC_CLIENT_SECRET` may be
  empty, which switches browser sign-in off.
- A service run directly (`npm run dev:api`) without `INTERNAL_SERVICE_SECRET` or
  `NAMESPACE_DERIVATION_SECRET` falls back to `TERMINAL_SESSION_SECRET` and logs
  `development_secret_fallback`. Production refuses that.
- Changing `NAMESPACE_DERIVATION_SECRET` (including the first `make secrets` on an
  `.env` that relied on the old fallback) orphans the sandboxes of sessions live
  at that moment. End them first, or run `make sandbox-clean`.

## 4. How it is proven

| Proof | Runs | Shows |
|---|---|---|
| `services/observability/test/compose-secret-distribution.test.ts` | `npm test` | each compose service references exactly its allowlist; no secret defaulted or chained; no `env_file`; the kubeconfig, scrape-token and Docker socket mounts go only to their owners; credential-carrying ports are never published beyond loopback (BETA-P0-011) |
| `node scripts/check-secret-distribution.mjs` (`make secrets-check`) | CI `gates`, laptop | the same, through `docker compose config` with sentinel values and a scrubbed environment; prints names only |
| `services/observability/test/secret-policy.test.ts` | `npm test` | the rules above; refusals never contain values; the setup script uses the same placeholder list |
| `apps/api/test/secret-boundaries.test.ts` | `npm test` | api gates; provider-shaped secrets pass the self-test and are redacted; no sentinel secret in `/health`, `/auth/*`, a refused `/internal` call, a 404, metrics or logs |
| `services/terminal/test/secret-boundaries.test.ts` | `npm test` | terminal gates; the drop order and production refusals; the image and compose wiring the drop depends on |
| `services/sandboxd/test/config-secrets.test.ts` | `npm test` | sandboxd gates, derivation-key distinctness |
| `apps/web/test/no-server-secrets.test.ts` | `npm test` | the bundle reads only `VITE_API_URL`/`VITE_TERMINAL_WS_URL`; no `define`/`envPrefix`; the image gets no other build args |

Manual, and worth repeating on a release candidate:

```bash
# The environ probe, against the real image: a uid-1001 process with a clean
# environment must find no readable environ carrying a secret.
docker build -f infrastructure/docker/terminal.Dockerfile -t jumptotech/terminal:probe .
# run it with cap_drop ALL + SETUID/SETGID and the compose tmpfs mounts, then:
docker exec -u 1001:1001 <container> env -i PATH=/usr/bin:/bin sh -c \
  'for d in /proc/[0-9]*; do tr "\0" "\n" < $d/environ 2>/dev/null | grep -q "^TERMINAL_SESSION_SECRET=." && echo "LEAK ${d#/proc/}"; done; true'

# The bundle, built with sentinel secrets in the environment:
TERMINAL_SESSION_SECRET=sentinel-$(openssl rand -hex 8) npx vite build --outDir /tmp/web-dist apps/web
grep -r sentinel- /tmp/web-dist && echo LEAK
```

## 5. Remaining risks and deferred decisions

- **A student shell can still signal the terminal service.** It shares uid 1001,
  so `kill` works and one student can end every shell on that terminal instance.
  The full fix gives shells a uid the service does not have (the "Phase 11B"
  model), which changes ownership of workspaces and per-session credentials.
- **Root helper processes keep `SETUID`/`SETGID`.** The image runs TypeScript
  through `tsx`, so `docker-init`, the `tsx` CLI parent and its `esbuild` service
  start before the drop and stay root. None of them runs student input, and a
  uid-1001 shell cannot signal, trace or read them (verified), but they are
  capability-holding processes a compiled image would not have.
- **All shells on one terminal share uid 1001**, so one student can read another
  live student's per-session kubeconfig or Docker client key if they can find its
  path. Per-session credentials, not platform secrets, but a cross-student gap.
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
