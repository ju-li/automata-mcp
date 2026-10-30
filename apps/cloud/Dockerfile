# Build context is the REPO ROOT, like apps/web — the lockfile and workspace
# manifest live there:
#
#   docker build -f apps/cloud/Dockerfile -t automata-cloud .
#
# On Railway, set this service's root directory to the repo root and its
# Dockerfile path to apps/cloud/Dockerfile.
#
# Hosted offering only: no self-host artifact (compose, AIO image, templates)
# references this service.
#
# No build step: Node >= 22.18 runs src/*.ts directly by stripping types.
# No BuildKit cache mount and no VOLUME, for the Railway reasons given in
# apps/web/Dockerfile. The service keeps no state on disk.

FROM node:22.23.2-alpine AS deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cloud/package.json ./apps/cloud/
RUN pnpm install --frozen-lockfile --prod --filter cloud...


FROM node:22.23.2-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/cloud/node_modules ./apps/cloud/node_modules
COPY apps/cloud/package.json ./apps/cloud/
COPY apps/cloud/src ./apps/cloud/src
WORKDIR /app/apps/cloud

# Listens on CLOUD_PORT, else PORT (Railway injects it), else 8096.
USER node
EXPOSE 8096
CMD ["node", "src/main.ts"]
