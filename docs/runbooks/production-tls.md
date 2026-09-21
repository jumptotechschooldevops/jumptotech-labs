# Production TLS: domain, certificates, renewal

**BETA-P0-017.** This is a procedure runbook, not an alert runbook. The design is
in [runtime-architecture.md §12](../runtime-architecture.md).

| | |
|---|---|
| **Proven** | The web image's certificate gate refuses 21 kinds of bad configuration, and nginx never starts. HTTPS, the port-80 redirect, the ACME route and the terminal WebSocket work through TLS. `scripts/tls-install.sh` renews in place without dropping an open terminal, refuses bad renewals without changing anything, and rolls back. `npm run tls:check` reports expiry and drift. All of it is proven against the real image with **test-only** certificates (`make test-tls-edge`). |
| **Not proven** | Issuance by any public CA, renewal on a schedule, a real DNS record, or a production host. None exists. Which CA, which ACME client, which hostname and where alerts go are **DECISION REQUIRED** (§10). |

---

## 1. What the edge does

`docker-compose.production.yml` publishes host 443 → `web:8443` (TLS) and host
80 → `web:8080` (redirect and ACME tokens), and nothing else.

- **443** serves exactly one host, the one in `PUBLIC_ORIGIN`, over TLS 1.2/1.3
  with forward-secret AEAD suites. A client that does not name that host gets no
  certificate. A `Host` header that differs from the TLS name gets `421`.
- **80** answers `/.well-known/acme-challenge/<token>` from
  `infrastructure/docker/nginx/acme-webroot/`, and sends every other request to
  `https://<host><same path>`.
- **Before nginx starts**, `jtt-tls-preflight` checks `PUBLIC_ORIGIN` and
  `infrastructure/docker/nginx/tls/{fullchain,privkey}.pem`. If anything is
  wrong, the container exits with a line starting `jtt-tls-preflight: REFUSED:`
  and nginx never listens. There is no plaintext fallback.
- **Every 60 seconds**, the health check confirms that the served certificate is
  the installed one and has not expired. `prod ps web` shows `unhealthy`
  otherwise. Being unhealthy does not stop traffic.

## 2. DNS and the public host name

1. Pick the host students will type. The repository contains no approved
   production hostname: every one in it is a placeholder (`labs.example.com`,
   `labs.jtt.test`). Choosing it is a decision (§10).
2. Create an `A` record (and `AAAA` only if the host really serves IPv6 on 443
   and 80) pointing at the host's public address, with whichever DNS provider
   holds the domain. Nothing here assumes a provider.
3. Set `PUBLIC_ORIGIN=https://<host>` in `.env`: lower case, no port, no path,
   no trailing path segments. The production overlay requires it for the api
   and the web container, and the gate refuses any other shape.
4. Confirm resolution from outside the host: `dig +short <host>`.
5. Optionally add a `CAA` record naming the chosen CA (§10).

Port 80 and 443 must reach the host. The firewall in front of it is still
**DECISION REQUIRED** ([§11.7](../runtime-architecture.md)).

## 3. Initial provisioning

The web container cannot start without a valid certificate, so the first
certificate is obtained **before** the stack starts. Choose one route. Both end
at §3.3.

### 3.1 From any CA (operator-supplied)

1. Generate the key on the host and never anywhere else:
   `openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout privkey.pem -out request.csr -subj "/CN=<host>" -addext "subjectAltName=DNS:<host>"`
   and `chmod 600 privkey.pem`. RSA 2048+ is also accepted.
2. Submit `request.csr` to the CA and complete its domain validation.
3. Build `fullchain.pem`: the issued certificate first, then the CA's
   intermediate(s), in order. Not the root. A file with only the server
   certificate is refused.

### 3.2 ACME HTTP-01 (any ACME CA)

**The CA and the client are not chosen (§10).** The commands below are the
generic shape. Adapt them to the client the decision selects.

- **First issuance, stack not running.** Port 80 is free, so use the client's
  *standalone* mode, which listens on port 80 itself for the few seconds of
  validation. For example, with certbot:
  `certbot certonly --standalone -d <host> --key-type ecdsa`
- **Every later issuance, stack running.** Use *webroot* mode, pointed at the
  directory nginx serves:
  `certbot certonly --webroot -w <repo>/infrastructure/docker/nginx/acme-webroot -d <host> --key-type ecdsa`

