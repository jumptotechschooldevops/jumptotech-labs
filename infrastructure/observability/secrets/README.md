# Observability secrets

`scrape-token` holds the value of `OBSERVABILITY_SCRAPE_TOKEN`, as a file with
no trailing newline. Prometheus reads it through `authorization.credentials_file`.

It is a *file* rather than a value in `prometheus.yml` for one reason: a
credential written into a config file ends up in git, in `docker compose config`
output, and in every screenshot of a terminal someone pastes into a ticket.

`make setup` writes it. To regenerate:

```bash
printf '%s' "$OBSERVABILITY_SCRAPE_TOKEN" > infrastructure/observability/secrets/scrape-token
chmod 600 infrastructure/observability/secrets/scrape-token
```

The token grants **read access to `/metrics` and nothing else**. It is refused
at startup if it equals any other secret the platform holds — see
`assertScrapeTokenIsDistinct`.
