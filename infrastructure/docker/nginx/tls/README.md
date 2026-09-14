# Web tier TLS

`docker-compose.production.yml` mounts this directory read-only at
`/etc/nginx/tls` in the `web` container, and into no other service. nginx
(`../web-tls.conf`) reads two files:

| File | Contents | Mode |
|---|---|---|
| `fullchain.pem` | the server certificate, then its intermediate certificate(s), in order | `644` |
| `privkey.pem` | the server certificate's private key, unencrypted, and nothing else | `600` (refused if readable by group or others) |

Everything in this directory except this file and `.gitignore` is ignored by
git and excluded from every Docker build context (`/.dockerignore`).
`scripts/tls-install.sh` also writes `*.next` (staged) and `*.previous` (the
pair it replaced, kept for rollback) here. `privkey.pem.previous` is a private
key as well.

## Fail closed

Before nginx starts, the web image's certificate gate (`jtt-tls-preflight`)
refuses to start the container unless:

- `PUBLIC_ORIGIN` is `https://<dns host name>`, with no port and no path;
- both files exist and the key is `600`;
- the certificate matches the key, is in date, names that host, is not a CA
  certificate, and is followed by intermediates that verify it;
- the key is RSA 2048 or larger, or EC P-256 or larger.

There is no plaintext fallback, and no certificate is served for any other name.

## Installing, renewing, checking

```bash
scripts/tls-install.sh --cert /path/to/fullchain.pem --key /path/to/privkey.pem
npm run tls:check -- --origin https://labs.example.com --cert-dir infrastructure/docker/nginx/tls
```

`tls-install.sh` validates the new pair inside the web image, keeps the old pair
as `*.previous`, swaps the files, reloads nginx, and confirms nginx serves the
new certificate. If any step fails, it restores the old pair.

Issuance, the renewal schedule, expiry monitoring and the procedure for a failed
renewal are in [`docs/runbooks/production-tls.md`](../../../../docs/runbooks/production-tls.md).
