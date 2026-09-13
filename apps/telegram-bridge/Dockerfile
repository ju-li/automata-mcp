# Build context is the REPO ROOT, like apps/web — the lockfile and workspace
# manifest live there:
#
#   docker build -f apps/telegram-bridge/Dockerfile -t telegram-bridge .
#
# On Railway, set this service's root directory to the repo root and its
# Dockerfile path to apps/telegram-bridge/Dockerfile.
#
# No build step: Node >= 22.18 runs src/*.ts directly by stripping types.
# No BuildKit cache mount and no VOLUME, for the Railway reasons given in
# apps/web/Dockerfile. The bridge keeps no state on disk; everything is in its
# Postgres database.

FROM node:22.23.2-alpine AS deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/telegram-bridge/package.json ./apps/telegram-bridge/
RUN pnpm install --frozen-lockfile --prod --filter telegram-bridge...


FROM node:22.23.2-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/telegram-bridge/node_modules ./apps/telegram-bridge/node_modules
COPY apps/telegram-bridge/package.json ./apps/telegram-bridge/
COPY apps/telegram-bridge/src ./apps/telegram-bridge/src
WORKDIR /app/apps/telegram-bridge

# Listens on TELEGRAM_BRIDGE_PORT, else PORT (Railway injects it), else 8095.
USER node
EXPOSE 8095
CMD ["node", "src/main.ts"]
