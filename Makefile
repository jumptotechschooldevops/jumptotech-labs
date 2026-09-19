.DEFAULT_GOAL := help
SHELL := /bin/bash

KUBECONFIG_HOST := $(CURDIR)/infrastructure/kind/generated/kubeconfig-host.yaml

# Which stack `up`, `down`, `logs` and `rebuild` drive.
#
# The base file is the Kubernetes track and no container runtime anywhere. The
# runtime overlay adds `sandboxd` — the only process given a Docker socket — and
# with it every remaining track — all 114 labs. That is the default because a
# stack that can only run a sixth of the catalogue is not the one anybody wants.
#
# The Docker track is in that overlay too: `sandboxd` brokers its
# `DockerEnginePort` as fourteen named operations, so the api needs no socket
# for it either.
COMPOSE := docker compose -f docker-compose.yml -f docker-compose.runtime.yml

.PHONY: help setup secrets secrets-check observability-token observability-up observability-down observability-check cluster-up cluster-down sandbox-build sandbox-clean status up up-kubernetes-only rebuild verify-api-image down logs test test-integration test-sandbox test-db test-terminal-container test-sandboxd-container db-up db-migrate db-status db-shell db-backup db-backup-verify test-db-backup db-restore-drill tls-install tls-check test-tls-edge beta-validate production-preflight production-config-check private-beta-smoke host-capacity-sample private-beta-diagnostics test-private-beta-diagnostics test-production-host typecheck check reset clean

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "\033[36m%-18s\033[0m %s\n", $$1, $$2}'

setup: ## First-time setup: .env + kind cluster
	@$(MAKE) secrets
	@# One runtime owner for the whole stack: the api and sandboxd read this same
	@# value, and compose refuses to start without it. Not a secret. An existing
	@# value is kept, so a worktree that chose its own owner keeps it.
	@if ! grep -qE "^RUNTIME_OWNER_ID=.+" .env; then \
		sed -i.bak "/^RUNTIME_OWNER_ID=$$/d" .env && rm -f .env.bak; \
		echo "RUNTIME_OWNER_ID=jumptotech" >> .env; \
		echo "added RUNTIME_OWNER_ID=jumptotech to your .env"; \
	fi
	@$(MAKE) observability-token
	@$(MAKE) cluster-up
	@$(MAKE) sandbox-build

# BETA-P0-010. Every secret is generated separately, and a placeholder copied
# from .env.example is replaced rather than kept — or, for a database password an
# existing volume may depend on, kept with a warning. Never prints a value.
secrets: ## Generate missing or placeholder secrets in .env (idempotent)
	@bash scripts/ensure-dev-secrets.sh

# Resolves the shipped compose files with sentinel values and proves each
# service receives exactly the secrets infrastructure/secret-distribution.json
# allows — and, since BETA-P0-011, which ports it publishes and which credential
# files it mounts. BETA-P0-012 adds the production stack (exactly 443 and 80),
# loopback-only publication everywhere else, and the private database network.
# Reads no .env and prints names only.
secrets-check: ## Prove secrets, mounts, published ports and private networks per stack, from `docker compose config`
	@node scripts/check-secret-distribution.mjs

# Prometheus runs as nobody (65534) and reads this file through a bind mount, so
# on a Linux host it must be readable by others and its directory traversable.
# It used to be 0600: owned by the operator, that left every scrape target down
# with "unable to read authorization credentials ... permission denied" on a
# Linux host, while Docker Desktop's file sharing hid it on every laptop. The
# alertmanager webhook-url file follows the same rule (its README). What keeps
# other local accounts out is the checkout directory's own mode — see
# docs/development/production-host-readiness.md §5.
observability-token: ## Write the scrape token where Prometheus reads it
	@mkdir -p infrastructure/observability/secrets
	@chmod 0711 infrastructure/observability/secrets
	@(umask 077; grep -E '^OBSERVABILITY_SCRAPE_TOKEN=' .env \
		| head -1 | cut -d= -f2- | tr -d '\n' \
		> infrastructure/observability/secrets/scrape-token)
	@chmod 0644 infrastructure/observability/secrets/scrape-token
	@echo "wrote infrastructure/observability/secrets/scrape-token (git-ignored)"

observability-up: ## Start the stack with Prometheus, Alertmanager and Grafana
	@$(MAKE) observability-token
	@$(COMPOSE) -f docker-compose.observability.yml --profile observability up -d --build
	@set -a; [ -f ./.env ] && . ./.env; set +a; \
		echo ""; \
		echo "  Grafana       http://127.0.0.1:$${GRAFANA_PORT:-3001}  (admin / GRAFANA_ADMIN_PASSWORD in .env)"; \
		echo "  Prometheus    http://127.0.0.1:$${PROMETHEUS_PORT:-9090}"; \
		echo "  Alertmanager  http://127.0.0.1:$${ALERTMANAGER_PORT:-9093}"; \
		echo ""

