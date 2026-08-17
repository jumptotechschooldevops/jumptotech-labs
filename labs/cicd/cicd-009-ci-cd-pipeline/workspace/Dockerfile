# JumpToTech Bank — statements service image
#
# Packages the application together with the runtime it needs, so the thing
# that runs in staging is the same thing that ran in CI.
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY build.mjs ./
COPY src ./src

USER node

CMD ["node", "src/cli.mjs"]
