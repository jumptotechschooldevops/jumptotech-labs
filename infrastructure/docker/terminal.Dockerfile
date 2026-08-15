# syntax=docker/dockerfile:1
#
# JumpToTech Labs — terminal gateway.
#
# This is the only container that runs a shell. It therefore gets the
# tightest treatment: a dedicated unprivileged `student` user, no Docker
# socket, no host mounts except a read-only kubeconfig, and no source for any
# other service.

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
COPY services/terminal/package.json         services/terminal/package.json
COPY services/verifier/package.json         services/verifier/package.json

# Lifecycle scripts run here on purpose: node-pty is compiled in this stage.
RUN npm ci --omit=dev --workspace @jumptotech/terminal --include-workspace-root \
 && npm cache clean --force \
 && node -e "require('node-pty'); console.log('node-pty built OK')"

# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim

ARG KUBECTL_VERSION=v1.34.2

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl less vim-tiny jq; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) karch=amd64 ;; \
      arm64) karch=arm64 ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${karch}/kubectl"; \
    chmod 0755 /usr/local/bin/kubectl; \
    kubectl version --client=true --output=yaml >/dev/null; \
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
    TERMINAL_WORKDIR=/home/student

USER student
WORKDIR /home/student
EXPOSE 4001

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TERMINAL_PORT||4001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/node_modules/.bin/tsx", "/app/services/terminal/src/index.ts"]