observability-down: ## Stop the observability stack, leaving the platform running
	@$(COMPOSE) -f docker-compose.observability.yml --profile observability rm -sf prometheus alertmanager grafana

observability-check: ## Validate rules and dashboards without starting anything
	@bash scripts/check-observability.sh

cluster-up: ## Create the local kind cluster
	@bash scripts/cluster-up.sh

cluster-down: ## Delete the local kind cluster
	@bash scripts/cluster-down.sh

sandbox-build: ## Build the Linux/Terraform sandbox images
	@bash scripts/sandbox-build.sh

sandbox-clean: ## Remove this runtime owner's sandbox containers and networks (RUNTIME_OWNER_ID; refused on a production checkout)
	@bash scripts/refuse-on-production.sh sandbox-clean "every running lab's sandbox, without ending its session"
	@bash scripts/sandbox-clean.sh

status: ## Health report for cluster + services
	@bash scripts/cluster-status.sh

up: ## Start the application: every track, all 114 labs
	@$(COMPOSE) up --build

up-kubernetes-only: ## Start with no container runtime anywhere (Kubernetes track only)
	@docker compose up --build

rebuild: ## Rebuild and restart the compose stack (required after platform source changes)
	@$(COMPOSE) up --build -d

verify-api-image: ## Confirm the running API container has current composition wiring
	@bash scripts/verify-api-image-composition.sh

down: ## Stop the application
	@$(COMPOSE) down

logs: ## Tail service logs
	@$(COMPOSE) logs -f

test: ## Run unit tests
	@npm test

test-integration: ## Run tests against the real kind cluster
	@RUN_INTEGRATION_TESTS=1 KUBECONFIG="$(KUBECONFIG_HOST)" \
		npx vitest run test/integration.test.ts --root services/lab-orchestrator

test-sandbox: ## Run tests against real Linux/Terraform sandbox containers
	@RUN_INTEGRATION_TESTS=1 npx vitest run test/sandbox-integration.test.ts --root apps/api

# --- database (PLATFORM-005) ------------------------------------------------

db-up: ## Start PostgreSQL only
	@docker compose up -d postgres

db-migrate: ## Apply pending migrations (forward-only, never destructive)
	@set -a; . ./.env; set +a; \
		DATABASE_URL="$${DATABASE_URL:-postgresql://$${POSTGRES_USER:-jumptotech}:$${POSTGRES_PASSWORD}@localhost:$${POSTGRES_PORT:-5432}/$${POSTGRES_DB:-jumptotech_labs}}" \
		npm run db:migrate

db-status: ## Show which migrations are applied and which are pending
	@set -a; . ./.env; set +a; \
		DATABASE_URL="$${DATABASE_URL:-postgresql://$${POSTGRES_USER:-jumptotech}:$${POSTGRES_PASSWORD}@localhost:$${POSTGRES_PORT:-5432}/$${POSTGRES_DB:-jumptotech_labs}}" \
		npm run db:status

db-shell: ## Open psql against the development database
	@docker compose exec postgres sh -c 'psql -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"'

# --- backup and restore (BETA-P0-013) ----------------------------------------
#
# docs/runbooks/postgres-backup-restore.md. Every client command runs inside the
# postgres container over its local socket, so no password is read or passed.
# There is deliberately no `db-restore` target: a restore is typed out, with its
# mode and its confirmation (scripts/db-restore.sh --help).

db-backup: ## Back up the database: custom-format archive + checksum in BACKUP_DIR (default backups/postgres)
	@bash scripts/db-backup.sh

db-backup-verify: ## Check a backup's checksum and readability, changing nothing (FILE=path)
	@test -n "$(FILE)" || { echo "usage: make db-backup-verify FILE=backups/postgres/<archive>.dump" >&2; exit 2; }
	@bash scripts/db-restore.sh --verify-only "$(FILE)"

test-db-backup: ## Prove the backup/restore scripts' refusals and failure paths (no daemon needed)
	@bash scripts/test-db-backup-restore.sh

