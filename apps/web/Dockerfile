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
# No BuildKit cache mount here on purpose. Railway rejects one unless its id is
# prefixed with that service's own id (`id=s/<service-id>-<target>`), which would
# hardcode a single Railway service into this Dockerfile and break every other
# build context.
#
# Little is lost: the layer above is keyed on the lockfile, so an unchanged
# lockfile skips this step entirely, and Railway's builders are ephemeral so a
# store cache would rarely survive between builds anyway.
RUN pnpm install --frozen-lockfile --filter web...


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
# NITRO_PORT is deliberately NOT set. Nitro resolves `NITRO_PORT || PORT`, so
# pinning it here would make the server ignore the port Railway assigns. Unset,
# it falls back to 3000 for local runs.
#
# Binding :: accepts both IPv6 and IPv4. Legacy Railway environments route the
# private network over IPv6 only, where 0.0.0.0 is unreachable.
ENV NITRO_HOST=::

# The Nitro output is self-contained; no node_modules needed.
COPY --from=build /app/apps/web/.output ./.output

USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
