# Observability secrets

`scrape-token` holds the value of `OBSERVABILITY_SCRAPE_TOKEN`, as a file with
no trailing newline. Prometheus reads it through `authorization.credentials_file`.

It is a *file* rather than a value in `prometheus.yml` for one reason: a
credential written into a config file ends up in git, in `docker compose config`
output, and in every screenshot of a terminal someone pastes into a ticket.

`make setup` writes it (`make observability-token` rewrites it from `.env`). To
regenerate by hand:

```bash
printf '%s' "$OBSERVABILITY_SCRAPE_TOKEN" > infrastructure/observability/secrets/scrape-token
# Prometheus runs as nobody (65534) and must be able to read it.
chmod 0644 infrastructure/observability/secrets/scrape-token
chmod 0711 infrastructure/observability/secrets
```

**Not `0600`.** On a Linux host the bind mount keeps host ownership, so a
`0600` file owned by the operator is unreadable inside the container: every
scrape fails with `unable to read authorization credentials ... permission
denied` and every target is down. Docker Desktop's file sharing hides this, so
it is invisible on a laptop. Keep other local accounts out with the checkout
directory's mode instead (`docs/development/production-host-readiness.md` §5);
`scripts/production-preflight.sh` checks both.

The token grants **read access to `/metrics` and nothing else**. It is refused
at startup if it equals any other secret the platform holds — see
`assertScrapeTokenIsDistinct`.