# --- private beta release gate (BETA-P0-019) ----------------------------------
#
# docs/runbooks/five-student-beta-validation.md. Five synthetic students at once
# against the stack this checkout is running: real sessions, real PTYs, real
# verifier, capacity, isolation, reset, soak, api restart, cleanup. Not CI: it
# needs the running stack, kind and the observability profile. Reads the ports,
# owner and cluster from .env; ARGS passes extra flags (--soak-seconds 60).
beta-validate: ## Five concurrent synthetic students against the running local stack — private-beta release gate (~30 min)
	@set -a; [ -f ./.env ] && . ./.env; set +a; \
		npm run --silent beta:validate -- \
			--api "http://127.0.0.1:$${API_PORT:-4000}" \
			--terminal "ws://127.0.0.1:$${TERMINAL_PORT:-4001}" \
			--origin "http://127.0.0.1:$${WEB_PORT:-3000}" \
			--metrics "http://127.0.0.1:$${API_OBSERVABILITY_PORT:-9400}" \
			--terminal-metrics "http://127.0.0.1:$${TERMINAL_OBSERVABILITY_PORT:-9401}" \
			--compose-project "$${COMPOSE_PROJECT_NAME:-jumptotech-labs}" \
			--runtime-owner "$${RUNTIME_OWNER_ID:?set RUNTIME_OWNER_ID in .env}" \
			--kubeconfig "$(CURDIR)/infrastructure/kind/generated/kubeconfig-host-$${LAB_CLUSTER_NAME:-jumptotech-labs}.yaml" \
			$(ARGS)

# --- public TLS edge (BETA-P0-017) --------------------------------------------
#
# docs/runbooks/production-tls.md. No target issues a certificate: which CA and
# which ACME client are still open decisions. These install one, check one, and
# prove the edge's behaviour with test-only certificates.

tls-install: ## Validate, install and hot-reload the production edge's certificate (CERT=fullchain.pem KEY=privkey.pem)
	@test -n "$(CERT)" && test -n "$(KEY)" || { echo "usage: make tls-install CERT=/path/fullchain.pem KEY=/path/privkey.pem" >&2; exit 2; }
	@bash scripts/tls-install.sh --cert "$(CERT)" --key "$(KEY)"

tls-check: ## Check the TLS edge and certificate expiry; exit 0/1/2 (ARGS="--origin https://host --cert-dir infrastructure/docker/nginx/tls")
	@npm run --silent tls:check -- $(ARGS)

test-tls-edge: ## Prove the TLS edge in the real web image: gate, redirect, WebSocket, renewal (needs Docker)
	@RUN_INTEGRATION_TESTS=1 npx vitest run test/tls-edge-integration.test.ts --root services/observability \
		--testTimeout=300000 --hookTimeout=900000

# --- production host readiness -------------------------------------------------
#
# docs/development/production-host-readiness.md. Run on the production host, from
# the checkout. None of these starts, stops or changes anything; each prints
# PASS / FAIL / WARN / INFO / MANUAL CHECK REQUIRED and never a secret value.

production-preflight: ## Can this host run the production stack as proven? Before `prod up` (ARGS="--backup-dir DIR --report FILE")
	@bash scripts/production-preflight.sh $(ARGS)

production-config-check: ## Resolve the production compose files with .env and run the real service config gates (ARGS="--print-network-env")
	@npm run --silent production:config-check -- $(ARGS)

private-beta-smoke: ## Is the running production stack serving the beta as proven? Evidence file (ARGS="--public-ip IP --report-dir DIR")
	@bash scripts/private-beta-smoke.sh $(ARGS)

host-capacity-sample: ## Record host CPU/memory/disk/containers/pods while students work (ARGS="--out-dir DIR --duration 3600")
	@bash scripts/host-capacity-sample.sh $(ARGS)

private-beta-diagnostics: ## After an incident: one sanitized support bundle, no secrets or student data (ARGS="--since 2h --out-dir DIR")
	@bash scripts/private-beta-diagnostics.sh $(ARGS)

test-private-beta-diagnostics: ## Prove the support bundle holds no secret or student data and runs only read-only verbs (no daemon)
	@bash scripts/test-private-beta-diagnostics.sh

test-production-host: ## Prove the production-host scripts and the production config gates fail closed (no daemon for the scripts)
	@bash scripts/test-production-host-scripts.sh
	@npm run --silent production:config-check -- --self-test

db-restore-drill: ## Back up, destroy, restore and verify against disposable PostgreSQL servers (needs Docker)
	@bash scripts/db-restore-drill.sh

test-terminal-container: ## Run the terminal integration suite inside a container (real PTY)
	@echo "==> building the terminal test image (same base + native build as the shipped image)"
	@docker build -q -f infrastructure/docker/terminal-test.Dockerfile -t jumptotech/terminal-test . >/dev/null
	@echo "==> refreshing the kind kubeconfigs"
	@kind get kubeconfig --name $${LAB_CLUSTER_NAME:-jumptotech-labs} \
		> infrastructure/kind/generated/kubeconfig-host.yaml
	@kind get kubeconfig --name $${LAB_CLUSTER_NAME:-jumptotech-labs} --internal \
		> infrastructure/kind/generated/kubeconfig-internal.yaml
	@docker run --rm --network kind \
		-e RUN_INTEGRATION_TESTS=1 \
		-e KUBECONFIG=/app/infrastructure/kind/generated/kubeconfig-internal.yaml \
		-e RUNTIME_OWNER_ID="$${RUNTIME_OWNER_ID:-terminal-container}" \
		-e JTT_TEST_RUN_ID="$${JTT_TEST_RUN_ID:-tc$$$$}" \
		-v "$(CURDIR)/services:/app/services" \
		-v "$(CURDIR)/apps:/app/apps" \
		-v "$(CURDIR)/labs:/app/labs" \
		-v "$(CURDIR)/test-support:/app/test-support" \
		-v "$(CURDIR)/infrastructure:/app/infrastructure" \
		jumptotech/terminal-test \
		npx tsx test-support/strict-vitest.ts test/terminal-integration.test.ts --root services/terminal

