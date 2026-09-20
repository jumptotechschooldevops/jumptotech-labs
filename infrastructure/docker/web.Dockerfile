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

# The edge: nginx, its configuration and the certificate gate, without the
# application bundle. services/observability/test/tls-edge-integration.test.ts
# builds this stage on its own (`--target edge`), so it tests the image the web
# service ships without needing a Vite build.
#
# nginx's stable line. 1.27 was a mainline series: its image was last rebuilt on
# 2025-04-16, so the public TLS edge carried an nginx and an Alpine userland
# (musl, zlib, …) with no security update since. The stable tag is rebuilt as
# upstream and Alpine ship fixes; a rebuild of this image picks them up.
FROM nginx:1.30-alpine AS edge

# openssl is the only tool the certificate gate needs (BETA-P0-017). The runtime
# directory holds the one file the gate writes; /var/www/acme is where the
# production overlay mounts the ACME challenge webroot.
RUN apk add --no-cache openssl \
 && mkdir -p /etc/nginx/jumptotech/runtime /var/www/acme

COPY infrastructure/docker/nginx/web.conf /etc/nginx/conf.d/default.conf
# The routes, shared by the development listener above and the production TLS
# listener (web-tls.conf, mounted over default.conf by
# docker-compose.production.yml), so the two cannot drift apart.
COPY infrastructure/docker/nginx/locations.conf /etc/nginx/jumptotech/locations.conf
COPY infrastructure/docker/nginx/security-headers.conf /etc/nginx/jumptotech/security-headers.conf

# The certificate gate. It does nothing unless WEB_TLS=required, which only the
# production overlay sets. It then refuses to let nginx start on a missing,
# expired, mismatched or wrong-host certificate. No certificate or key is copied
# into any image: they are bind-mounted at runtime, and .dockerignore keeps them
# out of the build context.
COPY --chmod=0755 infrastructure/docker/nginx/tls-preflight.sh /usr/local/bin/jtt-tls-preflight
COPY --chmod=0755 infrastructure/docker/nginx/05-jumptotech-tls-preflight.sh /docker-entrypoint.d/05-jumptotech-tls-preflight.sh

# Metadata only: nothing is published by EXPOSE. 3000 is the development
# listener; 8443 (TLS) and 8080 (redirect only) exist under the production conf.
EXPOSE 3000 8080 8443

CMD ["nginx", "-g", "daemon off;"]

FROM edge

COPY --from=build /app/apps/web/dist /usr/share/nginx/html
