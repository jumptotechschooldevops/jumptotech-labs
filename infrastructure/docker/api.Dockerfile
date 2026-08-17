# syntax=docker/dockerfile:1
#
# JumpToTech Labs — REST API.
# Runs as the non-root `node` user. No Docker socket, no host mounts other
# than a read-only kubeconfig and the read-only labs/ directory.

FROM node:22-bookworm-slim

ARG KUBECTL_VERSION=v1.34.2

# kubectl is installed for the provider's `kubectl works?` health check only.
# Student commands never run in this container.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
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

WORKDIR /app

# Dependency layer — cached until a manifest changes.
COPY package.json package-lock.json ./
COPY apps/api/package.json        apps/api/package.json
COPY apps/web/package.json        apps/web/package.json
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
