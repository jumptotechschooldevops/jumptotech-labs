.DEFAULT_GOAL := help
SHELL := /bin/bash

KUBECONFIG_HOST := $(CURDIR)/infrastructure/kind/generated/kubeconfig-host.yaml

.PHONY: help setup cluster-up cluster-down sandbox-build sandbox-clean status up down logs test test-integration test-sandbox typecheck check reset clean

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "\033[36m%-18s\033[0m %s\n", $$1, $$2}'

setup: ## First-time setup: .env + kind cluster
	@test -f .env || (cp .env.example .env && \
		sed -i.bak "s|^TERMINAL_SESSION_SECRET=.*|TERMINAL_SESSION_SECRET=$$(openssl rand -hex 32)|" .env && \
		rm -f .env.bak && echo "created .env with a generated secret")
	@$(MAKE) cluster-up
	@$(MAKE) sandbox-build

cluster-up: ## Create the local kind cluster
	@bash scripts/cluster-up.sh

cluster-down: ## Delete the local kind cluster
	@bash scripts/cluster-down.sh

sandbox-build: ## Build the Linux/Terraform sandbox images
	@bash scripts/sandbox-build.sh

sandbox-clean: ## Remove every sandbox container this platform owns
	@docker ps -aq --filter label=jumptotech.io/managed=true | xargs -r docker rm -f

status: ## Health report for cluster + services
	@bash scripts/cluster-status.sh

up: ## Start the application (http://localhost:3000)
	@docker compose up --build

down: ## Stop the application
	@docker compose down

logs: ## Tail service logs
	@docker compose logs -f

test: ## Run unit tests
	@npm test

test-integration: ## Run tests against the real kind cluster
	@RUN_INTEGRATION_TESTS=1 KUBECONFIG="$(KUBECONFIG_HOST)" \
		npx vitest run test/integration.test.ts --root services/lab-orchestrator

test-sandbox: ## Run tests against real Linux/Terraform sandbox containers
	@RUN_INTEGRATION_TESTS=1 npx vitest run test/sandbox-integration.test.ts --root apps/api

typecheck: ## Typecheck every workspace
	@npm run typecheck

check: ## Call the verifier for K8S-001
	@curl -s -X POST localhost:4000/api/labs/K8S-001/check | python3 -m json.tool

reset: ## Reset the K8S-001 lab environment
	@curl -s -X POST localhost:4000/api/labs/K8S-001/reset | python3 -m json.tool

clean: ## Tear down everything (containers + cluster)
	@docker compose down -v --remove-orphans
	@bash scripts/cluster-down.sh
