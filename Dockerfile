FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS build

WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml ./
RUN corepack enable && corepack install && yarn install --immutable

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN yarn build && yarn workspaces focus --all --production

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runtime

ENV NODE_ENV=production

WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules

RUN mkdir /work && chown node:node /work
WORKDIR /work
USER node

ENTRYPOINT ["node", "/app/dist/cli.js"]
