# syntax=docker/dockerfile:1
#
# JumpToTech Labs — web frontend (Vite dev server).
#
# Story 1 targets local development, so this serves the app through Vite with
# hot reload. A production image would run `vite build` and serve the static
# bundle from a CDN or an nginx layer; see README → Future AWS architecture.

FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json        apps/api/package.json
COPY apps/web/package.json        apps/web/package.json
COPY services/lab-orchestrator/package.json services/lab-orchestrator/package.json
COPY services/terminal/package.json         services/terminal/package.json
COPY services/verifier/package.json         services/verifier/package.json

# Dev dependencies are required: Vite itself is one. `--ignore-scripts` keeps
# the terminal service's native addon out of a frontend-only image.
RUN npm ci --workspace @jumptotech/web --include-workspace-root --ignore-scripts \
 && npm cache clean --force

COPY apps/web apps/web

# The Vite dev server writes a transient bundled-config file next to
# vite.config.ts, so the app directory must be writable by the runtime user.
RUN chown -R node:node /app/apps/web

ENV HOME=/tmp \
    WEB_PORT=3000

USER node
EXPOSE 3000
WORKDIR /app/apps/web

CMD ["npx", "vite", "--host", "0.0.0.0"]
