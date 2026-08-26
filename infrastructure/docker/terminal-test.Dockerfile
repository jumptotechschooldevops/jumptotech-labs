# syntax=docker/dockerfile:1
#
# JumpToTech Labs — the terminal service's integration suite, in a container.
#
# ## Why this image exists
#
# `services/terminal/test/terminal-integration.test.ts` is the only suite that
# exercises the whole shell chain — WebSocket handshake, token verification,
# credential exchange, a real PTY — and it needs `node-pty`, a native addon
# that does not build against every host toolchain. On a macOS host it probes
# `pty.spawn`, fails, and skips itself with an explanatory message. Skipping is
# honest, but it leaves the one chain that unit tests cannot prove unproven.
#
# The production terminal image cannot run the suite: it installs with
# `--omit=dev`, so there is no test runner in it, and `/app` is deliberately
# read-only and root-owned. Loosening either of those to make tests runnable
# would weaken the image that actually ships.
#
# So this is a sibling: the *same* base image and the *same* native build, plus
# the dev dependencies the suite needs. It is never deployed, never referenced
# by `docker-compose.yml`, and nothing in it reaches production.
#
# ## Running it
#
#   docker build -f infrastructure/docker/terminal-test.Dockerfile -t jumptotech/terminal-test .
#   docker run --rm --network kind \
#     -e RUN_INTEGRATION_TESTS=1 \
#     -e KUBECONFIG=/app/infrastructure/kind/generated/kubeconfig-internal.yaml \
#     -v "$PWD/services:/app/services" -v "$PWD/apps:/app/apps" \
#     -v "$PWD/labs:/app/labs" -v "$PWD/test-support:/app/test-support" \
#     -v "$PWD/infrastructure:/app/infrastructure" \
#     jumptotech/terminal-test \
#     npx vitest run test/terminal-integration.test.ts --root services/terminal
#
# `--network kind` is what lets the suite reach the cluster's API server at its
# in-network address, which is exactly how the deployed terminal container
# reaches it.

FROM node:22-bookworm-slim

# node-pty is a native addon and must be compiled — the same reason the
# production image has a build stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# kubectl, because the suite's whole point is running a real one inside the PTY
# and watching the API server accept it for this namespace and refuse it for
# every other. Pinned to the version the production terminal image carries.
ARG KUBECTL_VERSION=v1.34.2
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) karch=amd64 ;; \
      arm64) karch=arm64 ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${karch}/kubectl"; \
    chmod 0755 /usr/local/bin/kubectl; \
    kubectl version --client=true --output=yaml >/dev/null

WORKDIR /app

# Only the manifests, so `npm ci` is cached independently of source edits. The
# source itself is bind-mounted at run time.
COPY package.json package-lock.json ./
COPY apps/api/package.json        apps/api/package.json
COPY apps/web/package.json        apps/web/package.json
COPY services/lab-orchestrator/package.json services/lab-orchestrator/package.json
COPY services/progress/package.json         services/progress/package.json
COPY services/terminal/package.json         services/terminal/package.json
COPY services/verifier/package.json         services/verifier/package.json
COPY test-support/package.json              test-support/package.json

# Dev dependencies included, unlike the production image: vitest lives here.
# node-pty is compiled for *this* platform, which is the whole point.
RUN npm ci \
 && node -e "require('node-pty'); console.log('node-pty built OK')"

COPY tsconfig.base.json ./

# A real HOME for the PTYs the suite spawns. Runs as root because this is a
# throwaway test container with no student in it — the production image's
# unprivileged `student` user is a property of the image that ships, and
# reproducing it here would only make bind-mount ownership fight the test.
ENV HOME=/root \
    NODE_ENV=test

CMD ["npx", "vitest", "run", "test/terminal-integration.test.ts", "--root", "services/terminal"]
