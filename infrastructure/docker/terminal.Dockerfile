# syntax=docker/dockerfile:1
#
# JumpToTech Labs — terminal gateway.
#
# This is the only container that runs a shell. It therefore gets the
# tightest treatment: a dedicated unprivileged `student` user, no Docker
# socket, no host mounts, and no source for any other service.
#
# It carries the `docker` CLI because Docker-track students type `docker`
# commands — but it carries no way to reach the host daemon. There is no socket
# mounted and no DOCKER_HOST in the image; each PTY is given `DOCKER_HOST`,
# `DOCKER_TLS_VERIFY`, and a `DOCKER_CERT_PATH` pointing at a certificate valid
# for exactly one session's sandbox, fetched per session and deleted with the
# shell. Pointing the CLI anywhere else fails TLS verification.

FROM node:22-bookworm-slim AS build

# node-pty is a native addon and must be compiled.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json        apps/api/package.json
COPY apps/web/package.json        apps/web/package.json
COPY services/lab-orchestrator/package.json services/lab-orchestrator/package.json
COPY services/progress/package.json         services/progress/package.json
COPY services/terminal/package.json         services/terminal/package.json
COPY services/verifier/package.json         services/verifier/package.json

# Lifecycle scripts run here on purpose: node-pty is compiled in this stage.
RUN npm ci --omit=dev --workspace @jumptotech/terminal --include-workspace-root \
 && npm cache clean --force \
 && node -e "require('node-pty'); console.log('node-pty built OK')"

# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim

ARG KUBECTL_VERSION=v1.34.2
ARG DOCKER_CLI_VERSION=27.3.1
ARG DOCKER_COMPOSE_VERSION=v2.33.0

# The Compose plugin is installed because it runs *client-side*: `docker compose
# up` reads the student's compose.yaml out of this container's workspace and
# talks to their sandbox daemon over TLS. DOCKER-008 depends on it being here,
# not in the sandbox image.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl less vim-tiny jq; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) karch=amd64; darch=x86_64 ;; \
      arm64) karch=arm64; darch=aarch64 ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${karch}/kubectl"; \
    chmod 0755 /usr/local/bin/kubectl; \
    kubectl version --client=true --output=yaml >/dev/null; \
    curl -fsSLo /tmp/docker.tgz \
      "https://download.docker.com/linux/static/stable/${darch}/docker-${DOCKER_CLI_VERSION}.tgz"; \
    tar -xzf /tmp/docker.tgz -C /tmp docker/docker; \
    install -m 0755 /tmp/docker/docker /usr/local/bin/docker; \
    rm -rf /tmp/docker.tgz /tmp/docker; \
    install -d -m 0755 /usr/local/libexec/docker/cli-plugins; \
    curl -fsSLo /usr/local/libexec/docker/cli-plugins/docker-compose \
      "https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-linux-${darch}"; \
    chmod 0755 /usr/local/libexec/docker/cli-plugins/docker-compose; \
    docker --version; \
    docker compose version; \
    apt-get purge -y --auto-remove curl; \
    rm -rf /var/lib/apt/lists/*

# Dedicated shell user, distinct from `node`, with its own writable HOME.
RUN useradd --create-home --home-dir /home/student --shell /bin/bash --uid 1001 student

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY services/lab-orchestrator services/lab-orchestrator
COPY services/terminal        services/terminal

# The service process and the PTYs it spawns share this user. It owns nothing
# in /app, so a student cannot modify the service that is hosting them.
RUN chown -R root:root /app && chmod -R a-w /app

ENV HOME=/home/student \
    NODE_ENV=production \
    TERMINAL_PORT=4001 \
    TERMINAL_WORKDIR=/home/student \
    TERMINAL_WORKSPACE_ROOT=/home/student/workspaces

USER student
WORKDIR /home/student
EXPOSE 4001

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TERMINAL_PORT||4001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/node_modules/.bin/tsx", "/app/services/terminal/src/index.ts"]
