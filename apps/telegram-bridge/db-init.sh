#!/bin/sh
# One-shot bootstrap for the Telegram bridge's database, on an existing Postgres
# server (by default the one Evolution uses). Idempotent: safe on every
# `compose up`, and it also rotates both role passwords to the current values.
#
# Runs as that server's superuser because creating roles and databases needs
# one. The bridge itself never gets that credential — it connects as
# telegram_bridge, which owns only the `telegram` database.
#
# Creates:
#   telegram_bridge  LOGIN, owner of database `telegram`. Not a superuser.
#   telegram_reader  LOGIN, CONNECT on `telegram` only. The bridge grants it
#                    SELECT on synced data at boot (grantReader in src/db.ts).
#
# Neither role is granted anything in Evolution's database. They can still open
# a connection to it through PUBLIC's default CONNECT, where they see catalogs
# and no table: Evolution's tables grant nothing to PUBLIC. CONNECT is not
# revoked from PUBLIC there, because Evolution's existing read-only role relies
# on it and would silently lose message reads.
#
# Railway / hand-run: set PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE to the
# server's superuser connection and the two password variables, then run this.
set -eu

: "${TELEGRAM_BRIDGE_DB_PASSWORD:?set TELEGRAM_BRIDGE_DB_PASSWORD (openssl rand -hex 24)}"
: "${TELEGRAM_READER_PASSWORD:?set TELEGRAM_READER_PASSWORD (openssl rand -hex 24)}"

psql -v ON_ERROR_STOP=1 \
  -v bridge_pw="$TELEGRAM_BRIDGE_DB_PASSWORD" \
  -v reader_pw="$TELEGRAM_READER_PASSWORD" <<'SQL'
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telegram_bridge') AS create_bridge \gset
\if :create_bridge
  CREATE ROLE telegram_bridge LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
\endif
ALTER ROLE telegram_bridge PASSWORD :'bridge_pw';

SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telegram_reader') AS create_reader \gset
\if :create_reader
  CREATE ROLE telegram_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
\endif
ALTER ROLE telegram_reader PASSWORD :'reader_pw';

SELECT NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'telegram') AS create_db \gset
\if :create_db
  CREATE DATABASE telegram OWNER telegram_bridge;
\endif

REVOKE ALL ON DATABASE telegram FROM PUBLIC;
GRANT CONNECT ON DATABASE telegram TO telegram_reader;
SQL

echo "telegram-db-init: roles and database ready"