# The Linux sandbox image the suite creates its containers from. Built here from
# the canonical Dockerfile rather than assumed: a fresh runner has no
# `jumptotech/lab-linux:latest`, and the registry has none to pull. A private
# tag, because `:latest` is an operator-controlled artifact that tests must not
# overwrite (docs/runtime-ownership.md → Image-tag policy).
SANDBOXD_TEST_LINUX_IMAGE := jumptotech/lab-linux:sandboxd-test

test-sandboxd-container: ## Run the sandboxd suite against a real daemon and real PTYs (in a container)
	@echo "==> building the test image (same base + native build as the shipped images)"
	@docker build -q -f infrastructure/docker/terminal-test.Dockerfile -t jumptotech/terminal-test . >/dev/null
	@echo "==> building the Linux sandbox image $(SANDBOXD_TEST_LINUX_IMAGE)"
	@docker build -q -f infrastructure/docker/sandbox-linux.Dockerfile -t $(SANDBOXD_TEST_LINUX_IMAGE) . >/dev/null
	@echo "==> running sandboxd against the host daemon (real containers, real shells)"
	@docker run --rm \
		-e RUN_INTEGRATION_TESTS=1 \
		-e JTT_TEST_RUN_ID="$${JTT_TEST_RUN_ID:-sbx$$$$}" \
		-e LINUX_SANDBOX_IMAGE=$(SANDBOXD_TEST_LINUX_IMAGE) \
		-v /var/run/docker.sock:/var/run/docker.sock \
		-v "$(CURDIR)/services:/app/services" \
		-v "$(CURDIR)/apps:/app/apps" \
		-v "$(CURDIR)/labs:/app/labs" \
		-v "$(CURDIR)/test-support:/app/test-support" \
		-v "$(CURDIR)/infrastructure:/app/infrastructure" \
		jumptotech/terminal-test \
		npx tsx test-support/strict-vitest.ts test/sandboxd-integration.test.ts --root services/sandboxd \
			--testTimeout=300000 --hookTimeout=300000

test-db: ## Run the persistence suites against a throwaway PostgreSQL
	@docker rm -f jumptotech-labs-test-db >/dev/null 2>&1 || true
	@docker run --rm -d --name jumptotech-labs-test-db \
		-e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=jumptotech_labs_test \
		-p 127.0.0.1:$${TEST_DB_PORT:-55432}:5432 postgres:16-alpine >/dev/null
	@# Not `pg_isready`: that probes the server's unix socket from inside the
	@# container and is satisfied by the temporary postmaster the official image
	@# runs `initdb` against, while a query from the host still gets
	@# ECONNRESET. The gate has to perform the operation it is gating — see
	@# scripts/wait-for-postgres.mjs.
	@node scripts/wait-for-postgres.mjs \
		postgresql://test:test@localhost:$${TEST_DB_PORT:-55432}/jumptotech_labs_test 90 \
		|| { docker logs --tail 40 jumptotech-labs-test-db; \
		     docker rm -f jumptotech-labs-test-db >/dev/null; exit 1; }
	@RUN_DB_TESTS=1 \
		TEST_DATABASE_URL=postgresql://test:test@localhost:$${TEST_DB_PORT:-55432}/jumptotech_labs_test \
		npm run test:db; \
		status=$$?; docker rm -f jumptotech-labs-test-db >/dev/null; exit $$status

typecheck: ## Typecheck every workspace
	@npm run typecheck

check: ## Call the verifier for K8S-001
	@curl -s -X POST localhost:4000/api/labs/K8S-001/check | python3 -m json.tool

reset: ## Reset the K8S-001 lab environment
	@curl -s -X POST localhost:4000/api/labs/K8S-001/reset | python3 -m json.tool

clean: ## Tear down everything (containers + cluster + STUDENT PROGRESS; refused on a production checkout)
	@bash scripts/refuse-on-production.sh clean "the PostgreSQL volume (every student's progress) and the kind cluster"
	@echo "This removes the postgres volume: every student's saved progress goes with it."
	@echo "Back it up first if it matters: make db-backup. backups/ is not removed."
	@docker compose down -v --remove-orphans
	@bash scripts/cluster-down.sh