Before the first real issuance, make a trial run against the CA's **staging**
directory (§6). A staging certificate is refused by browsers and by `tls:check`,
and must never stay installed.

### 3.3 Install and start

```bash
scripts/tls-install.sh --cert /path/to/fullchain.pem --key /path/to/privkey.pem
# or: make tls-install CERT=/path/to/fullchain.pem KEY=/path/to/privkey.pem

prod up -d --build --wait --wait-timeout 900    # prod: private-beta-operations.md §1
```

`prod` is the whole production stack — five compose files and the
observability profile. Starting with fewer files brings the edge up without
monitoring and the api without its backup-status mount.

With the stack down, `tls-install.sh` checks the pair in a one-off web container
and copies it into place. With the stack up, it also reloads and proves (§4.3).
Never copy files into `infrastructure/docker/nginx/tls/` by hand while the stack
runs: the health check will report the drift until nginx reloads.

Verify:

```bash
prod logs web | grep jtt-tls-preflight    # "certificate OK: host=… notAfter=… sha256=…"
npm run tls:check -- --origin https://<host> --cert-dir infrastructure/docker/nginx/tls --expect-acme
```

`tls:check` should exit 0, with `files`, `served`, `http` and `acme` all `OK`.

## 4. Renewal

### 4.1 With an ACME client

Let the client's own scheduler (a systemd timer or cron job, typically twice a
day) run renewal in webroot mode, with `tls-install.sh` as its deploy hook, so a
renewed certificate is validated, installed and loaded the moment it exists:

```bash
certbot renew --deploy-hook \
  '<repo>/scripts/tls-install.sh --cert "$RENEWED_LINEAGE/fullchain.pem" --key "$RENEWED_LINEAGE/privkey.pem"'
```

The hook must run as a user that can use Docker. It exits non-zero on a refusal,
which the client reports as a failed hook.

### 4.2 Operator-supplied

Repeat §3.1 with a **new key** when `tls:check` warns (21 days before expiry).
Then run `tls-install.sh`. Shorter maximum lifetimes are coming
(CA/Browser Forum SC-081: 200 days from March 2026, 100 from March 2027, 47 from
March 2029), which makes this route a stopgap.

### 4.3 What `tls-install.sh` does, and reload behaviour

1. Stages the pair as `tls/*.next`, with the key at mode 600.
2. Runs `jtt-tls-preflight check` on it inside the web container: the same rules
   as startup. On a refusal it stops, and the live pair and nginx are untouched.
3. Keeps the live pair as `*.previous`, then renames the new pair into place.
4. `nginx -t`, then `nginx -s reload`. The reload is graceful: new connections
   get the new certificate. **Open terminal WebSockets keep running** on the old
   workers until they close; the integration suite proves one survives.
5. Waits until `jtt-tls-preflight served` sees the new certificate on :8443.

If step 4 or 5 fails, it restores `*.previous`, reloads again, and exits 1.

A container **restart** re-runs the startup gate. That is the right behaviour,
but it means a restart with an expired certificate keeps the edge down (§7.3).

## 5. Expiry monitoring

### 5.1 `npm run tls:check`

| Exit | Meaning | Who acts |
|---|---|---|
| 0 | OK | nobody |
| 1 | WARNING: expires in under 21 days (`renewal_due`), HSTS missing, port 80 closed, or the key could not be read by the check | renew this week |
| 2 | CRITICAL: under 7 days, expired, wrong host, untrusted chain, handshake failure, plaintext on port 80, the served certificate is not the installed one, or the check could not run | now, §7 |

Two places to run it, ideally both:

- **From outside the host** (a monitoring machine, a scheduled CI job). This sees
  what a student sees, through real DNS and the firewall:
  `npm run --silent tls:check -- --origin https://<host>`
- **On the host**, adding `--cert-dir infrastructure/docker/nginx/tls`. This also
  catches a renewal that was installed but never loaded, and a key that no longer
  matches.

For example, a cron entry. The alert command is **DECISION REQUIRED**:

```cron
17 */6 * * * cd /srv/jumptotech-labs && npm run --silent tls:check -- --origin https://<host> --cert-dir infrastructure/docker/nginx/tls >/var/log/jtt-tls-check.log 2>&1 || <alert command>
```

It needs Node 20+ and `npm ci` in that checkout. `--json` gives
machine-readable output. `--warn-days` and `--critical-days` change the windows.
It never prints key material.

