# syntax=docker/dockerfile:1
#
# JumpToTech Labs — web frontend (production bundle + nginx reverse proxy).
#
# Students reach this container on one port. nginx serves the Vite build and
# proxies /api/* to the API service and /terminal to the terminal WebSocket
# service — the layout Cloudflare Tunnel expects.

FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json        apps/api/package.json
COPY apps/web/package.json        apps/web/package.json
COPY services/observability/package.json    services/observability/package.json
COPY services/lab-orchestrator/package.json services/lab-orchestrator/package.json
COPY services/progress/package.json         services/progress/package.json
COPY services/terminal/package.json         services/terminal/package.json
COPY services/verifier/package.json         services/verifier/package.json

RUN npm ci --workspace @jumptotech/web --include-workspace-root --ignore-scripts \
 && npm cache clean --force

COPY apps/web apps/web

# Same-origin public access: the bundle calls `/api/*` and `/terminal` on the
# page origin. Explicit VITE_* values can still be passed as build args.
ARG VITE_API_URL=
ARG VITE_TERMINAL_WS_URL=
ENV VITE_API_URL=$VITE_API_URL \
    VITE_TERMINAL_WS_URL=$VITE_TERMINAL_WS_URL

RUN npm run build --workspace @jumptotech/web

FROM nginx:1.27-alpine

COPY infrastructure/docker/nginx/web.conf /etc/nginx/conf.d/default.conf
# The routes, shared by the development listener above and the production TLS
# listener (web-tls.conf, mounted over default.conf by
# docker-compose.production.yml), so the two cannot drift apart.
COPY infrastructure/docker/nginx/locations.conf /etc/nginx/jumptotech/locations.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

# Metadata only: nothing is published by EXPOSE. 3000 is the development
# listener; 8443 (TLS) and 8080 (redirect only) exist under the production conf.
EXPOSE 3000 8080 8443

CMD ["nginx", "-g", "daemon off;"]
