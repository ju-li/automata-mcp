# PocketBase ships a single static binary — no official image exists, so we pin a
# release and unpack it ourselves.
FROM alpine:3.22.5

ARG PB_VERSION=0.39.11
ARG TARGETARCH

RUN apk add --no-cache ca-certificates unzip wget \
    && case "${TARGETARCH}" in \
         amd64) PB_ARCH=amd64 ;; \
         arm64) PB_ARCH=arm64 ;; \
         arm)   PB_ARCH=armv7 ;; \
         *)     echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
       esac \
    && wget -q -O /tmp/pb.zip \
         "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${PB_ARCH}.zip" \
    && unzip -q /tmp/pb.zip -d /pb \
    && rm /tmp/pb.zip \
    && apk del unzip wget

# The schema has to be IN the image. In development these two directories are
# bind-mounted by docker-compose.dev.yml, which shadows what is baked in here —
# that is deliberate, so schema edits made in the admin UI land back in the repo.
# In production nothing is mounted, and without these the container boots with an
# empty migrations directory and never creates a single collection.
COPY pb_migrations/ /pb_migrations/
COPY pb_hooks/ /pb_hooks/

# Runtime state only. Mount a volume here or you lose every user and token on
# each deploy.
VOLUME ["/pb_data"]

EXPOSE 8090

# `sh -c` so ${PORT} expands — platforms like Railway assign a port and expect
# the process to listen on it. `exec` hands PID 1 to PocketBase so it still
# receives SIGTERM directly and shuts down cleanly.
#
# Binding [::] rather than 0.0.0.0 accepts both IPv6 and IPv4 (dual-stack). New
# Railway environments resolve internal DNS to both families, but legacy ones are
# IPv6-only, where 0.0.0.0 would be unreachable over the private network.
CMD ["sh", "-c", "exec /pb/pocketbase serve --http=[::]:${PORT:-8090} --dir=/pb_data --migrationsDir=/pb_migrations --hooksDir=/pb_hooks"]
