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
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 3000

CMD ["nginx", "-g", "daemon off;"]
