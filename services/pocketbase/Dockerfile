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

# Bind-mounted from the repo by docker-compose.dev.yml. pb_data is gitignored;
# pb_migrations and pb_hooks are committed, so schema edits made in the admin UI
# get written back into the working tree as migration files.
VOLUME ["/pb_data"]

EXPOSE 8090

CMD ["/pb/pocketbase", "serve", \
     "--http=0.0.0.0:8090", \
     "--dir=/pb_data", \
     "--migrationsDir=/pb_migrations", \
     "--hooksDir=/pb_hooks"]
