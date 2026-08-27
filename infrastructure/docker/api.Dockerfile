# syntax=docker/dockerfile:1
#
# JumpToTech Labs — REST API.
#
# Runs as the non-root `node` user. Host mounts: a read-only kubeconfig, the
# read-only labs/ directory, and — when the Docker track is enabled — the host
# Docker socket.
#
# The socket is the one significant privilege in this image, and it is here
# rather than in the terminal service on purpose: this container has no shell,
# no PTY, and no path by which a student's input reaches a command line. It uses
# the socket to create and destroy per-session sandbox containers, so that the
# socket itself never has to be exposed to anything a student can reach. See
# README → Docker sandbox security.

FROM node:22-bookworm-slim

ARG KUBECTL_VERSION=v1.34.2
ARG DOCKER_CLI_VERSION=27.3.1

# Two CLIs, both used only by the platform's own provisioning and health checks.
# Student commands never run in this container.
#
#   kubectl — the Kubernetes provider's `kubectl works?` check.
#   docker  — the Docker provider's entire interface to the host daemon, and to
#             each session's daemon via `docker exec <sandbox> docker …`. Every
#             invocation is execFile with an explicit argv array and no shell.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
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
    docker --version; \
    apt-get purge -y --auto-remove curl; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependency layer — cached until a manifest changes.
COPY package.json package-lock.json ./
COPY apps/api/package.json        apps/api/package.json
COPY apps/web/package.json        apps/web/package.json
COPY services/observability/package.json    services/observability/package.json
COPY services/lab-orchestrator/package.json services/lab-orchestrator/package.json
COPY services/progress/package.json         services/progress/package.json
COPY services/terminal/package.json         services/terminal/package.json
COPY services/verifier/package.json         services/verifier/package.json

# `--ignore-scripts`: the api needs no native addons, and skipping lifecycle
# scripts keeps the terminal service's node-pty from being compiled here (it
# would need a toolchain this image deliberately does not carry).
RUN npm ci --omit=dev --workspace @jumptotech/api --include-workspace-root --ignore-scripts \
 && npm cache clean --force

COPY tsconfig.base.json ./
COPY services/observability services/observability
COPY services/lab-orchestrator services/lab-orchestrator
COPY services/verifier        services/verifier
# Carries `migrations/` with it, so the image knows its own schema and the
# running container can apply it without fetching anything.
COPY services/progress        services/progress
COPY apps/api                 apps/api

# HOME must be writable for the non-root user; nothing else is.
ENV HOME=/tmp \
    NODE_ENV=production \
    API_PORT=4000

USER node
EXPOSE 4000

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "apps/api/src/index.ts"]
