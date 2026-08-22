# Build context is the REPO ROOT, not apps/web — the lockfile and workspace
# manifest live there:
#
#   docker build -f apps/web/Dockerfile -t claude-whatsapp-mcp-web .
#
# On Railway, set this service's root directory to the repo root and its
# Dockerfile path to apps/web/Dockerfile.

FROM node:22.23.2-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app


# ── deps ─────────────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter web...


# ── build ────────────────────────────────────────────────────────────────────
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web ./apps/web
# `nuxt build` here, not `pnpm build` — the package script passes
# `--dotenv ../../.env`, which does not exist in the image. Runtime config comes
# from NUXT_* environment variables instead.
RUN cd apps/web && pnpm exec nuxt build


# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22.23.2-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NITRO_PORT=3000
ENV NITRO_HOST=0.0.0.0

# The Nitro output is self-contained; no node_modules needed.
COPY --from=build /app/apps/web/.output ./.output

USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
