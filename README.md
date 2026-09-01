# claude-whatsapp-mcp

A Nuxt app that serves two surfaces from one Nitro server:

1. **Web UI** — users manage their [Evolution API](https://doc.evolution-api.com/) (WhatsApp) instances.
2. **MCP endpoint** — Claude connects to `/mcp` as a custom connector.

PocketBase is the backend (users, sessions, per-user Evolution credentials).
Evolution API, Postgres and Redis are dependencies you run, not code in this repo.

> **Status.** Sign-up, WhatsApp pairing, the per-account dashboard, connector
> token provisioning and history import all work. Five MCP tools: connection
> status, chat listing, message reading, message search (opt-in — see "Message
> search") and text sending. Webhook event handling is not built;
> `/api/webhook/evolution` is a stub that logs and acks.

## Layout

```
apps/web/                    Nuxt 4 + TypeScript. Has its own Dockerfile.
  app/                       pages, layouts, components (shadcn-vue)
  modules/                   local Nuxt modules (registers /mcp/:token)
  server/api/                auth, instances, tokens
  server/mcp/                MCP handler + tools
  server/utils/              PocketBase, auth, instances, Evolution client, redaction
services/pocketbase/         pinned PocketBase image + committed schema
docker-compose.dev.yml       services only — NOT Nuxt
.zed/                        tasks + language server config
.env.example                 every variable, documented
```

Package manager is **pnpm** (`pnpm@11.22.0`, pinned via `packageManager`). Do not use npm/yarn.

## First run

```bash
cp .env.example .env          # then fill in the blanks — see comments in the file
pnpm install
pnpm services:up              # postgres, redis, evolution, pocketbase
```

The PocketBase superuser is created for you from `NUXT_POCKETBASE_ADMIN_EMAIL`
and `NUXT_POCKETBASE_ADMIN_PASSWORD` — the container upserts it on every boot, so
there is no manual step and changing the password is just editing `.env` and
restarting.

Then start Nuxt **on the host** (it is deliberately not in compose, so you keep HMR):

```bash
pnpm dev                      # http://localhost:3000
```

Admin UI: <http://localhost:8090/_/> · Evolution: <http://localhost:8080> · Nuxt: <http://localhost:3000>

There is no `predev` hook — bring the services up yourself.

### Scripts

| | |
|---|---|
| `pnpm dev` | Nuxt dev server on the host |
| `pnpm build` / `pnpm preview` | production build / serve it |
| `pnpm typecheck` | `nuxt typecheck` across app + server |
| `pnpm services:up` / `:down` / `:logs` / `:ps` | the compose stack |

## Networking

Traffic crosses the host/container boundary in both directions.

| From | To | Address |
|---|---|---|
| Nuxt (host) | Evolution | `http://localhost:8080` |
| Nuxt (host) | PocketBase | `http://localhost:8090` |
| Evolution (container) | Nuxt webhook | `http://host.docker.internal:3000/api/webhook/evolution` |

`host.docker.internal` is not resolvable in Linux containers by default, so the
evolution service declares `extra_hosts: ["host.docker.internal:host-gateway"]`.

The webhook URL comes from `WEBHOOK_URL` / `NUXT_WEBHOOK_URL`, so dev and prod
differ by configuration only — no code change.

`pnpm dev` runs `nuxt dev --host 0.0.0.0`. It has to: bound to `localhost`, Nuxt
is unreachable from the Evolution container.

Binding `0.0.0.0` means the socket listens on every interface, including your
LAN one. Whether that is actually *reachable* from the LAN depends on your
firewall — with ufw enabled and no blanket `allow 3000`, inbound LAN traffic is
still dropped and only the narrowly-scoped rule below gets through. With no
firewall, port 3000 is open to your network. Drop `--host 0.0.0.0` from
`apps/web/package.json` if you are on an untrusted network and can live without
inbound webhooks.

### Linux firewall

On a Linux host with **ufw** enabled, the webhook silently times out until you
allow it. This is not a Docker quirk — it is ordinary inbound filtering:

- The container has its own network namespace, so it reaches the host over a
  routable host IP (`host.docker.internal` → `172.17.0.1`, the `docker0`
  address), not over loopback.
- That packet arrives on a real host interface destined for a host-owned
  address, so it enters the **INPUT** chain — the same path as a packet off your
  LAN. ufw's `DEFAULT_INPUT_POLICY` is `DROP`, so it is dropped (silently, hence
  the timeout rather than a refused connection).
- The reverse direction works because published container ports are DNAT'd and
  travel the OUTPUT/FORWARD path, never INPUT. Docker writes NAT and FORWARD
  rules only — it never opens INPUT, so container → host is governed by ufw
  normally.
- `ping` from the container succeeds regardless: `/etc/ufw/before.rules` accepts
  ICMP echo ahead of the default deny. Reachable-by-ping but not by TCP is the
  signature of this problem.

The compose network's subnet is pinned to `172.31.250.0/24` so one stable rule
covers it:

```bash
sudo ufw allow from 172.31.250.0/24 to 172.17.0.1 port 3000 proto tcp comment 'evolution -> nuxt webhook'
```

Verify the round-trip:

```bash
docker compose -f docker-compose.dev.yml exec evolution \
  wget -T 5 -qO- --post-data='{"event":"ping"}' \
    --header='content-type: application/json' \
    http://host.docker.internal:3000/api/webhook/evolution
```

`{"ok":true}` means the path is open; a timeout means the rule is missing or the
subnet does not match. Everything else in the stack works without this rule —
only inbound webhooks need it.

## Auth

Two paths on the same app, deliberately kept apart. **An MCP tool never falls
back to the browser session.**

| | Web UI | MCP |
|---|---|---|
| Credential | PocketBase session cookie | `Authorization: Bearer <token>`, or `/mcp/<token>` |
| Resolved by | `server/middleware/session.ts` → `server/utils/session.ts` | `server/mcp/index.ts` → `server/utils/mcp-auth.ts` |
| Context key | `event.context.user` | `event.context.mcpAuth` |
| On failure | 401 JSON | **401 + `WWW-Authenticate`** — never 200 |

`server/middleware/session.ts` returns early on `/mcp`, so cookies are never even
parsed there. `useEvolutionClient()` (used by tools) reads `event.context.mcpAuth`
and has no code path to the session user.

The MCP token is minted by this app — it is **not** Evolution's `apikey`. Only its
SHA-256 hash is stored, in the superuser-only `mcp_tokens` collection, alongside
`last_used_at` and `expires_at`. It resolves to one row in `instances`, which
holds that account's Evolution token server-side.

**Evolution's global key never reaches a user record.** It is used only to create
and delete instances (`server/utils/instances.ts`). Every other call uses the
per-instance token Evolution issues at create time, which Evolution itself scopes
to that one instance. There is deliberately no fallback from a missing
per-instance key to the global one — that would hand any token holder access to
every user's account.

A PocketBase outage answers **503**, not 401 — a 401 would tell a client its
valid token had been revoked and invite it to throw the token away.

Tokens never reach logs or error bodies: `server/plugins/redact-mcp.ts` scrubs
`/mcp/<token>` to `/mcp/[redacted]` at the source (`event.node.req.originalUrl`,
which is what Nitro's error handler reads). Route any error reporter you add
through `redactPath` / `redactHeaders` in `server/utils/redact.ts`.

### Using it

1. Sign up at <http://localhost:3000>.
2. Name the account and continue — the app provisions an Evolution instance for
   you and shows a QR code.
3. Scan it: WhatsApp → Settings → Linked devices → Link a device.
4. On the account page, create a connector token and copy the URL it shows.
5. Add that URL to Claude as a custom connector.

**One WhatsApp account per connector.** A token is bound to the account it was
created on, so the tools take no account argument and Claude cannot address the
wrong number. Connect several accounts and give each its own token.

### Scoping a token

A token can be narrowed on two independent axes, both edited from the account page:

- **Actions** — all tools, or a chosen few. Enforced by refusing to register the
  others for that request, so a tool outside scope is not merely hidden from the
  tool list: calling it fails.
- **Chats** — all conversations, or an allowlist. `list-chats` returns only
  allowed conversations; `read-messages` and `send-text-message` refuse anything
  else, naming the chat so the assistant can explain why. `search-messages` does
  both: asked for a chat outside scope it refuses by name, while an unrestricted
  search is narrowed to the allowed chats — out-of-scope messages are excluded by
  the query itself, not filtered out after being read.

The chat picker lists conversations Evolution has recorded — the history imported
at pairing, plus everything since. An account paired before full-history sync was
switched on shows only the latter until it is re-imported. Either way a number
that has never messaged you can be added directly; it is checked against WhatsApp
before it is accepted.

Scope is read fresh on every request, so **editing a token's scope takes effect
immediately and does not reissue it**. The connector already configured in Claude
keeps working; only what it can reach changes.

A scoped send refuses when it cannot verify the recipient — if the account is
disconnected, the message is not sent rather than sent unchecked.

The token is shown exactly once — only its SHA-256 hash is stored. Lost tokens
are replaced, not recovered. Revoking one takes effect immediately, and revoking
stays available while an account is disconnected.

Inspect the endpoint by hand with:

```bash
pnpm dlx @modelcontextprotocol/inspector
```

Point it at `http://localhost:3000/mcp/<token>`, or at `http://localhost:3000/mcp`
with an `Authorization: Bearer <token>` header.

### Message search

`search-messages` is **off unless you configure it**, and it is the one feature
that does not go through the Evolution API.

Evolution 2.3.7 cannot search message content. `POST /chat/findMessages` accepts a
`where.message` — its request schema even documents the field — and then never
reads it, so a content search comes back as an unfiltered page that looks like a
result set. The only filters it honours are `id`, `source`, `messageType`, a
`messageTimestamp` range, and `key.{id,remoteJid,fromMe,participant}`. One of
those does earn its keep: `read-messages` passes `messageType: { not:
'reactionMessage' }` to drop reactions before the page is built. WhatsApp's own
control records cannot ride that same trick — `messageType` carries no subtype,
and excluding `protocolMessage` wholesale would delete every message edit along
with the bookkeeping — so those are dropped locally and counted back to the
caller as `protocolMessagesExcluded`. Content search,
though, means reading Evolution's Postgres directly, via
`NUXT_EVOLUTION_DATABASE_URL`. That query also reaches text WhatsApp stores a
level or two down — an album item's caption under `associatedChildMessage`, an
edit's new wording under `protocolMessage.editedMessage` — which no top-level
extractor could see. Leave it empty and the tool is not registered at
all — clients never see it — rather than failing when called.

**Give it a role that can do nothing else.** Every other credential in this app is
scoped to a single account; this connection can reach every user's messages in
every instance. The app never writes and never runs DDL, so:

```sql
CREATE ROLE wamcp_search LOGIN PASSWORD 'change-me';
GRANT CONNECT ON DATABASE evolution TO wamcp_search;
GRANT USAGE ON SCHEMA public TO wamcp_search;
GRANT SELECT ON "Message" TO wamcp_search;
```

```bash
NUXT_EVOLUTION_DATABASE_URL=postgres://wamcp_search:change-me@localhost:5432/evolution
```

In development you can point it at `POSTGRES_USER` instead; in production do not.

Evolution ships `@@index([instanceId])` and nothing else — no index on
`messageTimestamp`, none on the `key` JSONB — so search is a sequential scan
within one account. History import makes that corpus much larger than it would
otherwise be: a number with years of conversations arrives all at once at
pairing, rather than accumulating. The queries carry a 10-second
`statement_timeout` so a slow scan surfaces as an error instead of a hung MCP
call. Once a scan starts timing out, add (as a Postgres superuser, not as the
app):

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS message_instance_ts_idx
  ON "Message" ("instanceId", "messageTimestamp" DESC);
```

Two caveats worth knowing before you go looking for a bug:

- Search covers whatever Evolution holds: the history imported at pairing plus
  everything since. An account paired before full-history sync was turned on has
  only what arrived after — see "Importing existing history".
- The scope editor lists `search-messages` whether or not the database URL is
  set, because it reads the tool registry rather than the live per-request tool
  list. Granting it to a token is harmless while search is unconfigured.

On Railway, Evolution's Postgres is its own service — use its private URL, and
note the port there is whatever that service actually listens on (see "Pin the
ports").

### Adding tools

Drop a file in `apps/web/server/mcp/tools/` — it is discovered automatically.
Give every tool a `title` and the applicable `readOnlyHint` / `destructiveHint`;
see `get-connection-status.ts` (read) and `send-text-message.ts` (write) for the
pattern.

Also give it an explicit `name` and an `enabled` guard so it participates in
token scoping, and enforce chat scope in the handler if it touches a
conversation. Existing scoped tokens will not be granted the new tool — they list
the tools they were given, so new tools are denied by default.

Tool handlers get the MCP SDK's `RequestHandlerExtra`, not an H3 event, so
credentials are reached through `useEvolutionClient()` → `useEvent()`. That is why
`nitro.experimental.asyncContext` is enabled in `nuxt.config.ts` — do not turn it off.

## PocketBase schema

`users` holds accounts. `instances` holds one row per connected WhatsApp number,
including that instance's Evolution token as a `hidden` field. `mcp_tokens` holds
hashed connector tokens, each bound to one instance and cascade-deleted with it.
All three collections are superuser-only — the browser never talks to PocketBase,
so the session cookie is `httpOnly` and every read goes through a Nuxt route.

`services/pocketbase/pb_migrations/` is committed and is the source of truth.
`pb_migrations/` and `pb_hooks/` are bind-mounted, so schema changes you make in
the admin UI are written straight back into the working tree — commit them.

`pb_data/` is gitignored runtime state. The container runs as root, so on Linux
the directory ends up root-owned; remove it through a container:

```bash
docker compose -f docker-compose.dev.yml stop pocketbase
docker run --rm -v "$PWD/services/pocketbase:/x" alpine:3.22.5 rm -rf /x/pb_data
docker compose -f docker-compose.dev.yml up -d pocketbase
```

That resets everything, including the superuser, and re-applies every migration.

## Importing existing history

WhatsApp hands over past conversations **once**, in a burst it pushes while a
device is being linked. There is no endpoint — here or upstream — that fetches
history afterwards. Evolution exposes `/chat/findMessages`, but that reads
Evolution's own Postgres, not WhatsApp.

Three things have to line up, and two of them have to be true *before* the QR is
scanned:

| | Where | Effect if wrong |
|---|---|---|
| `DATABASE_SAVE_DATA_HISTORIC=true` | evolution service env | Evolution receives the burst and drops it |
| `syncFullHistory: true` | sent at `POST /instance/create`, in `server/utils/instances.ts` | Only recent messages arrive, and groups are skipped |
| A fresh device link | scanning the QR | Reconnecting an existing session sends no history |

New accounts get all three automatically. An account paired before this was
turned on cannot be backfilled in place — **Import full history** on the account
page sets the flag, signs the device out and puts the QR back up; the import
rides in on the re-scan. Nothing already stored is lost: Evolution skips messages
whose `key.id` it already has, so re-importing merges rather than duplicates.

Watch it land with `pnpm services:logs` while scanning:

```
recv 412 chats, 1180 contacts, 39204 msgs (is latest: false, progress: 34%), type: 2
```

`type: 2` is a full sync, `type: 3` is the recent-only one. Anything but `2` means
`syncFullHistory` never reached the socket.

Caveats worth knowing before you rely on it:

- **Media is not downloaded.** History gives message records; the bytes still need
  `getBase64FromMediaMessage` per message.
- **Depth is whatever the phone volunteers.** `syncFullHistory` asks for
  everything; it is not a guarantee of everything.
- **Groups come too.** `syncFullHistory` overrides Evolution's group filter, so
  group chats appear in `list-chats` and in the token scope picker.
- **Reads get slower as it grows.** Evolution indexes its `Message` table on
  `instanceId` only; `remoteJid` lives inside a JSONB column with no index.

## ⚠️ WhatsApp pairing burns a real phone number

Scanning the QR binds a real WhatsApp account to an instance. WhatsApp rate-limits
and can ban numbers that pair and unpair repeatedly, or that send unsolicited
messages from a freshly-paired session. **Use a spare SIM, not your primary
number**, and keep test traffic to conversations you control.

## ⚠️ `docker compose down -v` forces a QR re-scan

`-v` deletes the `evolution_instances` volume, which holds every paired session.
Every instance has to be re-paired by scanning a new QR code — see the warning
above about what that costs. For routine restarts use:

```bash
docker compose -f docker-compose.dev.yml down     # no -v
```

## Deploying to Railway

Five services. Two are built from this repo, three you provision.

| Service | Source | Target port | Volume |
|---|---|---|---|
| **Postgres** | Railway template | — | managed |
| **Redis** | Railway template | — | managed |
| **evolution** | image `evoapicloud/evolution-api:v2.3.7` | 8080 | `/evolution/instances` |
| **pocketbase** | this repo, root directory `services/pocketbase` | 8090 | `/pb_data` |
| **web** | this repo, root directory `/`, Dockerfile path `apps/web/Dockerfile` | 3000 | — |

The web service builds from the **repo root**, not `apps/web` — the lockfile and
workspace manifest live there. Set its Dockerfile path rather than its root
directory.

> **The volumes are not optional.** Without `/evolution/instances`, every deploy
> unpairs every WhatsApp account and forces a fresh QR scan on each one. Without
> `/pb_data`, you lose all users, connected accounts and tokens.
>
> Attach them in each service's settings. Railway rejects a `VOLUME` instruction
> in a Dockerfile — *"docker VOLUME at Line N is not supported, use Railway
> Volumes"* — so neither image declares one, and nothing warns you at deploy
> time if you forget.

### Pin the ports

**Railway injects `PORT` (8080 by default) into every service, and both images
follow it.** So a service listens on Railway's port, not on the default in its
Dockerfile — point another service at the wrong one and you get `ECONNREFUSED`
from a hostname that resolves perfectly well.

Set these explicitly so nothing depends on Railway's default:

| Service | Variable |
|---|---|
| pocketbase | `PORT=8090` |
| evolution | `SERVER_PORT=8080` (Evolution reads this, not `PORT`) |
| web | nothing — it is the public service, let Railway assign it |

Then the internal URLs below match, and each service's target port matches the
table above.

### Environment

Use Railway's variable references (`${{Service.VAR}}`) so a rotated secret
propagates instead of drifting out of sync.

**evolution**

```
SERVER_PORT=8080
SERVER_URL=https://<evolution-domain>
AUTHENTICATION_API_KEY=<openssl rand -hex 16>
DATABASE_PROVIDER=postgresql
DATABASE_CONNECTION_URI=${{Postgres.DATABASE_URL}}?schema=public
DATABASE_CONNECTION_CLIENT_NAME=evolution_exchange
DATABASE_SAVE_DATA_INSTANCE=true
DATABASE_SAVE_DATA_NEW_MESSAGE=true
DATABASE_SAVE_MESSAGE_UPDATE=true
DATABASE_SAVE_DATA_CONTACTS=true
DATABASE_SAVE_DATA_CHATS=true
DATABASE_SAVE_DATA_HISTORIC=true
CACHE_REDIS_ENABLED=true
CACHE_REDIS_URI=${{Redis.REDIS_URL}}/6
CACHE_REDIS_PREFIX_KEY=evolution
CACHE_LOCAL_ENABLED=false
WEBHOOK_GLOBAL_ENABLED=true
WEBHOOK_GLOBAL_URL=https://<web-domain>/api/webhook/evolution
WEBHOOK_GLOBAL_WEBHOOK_BY_EVENTS=false
WEBHOOK_EVENTS_CONNECTION_UPDATE=true
WEBHOOK_EVENTS_MESSAGES_UPSERT=true
TELEMETRY_ENABLED=false
```

The `DATABASE_SAVE_DATA_*` flags are what populate the dashboard counts and make
`list-chats` and `read-messages` return anything. Turn them off and those tools
go quiet.

`DATABASE_SAVE_DATA_HISTORIC` is the odd one out: the others cover live traffic,
that one covers the history WhatsApp hands over *once*, when a number is paired.
Evolution checks it in the `messaging-history.set` handler and silently drops the
whole payload if it is false — with no way to ask for the history again short of
disconnecting and re-scanning the QR. See "Importing existing history" below.

**web** — internal addresses for the backends, public URLs for anything a user sees:

```
NUXT_POCKETBASE_URL=http://pocketbase.railway.internal:8090   # matches PORT=8090 above
NUXT_POCKETBASE_ADMIN_EMAIL=<you>
NUXT_POCKETBASE_ADMIN_PASSWORD=<generate>
NUXT_EVOLUTION_URL=http://evolution.railway.internal:8080    # matches SERVER_PORT above
NUXT_EVOLUTION_ADMIN_KEY=${{evolution.AUTHENTICATION_API_KEY}}
NUXT_WEBHOOK_URL=https://<web-domain>/api/webhook/evolution
NUXT_WEBHOOK_SECRET=<openssl rand -hex 32>
NUXT_PUBLIC_APP_URL=https://<web-domain>
```

`NUXT_PUBLIC_APP_URL` is what connector URLs are built from. Get it wrong and
every token you hand out points at the wrong host.

`NUXT_EVOLUTION_ADMIN_KEY` is the most sensitive value in the deployment: it can
create, read and delete every user's WhatsApp connection.

### First run

Nothing to do. Set `NUXT_POCKETBASE_ADMIN_EMAIL` and
`NUXT_POCKETBASE_ADMIN_PASSWORD` on the **pocketbase** service as well as the web
service — to the same values — and its entrypoint upserts the superuser on every
boot. The schema needs no action either; `pb_migrations/` is baked into the image
and applied at startup.

Both variables must match across the two services: the web server signs in with
them to read hidden fields and the admin-only collections. A Railway variable
reference (`${{pocketbase.NUXT_POCKETBASE_ADMIN_EMAIL}}`) keeps them in step.

Because the upsert runs every boot, rotating the password is editing the variable
on both services and redeploying. Look for `[entrypoint] superuser ready:` in the
pocketbase logs to confirm.

That account can read every user's Evolution API key. Give it a long password —
PocketBase's CLI will accept a short one without complaint, though the entrypoint
warns.

Then open the web service's domain and sign up.

### Notes

- **Do not ship a `.env`.** It is gitignored, and Railway variables replace it.
- **`host.docker.internal` does not exist here.** The webhook uses the public
  HTTPS URL instead, which is the only thing that differs between dev and prod —
  and it differs by configuration, not code.
- Both containers bind `::`, which accepts IPv4 and IPv6. Railway environments
  created before 16 October 2025 route the private network over IPv6 only, where
  binding `0.0.0.0` is unreachable internally.
- `docker-compose.dev.yml` is for local development only. Nothing in it is used
  by Railway.

## Editor

`.zed/` ships tasks (`services: up`, `web: dev`, `mcp: inspector`, …) and language
server settings. Install the **Vue** extension in Zed for `vue-language-server`;
TypeScript uses the bundled `vtsls`, pointed at `apps/web/node_modules/typescript`
because pnpm does not hoist.
