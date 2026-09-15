# RB-15 — TLS edge and certificate

**Alerts:** `TlsCertificateExpiresWithin7Days` (critical), `TlsEdgeUnhealthy`
(critical), `TlsCertificateRenewalDue` (warning), `TlsHttpRedirectBroken`
(warning), `TlsEdgeCheckNotRunning` (warning)
**Source:** the API runs BETA-P0-017's own checks (`probeHttpsEndpoint`,
`probeHttpRedirect`) against `web:8443` and `web:8080` every five minutes.
**Blast radius:** an expired or untrusted certificate locks every student out;
browsers do not let them click through HSTS.

Commands use `prod` and `q` from [private-beta-operations.md §1](private-beta-operations.md).
The certificate lifecycle itself is [production-tls.md](production-tls.md).

## 1. Confirm it is real

```bash
q 'jtt_tls_check_status'                          # 0 ok, 1 warning, 2 critical
q 'jtt_tls_check_findings'                        # the finding codes
q 'jtt:tls_certificate_expiry:seconds / 86400'    # days left
npm run --silent tls:check -- --origin "$PUBLIC_ORIGIN" --cert-dir infrastructure/docker/nginx/tls
```

`tls:check` prints the full message for every code and also compares the served
certificate with the installed files, which the in-host check does not. Run it
from another machine too (without `--cert-dir`) to see DNS and the firewall.

## 2. Scope it — the finding code names the cause

| code | Meaning | Section |
|---|---|---|
| `renewal_due` | Under 21 days | 5a |
| `expires_soon`, `served_expired` | Under 7 days, or expired | 5a, then [production-tls.md §8](production-tls.md) |
| `served_untrusted` | Chain does not reach a public root: missing intermediate, or a staging certificate | 5b |
| `served_hostname_mismatch` | The certificate does not name `PUBLIC_ORIGIN`'s host | 5b |
| `connection_refused`, `timeout`, `handshake_failed` | nginx is not serving TLS on 8443 | 5c |
| `legacy_protocol`, `hsts_missing` | Configuration regression in the web image | 5c |
| `unexpected_status` | TLS is fine; `GET /` answered 5xx | RB-01 |
| `http_redirect_wrong_target`, `http_serves_plaintext`, `http_port_closed` | Port 80 | 5d |
| `check_failed` | The API could not run the check at all | 5e |

`TlsEdgeCheckNotRunning`: no check has completed for 20 minutes — 5e.

## 3. Immediate mitigation

A valid certificate is the only mitigation. If a renewed pair exists:

```bash
make tls-install CERT=/path/fullchain.pem KEY=/path/privkey.pem
```

It validates in the container, swaps, reloads nginx and proves the served
fingerprint, rolling back on failure. If none exists and the certificate has
expired, tell the cohort (§3 of the operations runbook) while issuing one.

## 4. Diagnose

1. `prod ps web` — `healthy` means the served certificate is the installed one
   and in date (P0-017 §5.2).
2. `prod logs --since 1h web | tail -50` — the startup gate names why it refused.
3. `prod logs --since 1h api | grep '"event":"ops.tls_edge.checked"'` — status
   changes and codes, as the API saw them.
4. `openssl x509 -in infrastructure/docker/nginx/tls/fullchain.pem -noout -enddate -subject -ext subjectAltName`.

## 5. Fix

- **5a Renewal.** Issue a new certificate ([production-tls.md §4](production-tls.md)),
  then `make tls-install`. The CA and ACME client are DECISION REQUIRED, so this
  is a manual step today.
- **5b Wrong certificate.** `fullchain.pem` must be the leaf followed by its
  intermediates, for exactly `PUBLIC_ORIGIN`'s host. Reinstall with `make tls-install`.
- **5c Edge not serving.** `prod restart web`. If the gate keeps refusing, fix
  what it names; do not bypass `WEB_TLS=required`.
- **5d Port 80.** `web-tls.conf` answers 80 with a redirect and ACME tokens only.
  A closed 80 is usually a host firewall; an unexpected answer is something else
  bound to 80.
- **5e The check.** `ready api 9400`; the API needs `PUBLIC_ORIGIN` (pinned in
  production) and must resolve `web`. `EDGE_PROBE_ENABLED=false` in `.env` turns
  it off — do not, except to stop a misbehaving check while you fix it.

## 6. Verify recovery

- `npm run tls:check` exits 0, from the host and from outside.
- Within five minutes, `q 'jtt_tls_check_status'` is 0 for both checks and
  `q 'jtt:tls_certificate_expiry:seconds / 86400'` shows the new date.
- A student can load the site.

## 7. What this does NOT mean

- **`TlsEdgeCheckNotRunning` is not the edge being down.** It is the check
  being silent; look at the API.
- **Not DNS.** The in-host check connects to the container. A student who cannot
  resolve the host while this is green is DNS or the firewall — the external
  `tls:check`.

## 8. Escalate when

Under 48 hours to expiry with no certificate available, or any sign the private
key has been exposed ([production-tls.md §9](production-tls.md)).

## 9. Follow-up

Record when the certificate was renewed and how. Automating renewal needs the
CA and ACME client decision (P0-017 §10).