### 5.2 The container health check

`docker compose ... ps web` shows `healthy` only while the certificate served on
:8443 is the installed one and in date. It cannot see DNS, the firewall or the
public chain; §5.1 can.

### 5.3 The Prometheus alert (BETA-P0-018)

With the production observability overlay
([private-beta-operations.md](private-beta-operations.md)), the API runs this
module's `probeHttpsEndpoint` and `probeHttpRedirect` against `web:8443` and
`web:8080` every five minutes, verified against the public roots, and exports
the result. `TlsCertificateRenewalDue` fires under 21 days and
`TlsCertificateExpiresWithin7Days` under 7 — `DEFAULT_EXPIRY_THRESHOLDS`, which
a test pins to the alert rules. `TlsEdgeUnhealthy` fires on a CRITICAL served
check. Runbook: [RB-15](RB-15-tls-edge.md).

It does not replace §5.1 from outside the host: it connects to the web
container directly, so it cannot see DNS, a firewall or the public route, and
it does not compare the served certificate with the installed files.

## 6. Staging and pre-production validation

- **Before DNS points at the host**, check the host by address:
  `npm run tls:check -- --origin https://<host> --connect <ip>`.
- **With a staging or private CA**, trust its root for the check only:
  `--ca-file staging-root.pem`. That flag replaces the public roots. A
  production check never passes it.
- **An ACME CA's staging directory** is the place for trial runs of §3.2 and
  §4.1: its rate limits are loose and its certificates are untrusted on purpose.
- **Without any domain**, `make test-tls-edge` proves the edge's behaviour in the
  real image with test-only certificates for `labs.jtt.test`. It issues nothing
  and contacts no CA.

## 7. Renewal failure

### 7.1 Confirm it is real

`npm run tls:check -- --origin https://<host> --cert-dir infrastructure/docker/nginx/tls`,
then note the finding codes and `notAfter`.

### 7.2 Diagnose

| Symptom | Cause | Fix |
|---|---|---|
| `REFUSED: … does not name <host>` | wrong certificate, or `PUBLIC_ORIGIN` changed | reissue for the host, or correct `PUBLIC_ORIGIN` |
| `REFUSED: … holds only the server certificate` | the leaf alone was installed | use the client's `fullchain.pem`, or append the intermediate |
| `REFUSED: … chain … does not verify` | intermediates out of order, wrong, or expired | rebuild `fullchain.pem` from the CA's current chain |
| `REFUSED: … does not belong to the server certificate` | the key from another issuance | install the key generated with this certificate |
| `REFUSED: … readable by group or others` | the key file mode | `chmod 600` the source key, then install again |
| `REFUSED: … not a readable, unencrypted private key` | an encrypted key | decrypt it into a 600 file: nginx has no passphrase |
| ACME challenge fails, CA reports 404 | wrong webroot path, or tokens written elsewhere | `-w <repo>/infrastructure/docker/nginx/acme-webroot` |
| ACME challenge fails, CA reports a redirect or connection error | port 80 blocked, DNS points elsewhere, or port 80 not served by this edge | `tls:check --expect-acme`, `dig`, the firewall |
| ACME client reports rate limiting | too many failed or duplicate orders | wait; test against staging first |
| `served_differs_from_installed` | files changed without a reload, or something else answers on 443 | `scripts/tls-install.sh` again with the same pair, or `docker compose ... exec web nginx -s reload` |
| `served_differs_from_installed`, and the reload **did** run | the pair was written in the same second as the pair it replaced, so nginx reused the certificate it had (see below) | `touch` both files, then reload again |

When nginx reconfigures it reuses a certificate it has already loaded unless
the file's modification time has moved, and it reads that time in whole seconds.
A pair written into the same second as the pair it replaces therefore looks
untouched: `nginx -s reload` exits 0, the master keeps the certificate it had,
and waiting does not help. `scripts/tls-install.sh` cannot end there quietly —
it proves the served certificate after reloading and rolls back if it is not the
new one (§4.3) — but a pair installed by hand or by a deploy hook that writes
the files itself can, and then only the health check says so. The remedy is
`touch tls/fullchain.pem tls/privkey.pem` and another reload; the certificates
themselves need no change. Proven in
`services/observability/test/tls-edge-integration.test.ts`.

