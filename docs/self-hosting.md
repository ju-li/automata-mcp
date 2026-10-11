# Self-hosting with Docker Compose

`docker-compose.yml` at the repository root runs the whole app from the
published images: the web app, Postgres, and — behind compose profiles — the
WhatsApp and Telegram backends. It is not the development setup; for that, see
[Development](development.md).

## Start it

```bash
git clone https://github.com/ju-li/automata-mcp.git && cd automata-mcp
cp .env.selfhost.example .env
for k in POSTGRES_PASSWORD WEBHOOK_SECRET EVOLUTION_API_KEY TELEGRAM_BRIDGE_ADMIN_KEY TELEGRAM_SESSION_ENCRYPTION_KEY; do
  echo "$k=$(openssl rand -hex 32)"; done >> .env
```

Set `NUXT_PUBLIC_APP_URL` in `.env` to the address people will open — it is
what every connector URL is built from. Then pick what to run:

```bash
docker compose up -d                                         # database connections only
docker compose --profile whatsapp up -d                      # + WhatsApp (Evolution API, Redis)
docker compose --profile whatsapp --profile telegram up -d   # + Telegram bridge
```

Open the app on port 3000 (`WEB_PORT`) and sign up. The first account creates
an organization and is its admin. The app creates its database schema on first
boot — look for `[app-db] applied migrations` in `docker compose logs web`.

Telegram also needs your own `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` from
<https://my.telegram.org>; without them the bridge runs and the app tells an
admin what to set. See [Telegram connections](telegram.md).

Mail is optional: with `SMTP_HOST` empty, [connection alerts](alerts.md) and
invitation emails are not delivered; an invitation link is still shown on
screen when it is created.

## What it runs

| Service | Image | Profile | Published |
|---|---|---|---|
| `web` | `ghcr.io/ju-li/automata-mcp-web:1` | — | `WEB_PORT` → 3000 |
| `postgres` | `postgres:16.15-alpine` | — | no |
| `redis` | `redis:8.2.9-alpine` | `whatsapp` | no |
| `evolution` | `evoapicloud/evolution-api:v2.3.7` | `whatsapp` | no |
| `telegram-bridge` | `ghcr.io/ju-li/automata-mcp-telegram-bridge:1` | `telegram` | no |

Only the web app is published. Everything else, including the webhooks
Evolution and the bridge send back to the app, travels over the compose
network. The web service's `NUXT_*` variables are set in `docker-compose.yml`
from the handful in `.env`, so one Postgres, one password and one webhook
secret serve all of it.

Put the web app behind a TLS-terminating reverse proxy before anyone else uses
it, and set `NUXT_PUBLIC_APP_URL` to the `https://` address. Claude connects to
the connector URL from its own servers, so it must be reachable from the
internet.

The images are pinned to the major tag `:1`. To update within it:

```bash
docker compose pull && docker compose up -d   # add the same --profile flags
```

Migrations run at boot and only go forward, so moving to a new major is a
deliberate edit of the tag, not something `pull` does for you. See
[Releases](releases.md).

## ⚠️ WhatsApp pairing burns a real phone number

Scanning the QR binds a real WhatsApp account to an instance. WhatsApp rate-limits
and can ban numbers that pair and unpair repeatedly, or that send unsolicited
messages from a freshly-paired session. **Use a spare SIM, not your primary
number**, and keep test traffic to conversations you control.

## ⚠️ `docker compose down -v` forces a QR re-scan

`-v` deletes the `evolution_instances` volume, which holds every paired session.
Every instance has to be re-paired by scanning a new QR code — see the warning
above about what that costs. For routine restarts use `down` without `-v`:

```bash
docker compose --profile whatsapp --profile telegram down
```

Back up the `postgres_data` volume: it holds every user, connection, stored
credential and synced message.

## The app database

Everything the app itself keeps is in the `app` schema of `NUXT_DATABASE_URL` —
the same Postgres Evolution writes into (under `public`) and the Telegram bridge
uses (under `telegram`). The schema is `apps/web/server/db/migrations.ts`, applied
in order when the server starts, under an advisory lock and in one transaction;
`app.migrations` records which have run. Migrations are append-only: one that has
been deployed is never edited, because it will not run again anywhere it already
has.

| Table | Holds |
|---|---|
| `users` | email (stored lower-cased), display name, password hash |
| `sessions` | browser sessions — SHA-256 of the cookie, expiry |
| `organizations`, `memberships` | one membership per user (a unique index), with its role |
| `instances` | one row per connection, `kind` of `whatsapp`, `postgres` or `telegram` |
| `instance_assignments` | "may use, not manage" grants to members |
| `invitations` | SHA-256 of the invitation code, address, role, expiry |
| `mcp_tokens` | SHA-256 of the connector token, holder, scope, expiry, `last_used_at` |

An `instances` row carries, by kind:

- **WhatsApp** — the Evolution instance's `name` and `instance_id`, its
  `base_url`, and the per-instance `api_key`. A bring-your-own connection also
  carries its server's `admin_key` and, once supplied, `evolution_db_url`.
- **Postgres** — the `dsn`, plus `db_host`, `db_port` and `db_database` for
  display. Nothing connects through the display three.
- **Telegram** — the bridge's `base_url`, the session's `instance_id` and
  `api_key`, and for a bring-your-own bridge its `admin_key` and `telegram_db_url`.

Two more columns, `down_since` and `alerted_at`, carry outage state — see
[Connection alerts](alerts.md).

`api_key`, `admin_key`, `dsn`, `evolution_db_url` and `telegram_db_url` never
leave the server — `toPublicInstance()` is the only projection the UI receives —
but they are **not encrypted**: they sit in clear in the database and in every
backup of it. So treat `NUXT_DATABASE_URL` and the database's backups as holding
every connected account.

Foreign keys say what deleting does. A user's tokens, sessions, memberships and
assignments go with them; a connection's tokens and assignments go with it. An
organization that still owns connections **cannot** be deleted, and a connection
does not go with its creator — a cascade there would drop rows pointing at live
WhatsApp sockets without ever telling Evolution.

To start over locally, drop the schema; the next boot recreates it:

```bash
psql postgres://evolution:change-me@localhost:5432/evolution -c 'DROP SCHEMA app CASCADE'
```

## Coming from PocketBase

Versions before this one kept all of this in PocketBase. A deployment still on
PocketBase must first deploy commit `2e1872e` (the merge of ju-li/automata-mcp#46), which imports
every user, password, connection and token into this schema on its first boot —
see [the README at that commit](https://github.com/ju-li/automata-mcp/blob/2e1872e/README.md), "Moving off PocketBase". Accounts imported that way
keep their bcrypt password hash until they next sign in, when it is replaced with
scrypt.
