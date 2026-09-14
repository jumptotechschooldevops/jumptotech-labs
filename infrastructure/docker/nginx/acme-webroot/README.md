# ACME HTTP-01 webroot

`docker-compose.production.yml` mounts this directory read-only at
`/var/www/acme` in the `web` container. On port 80, nginx (`../web-tls.conf`)
serves `/.well-known/acme-challenge/<token>` from it and redirects every other
request to HTTPS.

An ACME client running on the host in webroot mode writes its challenge tokens
to `./.well-known/acme-challenge/`. The CA then fetches them over
`http://<PUBLIC_ORIGIN host>/`. A token that does not exist returns 404.

Nothing here is secret: challenge tokens are public by design. Everything except
this file and `.gitignore` is ignored by git.

The webroot is only the mechanism. Which ACME CA and client to use, and whether
to use ACME at all, are still **DECISION REQUIRED**. See
[`docs/runbooks/production-tls.md`](../../../../docs/runbooks/production-tls.md).