### 7.3 The certificate has already expired

Browsers refuse the site now. Do **not** try to bypass the gate: production pins
`WEB_TLS=required`, and the TLS configuration cannot load without the gate.

1. **If the web container is still running**, port 80 still serves ACME tokens.
   Renew in webroot mode (§3.2), and the deploy hook installs the certificate.
2. **If the gate refused a restart**, the container does not stay stopped:
   production's `restart: unless-stopped` retries it about once a minute, and
   every attempt publishes port 80 again. Stop it first — `prod stop web` — then
   renew in standalone mode, run `tls-install.sh`, and `prod up -d web`.
3. **If no new certificate can be had quickly**, a still-valid `*.previous` pair
   can be reinstalled. Copy it out of the directory first, because
   `tls-install.sh` refuses to install from the live directory, into a private
   directory rather than the shared `/tmp`:
   ```bash
   install -d -m 0700 ~/tls-restore
   cp infrastructure/docker/nginx/tls/fullchain.pem.previous ~/tls-restore/fullchain.pem
   (umask 077 && cp infrastructure/docker/nginx/tls/privkey.pem.previous ~/tls-restore/privkey.pem)
   make tls-install CERT=~/tls-restore/fullchain.pem KEY=~/tls-restore/privkey.pem
   rm -r ~/tls-restore
   ```

### 7.4 Verify recovery

`tls:check` exits 0, the web container is `healthy`, and a browser shows the new
expiry date.

### 7.5 Escalate when

- the CA or ACME account is unavailable, or you have been rate-limited;
- DNS or the firewall for the domain is controlled by someone else;
- under 48 hours of validity remain and §7.2 has not resolved it.

## 8. Key compromise and rotation

Assume compromise if the key was ever committed, copied into an image, logged,
pasted into a ticket, or readable on a shared host.

1. Generate a **new** key: a new ACME order, or §3.1. Never reissue on the old
   key.
2. Install it with `tls-install.sh`.
3. Revoke the old certificate through the CA, giving *keyCompromise* as the reason.
4. Delete `privkey.pem.previous` and `fullchain.pem.previous`: they hold the
   compromised pair.
5. Find every other copy: the ACME client's own directories, backups, the
   operator's machine. Git history too, if it was ever committed. Rewriting
   history does not un-leak it; revocation is what counts.
6. Record the incident (RB-08).

## 9. Where the key lives, and where it must never be

**Lives:** `infrastructure/docker/nginx/tls/privkey.pem` (600), `privkey.pem.previous`,
the issuing client's own storage, and the operator's secret store (§10). It is
bind-mounted read-only into `web` and nowhere else.

**Never:** git (`.gitignore`), a Docker build context (`/.dockerignore`), an
image, the browser bundle, logs, metrics, health responses, `tls:check` or
`tls-install.sh` output. The contract and integration suites enforce each of
these (§11).

## 10. DECISION REQUIRED

| Decision | Why it is open |
|---|---|
| The CA and issuance method: ACME HTTP-01, ACME DNS-01, or a commercial CA | DNS-01 needs a DNS provider's API credentials, which means a DNS provider decision. None is approved |
| The ACME client and how it runs | a host package, a container, a systemd timer; each changes §3.2 and §4.1 |
| The production hostname | no hostname in the repository is approved |
| The scheduler for `tls:check`, and the alert destination | the exit code is the signal; nothing routes it yet |
| HSTS `includeSubDomains`/preload, CAA records, IPv6 | decisions about the whole domain |
| Key custody and backup | the key is not in any database backup ([postgres-backup-restore.md §1](postgres-backup-restore.md)) |
| A managed or multi-host edge (cloud load balancer, CDN, ingress with cert-manager) | part of the production substrate decision; this edge is one host's nginx |
| The host firewall | [runtime-architecture.md §11.7](../runtime-architecture.md) |

## 11. What proves it

| Suite | Command |
|---|---|
| `services/observability/test/tls-edge-contract.test.ts` | `npm test` |
| `services/observability/test/tls-certificate-health.test.ts` | `npm test` |
| `services/observability/test/tls-edge-integration.test.ts` | `make test-tls-edge` (Docker; CI job `tls-edge-integration`) |
| `scripts/check-secret-distribution.mjs` | `make secrets-check` |

Details are in [runtime-architecture.md §12.9](../runtime-architecture.md).
