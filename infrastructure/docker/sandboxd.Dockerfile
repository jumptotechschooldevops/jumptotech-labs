# syntax=docker/dockerfile:1
#
# JumpToTech Labs — sandboxd, the runtime broker.
#
# This is the only image in the platform that is *meant* to reach a container
# runtime, and the whole point of it existing is that no other one has to.
#
#   api       creates and destroys sandboxes on the runtime this service shares
#   terminal  runs student PTYs — and holds NO runtime access at all
#   sandboxd  the single process that runs `docker exec` into a sandbox
#
# It carries the `docker` CLI and node-pty and nothing else. There is no HTTP
# surface beyond `/health` and one WebSocket, no student input path that is not
# a byte stream into an already-authorised PTY, and no port published to the
# host in the compose stack — it is reachable only from the internal network.
#
# Deployment note, stated here because it is a property of the image rather than
# of the file that runs it: this process has real privilege over its runtime.
# Deploy it on a runtime node that is not the machine serving the web tier, so
# that the privilege is bounded by that node.

FROM node:22-bookworm-slim AS build

# node-pty is a native addon and must be compiled.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json        apps/api/package.json
COPY apps/web/package.json        apps/web/package.json
COPY services/observability/package.json    services/observability/package.json
COPY services/lab-orchestrator/package.json services/lab-orchestrator/package.json
COPY services/progress/package.json         services/progress/package.json
COPY services/sandboxd/package.json         services/sandboxd/package.json
COPY services/terminal/package.json         services/terminal/package.json
COPY services/verifier/package.json         services/verifier/package.json

RUN npm ci --omit=dev --workspace @jumptotech/sandboxd --include-workspace-root \
 && npm cache clean --force \
 && node -e "require('node-pty'); console.log('node-pty built OK')"

# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim

ARG DOCKER_CLI_VERSION=27.3.1

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) darch=x86_64 ;; \
      arm64) darch=aarch64 ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/docker.tgz \
      "https://download.docker.com/linux/static/stable/${darch}/docker-${DOCKER_CLI_VERSION}.tgz"; \
    tar -xzf /tmp/docker.tgz -C /tmp docker/docker; \
    install -m 0755 /tmp/docker/docker /usr/local/bin/docker; \
    rm -rf /tmp/docker.tgz /tmp/docker; \
    docker --version; \
    apt-get purge -y --auto-remove curl; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY services/observability services/observability
COPY services/lab-orchestrator services/lab-orchestrator
COPY services/sandboxd        services/sandboxd

# The broker owns nothing it runs on: a bug in it cannot rewrite its own source.
RUN chown -R root:root /app && chmod -R a-w /app

ENV HOME=/tmp \
    NODE_ENV=production \
    SANDBOXD_PORT=4002 \
    SANDBOXD_BIND=0.0.0.0

USER node
EXPOSE 4002

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SANDBOXD_PORT||4002)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/node_modules/.bin/tsx", "/app/services/sandboxd/src/index.ts"]
