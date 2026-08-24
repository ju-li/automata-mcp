#!/bin/sh
set -e

# Create or update the superuser the Nuxt server authenticates as, then serve.
#
# `superuser upsert` is idempotent, so running it on every boot is safe: it
# creates the account the first time and updates the password afterwards. That
# also means rotating the password is just editing the variable and redeploying
# — there is no separate step and no shell to open.
#
# Accepts the PB_-prefixed names, and falls back to the NUXT_-prefixed ones so a
# deployment can set the exact same variable on both services and have them
# match by construction. They MUST match: the Nuxt server signs in with them to
# read hidden fields and the admin-only collections.
PB_EMAIL="${PB_SUPERUSER_EMAIL:-${NUXT_POCKETBASE_ADMIN_EMAIL:-}}"
PB_PASSWORD="${PB_SUPERUSER_PASSWORD:-${NUXT_POCKETBASE_ADMIN_PASSWORD:-}}"

if [ -n "$PB_EMAIL" ] && [ -n "$PB_PASSWORD" ]; then
  # PocketBase's CLI accepts very short superuser passwords without complaint.
  # This account can read every user's Evolution API key and every connector
  # token record, so say something — but warn rather than refuse, because
  # password policy is the operator's call, not this script's.
  if [ "${#PB_PASSWORD}" -lt 12 ]; then
    echo "[entrypoint] WARNING: the superuser password is under 12 characters." >&2
    echo "[entrypoint] This account can read every user's WhatsApp credentials." >&2
  fi

  # Never let the password reach the logs.
  if /pb/pocketbase superuser upsert "$PB_EMAIL" "$PB_PASSWORD" --dir=/pb_data >/dev/null 2>/tmp/pb-superuser.err; then
    echo "[entrypoint] superuser ready: $PB_EMAIL"
  else
    # Warn rather than exit. A hard failure here would crash-loop the container
    # and take away the admin UI — the one place you could fix this by hand.
    # The app answers 503 with a precise reason until it is sorted.
    echo "[entrypoint] WARNING: could not create or update superuser '$PB_EMAIL'." >&2
    echo "[entrypoint] The web service will fail with 'Auth backend unavailable' until this succeeds." >&2
    echo "[entrypoint] PocketBase said:" >&2
    sed 's/^/[entrypoint]   /' /tmp/pb-superuser.err >&2 || true
  fi
  rm -f /tmp/pb-superuser.err
else
  echo "[entrypoint] no superuser credentials set (PB_SUPERUSER_EMAIL / NUXT_POCKETBASE_ADMIN_EMAIL); skipping."
  echo "[entrypoint] The web service cannot authenticate until a superuser exists."
fi

# exec so PocketBase becomes PID 1 and receives SIGTERM directly.
exec /pb/pocketbase serve \
  --http="[::]:${PORT:-8090}" \
  --dir=/pb_data \
  --migrationsDir=/pb_migrations \
  --hooksDir=/pb_hooks
