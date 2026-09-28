# Alertmanager secrets

`webhook-url` holds the URL Alertmanager posts alerts to, as a file with no
trailing newline. `alertmanager.yml` reads it through `webhook_configs.url_file`,
so the destination never appears in committed configuration, in `docker compose
config` output, or in this repository.

Where alerts go is **DECISION REQUIRED** — see
`docs/runbooks/private-beta-operations.md` §8. Until this file exists,
Alertmanager logs a failed notification for every alert group and the alerts are
visible only in Grafana and through `amtool`.

To install one, on the host:

```bash
umask 077
printf '%s' 'https://hooks.example.invalid/…' > infrastructure/observability/alertmanager/secrets/webhook-url
# Alertmanager runs as nobody (65534) and must be able to read it.
chmod 644 infrastructure/observability/alertmanager/secrets/webhook-url
docker compose … kill -s HUP alertmanager   # reload; see the runbook for the full command
```

## heartbeat-url

The check-in URL of an external "dead man's switch" service, in the same form
(no trailing newline, `0644`). The always-firing `Watchdog` alert is sent there
every five minutes and nowhere else (`alertmanager.yml`, first route); the
service tells a person when the check-ins stop — the host, Docker, Prometheus
or Alertmanager has died, which no other alert can report. Which service is
DECISION REQUIRED as well; see `docs/runbooks/RB-20-watchdog.md`.

```bash
umask 077
printf '%s' 'https://heartbeat.example.invalid/…' > infrastructure/observability/alertmanager/secrets/heartbeat-url
chmod 644 infrastructure/observability/alertmanager/secrets/heartbeat-url
docker compose … kill -s HUP alertmanager
```

Both files are mounted read-only into the `alertmanager` service only
(`infrastructure/secret-distribution.json` → `credentialMounts`).
