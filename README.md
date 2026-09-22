# claude-whatsapp-mcp

A Nuxt app that serves two surfaces from one Nitro server:

1. **Web UI** — users create *connections* and mint connector tokens for them.
2. **MCP endpoint** — Claude connects to `/mcp` as a custom connector.

A connection is one of three kinds, and a connector token reaches exactly one
connection:

- **WhatsApp**, through [Evolution API](https://doc.evolution-api.com/). Paired
  by QR. Uses the Evolution server this app is configured with, or one the user
  supplies.
- **Telegram**, through the Telegram bridge in `apps/telegram-bridge`. A
  personal account linked by QR code, its chats synced into Postgres. Uses the
  bridge this app is configured with, or one the user supplies. See "Telegram
  connections".
- **PostgreSQL**, through a connection string the user supplies. Read-only
  unless a token is explicitly granted the write tool.

PocketBase is the app's own database (users, sessions, connections and their
credentials). Evolution API, its Postgres and its Redis are dependencies you run
**only if you want WhatsApp connections** — they sit behind a compose profile,
and `NUXT_EVOLUTION_URL` / `NUXT_EVOLUTION_ADMIN_KEY` are optional. If you do
want them, `NUXT_EVOLUTION_DATABASE_URL` is **required** — both WhatsApp read
tools go through it. See "Reading and searching messages". The Telegram bridge
is the same kind of dependency: run it **only if you want Telegram
connections**, and every `TELEGRAM_*` / `NUXT_TELEGRAM_*` variable is optional
until you do.

> **Status.** Sign-up, all three connection kinds (WhatsApp paired by QR with
> its history imported, Telegram linked by QR with its chats synced, Postgres by
> connection string), the per-connection dashboard, and connector token
> provisioning with per-chat and per-table scoping all work. Fifteen MCP tools,
> five per kind — see "MCP tools". A WhatsApp or Telegram connection that drops
> emails the people who use it, and emails them again when it comes back — see
> "Connection alerts".

## Layout

```
apps/web/                    Nuxt 4 + TypeScript. Own Dockerfile, built from the repo root.
apps/telegram-bridge/        Node + teleproto. Links Telegram accounts, syncs chats to Postgres.
                             Own Dockerfile, built from the repo root.
  app/pages/                 login, signup, instances/{index,new,[id]}
  app/components/            app components + ui/ (shadcn-vue)
  app/composables/           session, connection state, token scope, API actions
  modules/                   local Nuxt modules (registers /mcp/:token)
  shared/                    types used by both the app and the server
  server/api/                auth, instances, tokens, Evolution and Telegram webhooks
  server/mcp/index.ts        MCP handler + auth middleware
  server/mcp/tools/<group>/  one file per tool: whatsapp/, telegram/, sql/
  server/plugins/            token redaction, per-kind instructions, startup check
  server/utils/              PocketBase, auth, instances, tokens, Evolution client and
                             message database, mentions, outbound host guard,
                             keyed handle cache, row serialisation, SQL engine
                             seam, Postgres pool / plan guard / runner / catalog
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
pnpm services:up              # pocketbase only — enough for database connections
```

Only `NUXT_POCKETBASE_ADMIN_EMAIL` and `NUXT_POCKETBASE_ADMIN_PASSWORD` have to
be filled in for that to come up. If you want WhatsApp connections as well:

```bash
pnpm services:up:whatsapp     # + postgres, redis, evolution
```

For Telegram connections, fill in the Telegram section of `.env` first (your own
`api_id` / `api_hash` and two generated keys — see "Telegram connections"), then:

```bash
pnpm services:up:telegram     # + postgres, telegram-bridge
```

Postgres, Redis and Evolution sit behind a `whatsapp` compose profile because
they exist only to serve WhatsApp connections; Postgres and the bridge sit behind
`telegram`. `services:down`, `:logs` and `:ps` always pass both profiles, so they
cover everything either way.

The PocketBase superuser is created for you from `NUXT_POCKETBASE_ADMIN_EMAIL`
and `NUXT_POCKETBASE_ADMIN_PASSWORD` — the container upserts it on every boot, so
there is no manual step and changing the password is just editing `.env` and
restarting.

Then start Nuxt **on the host** (it is deliberately not in compose, so you keep HMR):

```bash
pnpm dev                      # http://localhost:3000
```

Admin UI: <http://localhost:8090/_/> · Evolution (WhatsApp profile): <http://localhost:8080> · Telegram bridge (Telegram profile): <http://localhost:8095/health> · Nuxt: <http://localhost:3000>

There is no `predev` hook — bring the services up yourself.

### Scripts

| | |
|---|---|
| `pnpm dev` | Nuxt dev server on the host |
| `pnpm build` / `pnpm preview` | production build / serve it |
| `pnpm typecheck` | `nuxt typecheck` across app + server — the only automated check |
| `pnpm services:up` | PocketBase only |
| `pnpm services:up:whatsapp` | + Evolution, its Postgres and Redis |
| `pnpm services:up:telegram` | + Postgres and the Telegram bridge |
| `pnpm services:down` / `:logs` / `:ps` | the whole stack, profiles included |
| `pnpm bridge:dev` | the Telegram bridge on the host instead of in compose |
| `pnpm bridge:typecheck` | `tsc` for the bridge — `pnpm typecheck` does not cover it |

## Networking

Traffic crosses the host/container boundary in both directions.

| From | To | Address |
|---|---|---|
| Nuxt (host) | Evolution | `http://localhost:8080` |
| Nuxt (host) | PocketBase | `http://localhost:8090` |
| Nuxt (host) | Evolution's Postgres | `localhost:5432` (read-only role, see below) |
| Nuxt (host) | Telegram bridge | `http://localhost:8095` |
| Evolution (container) | Nuxt webhook | `http://host.docker.internal:3000/api/webhook/evolution` |
| Telegram bridge (container) | Nuxt webhook | `http://host.docker.internal:3000/api/webhook/telegram` |

Postgres (`5432`), Redis (`6379`), Evolution (`8080`) and the Telegram bridge
(`8095`) publish on `127.0.0.1` only: their dev credentials have defaults, and between them they hold — and can
send from — every paired account. PocketBase publishes `8090` on every
interface.

`host.docker.internal` is not resolvable in Linux containers by default, so the
evolution and telegram-bridge services declare
`extra_hosts: ["host.docker.internal:host-gateway"]`. The firewall rule below
covers both, since they share the compose subnet and the port.

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
| Backend client | `evolutionClientForInstance(instance)` / `pgFor(instance)` | `useEvolutionClient()` / `pgFor(instance)` |
| On failure | 401 JSON | **401 + `WWW-Authenticate`** — never 200 |

`server/middleware/session.ts` returns early on `/mcp`, so cookies are never even
parsed there. `useEvolutionClient()` (used by tools) reads `event.context.mcpAuth`,
has no code path to the session user, and refuses a connection that is not a
WhatsApp one.

The MCP token is minted by this app — it is **not** Evolution's `apikey`. Only its
SHA-256 hash is stored, in the superuser-only `mcp_tokens` collection, alongside
`last_used_at` and `expires_at`. It resolves to one row in `instances` — the
connection — which holds that connection's credentials server-side: an Evolution
token for WhatsApp, a connection string for Postgres.

**This deployment's Evolution global key never reaches a user record.** It is
used only to create and delete instances on this deployment's server
(`server/utils/instances.ts`). Every other call uses the per-instance token
Evolution issues at create time, which Evolution itself scopes to that one
instance. There is deliberately no fallback from a missing per-instance key to
the global one — that would hand any token holder access to every user's
account. A bring-your-own connection stores *its own* server's global key on its
row, hidden, for the same two operations against that server only. Neither key
is ever sent to the other's server.

A PocketBase outage answers **503**, not 401 — a 401 would tell a client its
valid token had been revoked and invite it to throw the token away.

Tokens never reach logs or error bodies: `server/plugins/redact-mcp.ts` scrubs
`/mcp/<token>` to `/mcp/[redacted]` at the source (`event.node.req.originalUrl`,
which is what Nitro's error handler reads). Route any error reporter you add
through `redactPath` / `redactHeaders` in `server/utils/redact.ts`.

### Using it

1. Sign up at <http://localhost:3000>.
2. Create a connection: pick **WhatsApp account**, **Telegram account** or
   **PostgreSQL database**, and name it.
3. **WhatsApp:** continue to the QR code and scan it — WhatsApp → Settings →
   Linked devices → Link a device. To use an Evolution server other than this
   app's, tick **Use my own Evolution API server** first (see "Bring your own
   Evolution server").
   **Telegram:** on the connection's page press **Show QR code** and scan it —
   Telegram → Settings → Devices → Link Desktop Device. An account with two-step
   verification is then asked for its password, which goes to Telegram and is
   stored nowhere. Chats start syncing as soon as it links.
   **Postgres:** paste a connection string. It is proved by connecting before
   anything is saved (see "Database connections").
4. On the connection's dashboard, create a **New connector token**: a name, an
   expiry (30 days, 90 days — the default — 1 year, or never) and a scope.
5. Add it to Claude. The **How to connect** dialog has the steps for Claude.ai
   (Settings → Connectors → Add custom connector), Claude Code
   (`claude mcp add --transport http <name> <url>`), clients that send an
   `Authorization: Bearer` header, and the MCP Inspector.

**One connection per connector.** A token is bound to the connection it was
created on, so no tool takes a connection argument, and Claude cannot address the
wrong number or the wrong database. Connect several and give each its own token.

### MCP tools

Every tool is gated twice: by the connection's kind — a Postgres token never sees
a WhatsApp tool, whatever its scope — and by the token's scope. The server also
sends per-kind instructions telling the model how to page and how to read what
comes back.

| Tool | Kind | | What it does |
|---|---|---|---|
| `get-connection-status` | WhatsApp | read | Whether the account is paired and connected (`open`) |
| `list-chats` | WhatsApp | read | Conversations in scope, most recently active first, with the `jid` other tools take; says `hasMore` when it returned one page of several |
| `read-messages` | WhatsApp | read | One chat, newest first, 1–200 per page (default 50), optional `since` / `until`; reports `hasMore`, `nextPage`, `covered` and `totalMatching` |
| `search-messages` | WhatsApp | read | Messages containing every word of `query`, across chats in scope or one `jid`; optional date range and `fromMe`; up to 100 matches (default 20) |
| `send-text-message` | WhatsApp | **write** | Send text to a number in international format |
| `get-telegram-status` | Telegram | read | Whether the account is linked and online, who it is signed in as, and how far sync has got |
| `list-telegram-chats` | Telegram | read | Synced chats in scope — private, groups, supergroups, channels — most recently active first, with the `chatId` other tools take |
| `read-telegram-messages` | Telegram | read | One chat, newest first, with the same paging envelope as `read-messages`; optional forum `topicId`; says when older history was never synced |
| `search-telegram-messages` | Telegram | read | Messages containing every word of `query` (text and captions), across chats in scope or one `chatId` |
| `send-telegram-message` | Telegram | **write** | Send plain text to a `chatId` or an @username |
| `get-database-info` | Postgres | read | Server version, database, connecting role, and what this token is scoped to |
| `list-tables` | Postgres | read | Tables in scope, filterable by schema and name, paged (1–500, default 100) |
| `describe-table` | Postgres | read | Columns, keys, constraints, indexes and comments for one table |
| `run-query` | Postgres | read | One `SELECT` / `WITH` / `VALUES` / `TABLE` in a read-only transaction; stops at `maxRows` (≤ 1000, default 200); 10 s timeout by default, 30 s max |
| `run-statement` | Postgres | **write, destructive** | One `INSERT` / `UPDATE` / `DELETE` / `MERGE`; rolled back whole if it would change more than `maxRows` (default 100); no `WHERE` refused without `allowWholeTable`; 15 s timeout by default, 60 s max |

`read-messages` and `search-messages` leave reactions out unless called with
`includeReactions: true`, and say so with `reactionsExcluded`.

### Scoping a token

A token is narrowed on independent axes, set when it is created and editable from
the connection's dashboard. Which axes appear depends on the kind:

- **Actions** (both kinds) — all tools, or a chosen few, listed from the
  connection's own kind. Enforced by refusing to register the others for that
  request, so a tool outside scope is not merely hidden from the tool list:
  calling it fails. A new Postgres token starts read-only — the read tools
  ticked, `run-statement` not.
- **Chats** (WhatsApp) — all conversations, or an allowlist. `list-chats` returns
  only allowed conversations; `read-messages` and `send-text-message` refuse
  anything else, naming the chat so the assistant can explain why.
  `search-messages` does both: asked for a chat outside scope it refuses by name,
  while an unrestricted search is narrowed to the allowed chats — out-of-scope
  messages are excluded by the query itself, not filtered out after being read.
- **Tables** (Postgres) — every table the connecting role can read, or an
  allowlist. `list-tables` and `describe-table` apply it in their own SQL, so a
  table outside it is neither listed nor described. `run-query` and
  `run-statement` check the statement's query plan before a row is read and
  refuse anything that touches a table outside it. Names match case-sensitively
  (`public.Orders` is not `public.orders`), and allowing a partitioned table
  allows its partitions. What this does and does not protect against is in
  "Database connections".

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
stays available while an account is disconnected or a database is unreachable.

Inspect the endpoint by hand with:

```bash
pnpm dlx @modelcontextprotocol/inspector
```

Point it at `http://localhost:3000/mcp/<token>`, or at `http://localhost:3000/mcp`
with an `Authorization: Bearer <token>` header.

### Reading and searching messages

`NUXT_EVOLUTION_DATABASE_URL` is **required** for accounts on this deployment's
Evolution server. Both `read-messages` and `search-messages` read Evolution's
Postgres directly, and neither can answer without it — pairing, `list-chats` and
`send-text-message` still work, and the app says so once at startup. It is the one
part of this app that does not go through the Evolution API, for two separate
reasons.

**Searching.** Evolution 2.3.7 cannot search message content. `POST
/chat/findMessages` accepts a `where.message` — its request schema even documents
the field — and then never reads it, so a content search comes back as an
unfiltered page that looks like a result set. The only filters it honours are
`id`, `source`, `messageType`, a `messageTimestamp` range, and
`key.{id,remoteJid,fromMe,participant}`. Reading the database instead also reaches
text WhatsApp stores a level or two down — an album item's caption under
`associatedChildMessage`, an edit's new wording under
`protocolMessage.editedMessage` — which no top-level extractor could see.

**Reading.** Evolution stores a message more than once. Its history import
deduplicates against an in-memory set of message ids rebuilt at the start of each
batch, and the `createMany` behind it asks to skip duplicates — which does
nothing, because the only unique constraint on `Message` is a generated primary
key that cannot collide. So two batches in flight together, or an import racing
live traffic, both insert; re-pairing an account is what puts them in flight. The
copies disagree about who sent the message, because each carries whatever push
name was on the wire at the time — a real name, a bare LID, or the sender's own
device-locale word for themselves. Left alone, one message is three, a five-day
range reports triple the messages it holds, and pages come back ragged. The
endpoint cannot fix it: it pages with `skip`/`take` over the duplicate rows, so
the page boundaries are already wrong by the time anything could collapse them.
`DISTINCT ON (key->>'id')` before `LIMIT` is the fix, and that means SQL.

Reactions are dropped in the same query, on the payload rather than on
`messageType`. WhatsApp's own control records cannot be — `messageType` carries no
subtype, and excluding `protocolMessage` wholesale would delete every message edit
along with the bookkeeping — so those are dropped after the rows are read and
counted back to the caller as `protocolMessagesExcluded`.

**Give it a role that can do nothing else.** Every other credential in this app is
scoped to a single account; this connection can reach every user's messages in
every instance. The app never writes and never runs DDL, so the one grant below
serves both reading and searching:

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
`messageTimestamp`, none on the `key` JSONB — so reading and searching are both a
sequential scan within one account. History import makes that corpus much larger than it would
otherwise be: a number with years of conversations arrives all at once at
pairing, rather than accumulating. The queries carry a 10-second
`statement_timeout` so a slow scan surfaces as an error instead of a hung MCP
call. Once a scan starts timing out, add (as a Postgres superuser, not as the
app):

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS message_instance_ts_idx
  ON "Message" ("instanceId", "messageTimestamp" DESC);
```

Worth knowing before you go looking for a bug:

- Both cover whatever Evolution holds: the history imported at pairing plus
  everything since. An account paired before full-history sync was turned on has
  only what arrived after — see "Importing existing history".
- Reads are deduplicated by message id, so `totalMatching` counts distinct
  messages and can be quoted as an answer. It will often be smaller than the row
  count Evolution's own API reports for the same range. The two are not
  comparable, and the smaller one is the true one.
- **The dashboard's chat count and `list-chats` count different things.** The
  count is every conversation the phone listed at pairing; `list-chats` lists
  conversations Evolution holds messages for, which is routinely fewer. The gap
  is not more pages — `hasMore` is the only signal that there are.
- The scope editor lists the tools of the connection's own kind, and lists both
  read tools whether or not the database URL is set. It deliberately does not
  hide a tool with an unmet prerequisite: both read tools need that URL, so
  hiding one would leave a scope editor that disagrees with the tool list a
  client actually sees. An unset URL is reported at startup instead.
- **A connection on your own Evolution server needs its own database URL.** This
  variable names one database — the one belonging to the Evolution server this
  app is configured with — and a bring-your-own connection's messages live in
  that server's database instead. Supply it when creating the connection, or from
  its dashboard afterwards (**Enable reading**); it is stored on the connection,
  not here. Until then reads answer 501 naming the missing setting rather than
  matching nothing and reporting an empty conversation. Pairing, chat listing and
  sending never need it.

  Same shape of role as above, in *your* database:

  ```sql
  CREATE ROLE evo_reader LOGIN PASSWORD 'change-me';
  GRANT CONNECT ON DATABASE evolution TO evo_reader;
  GRANT USAGE ON SCHEMA public TO evo_reader;
  GRANT SELECT ON "Message" TO evo_reader;
  ```

  It is checked before it is stored — including that `"Message"` is actually
  readable, because a URL that connects to the *wrong* database is otherwise
  indistinguishable from an account with no messages.

On Railway, Evolution's Postgres is its own service — use its private URL, and
note the port there is whatever that service actually listens on (see "Pin the
ports").

### Database connections

A user pastes a PostgreSQL connection string; nothing is provisioned. The DSN is
proved by connecting *before* the row is written, so a typo is a failed create
rather than a connection that fails every later tool call. **Change connection
string** on the dashboard is checked the same way, and does not invalidate
tokens: they name the connection, not the credential, so rotating a password
never means reissuing them.

**Give it a role that can do only what you need.** A connector token can be
scoped to specific tables, and every statement is checked against the query plan
before a row is read — but that keeps a *model* inside the tables you chose, and
it is not a boundary against a determined caller holding a leaked token. Three
things it cannot see: what a database trigger does, what a user-defined
function's body reads (which is why calls outside `pg_catalog` are refused
outright), and anything at all if the role is a superuser. The app warns when the
connecting role is a superuser. The boundary is the role:

```sql
CREATE ROLE claude_reader LOGIN PASSWORD 'change-me';
GRANT CONNECT ON DATABASE mydb TO claude_reader;
GRANT USAGE ON SCHEMA public TO claude_reader;
GRANT SELECT ON public.customers, public.invoices TO claude_reader;
```

Then use `postgres://claude_reader:change-me@host:5432/mydb` as the connection
string. For a token that should also write, grant the specific
`INSERT`/`UPDATE`/`DELETE` you intend and tick the write action when minting it —
it is off by default.

What the checks do enforce, on every statement:

- **One statement.** Sent over the extended protocol, where Postgres itself
  refuses anything after a `;`.
- **Only tables in scope.** Read off `EXPLAIN (FORMAT JSON, VERBOSE)` — never
  `EXPLAIN ANALYZE`, which would execute it — inside the same transaction as the
  statement, so a view cannot be repointed between the check and the run.
- **No functions that reach outside the query.** Calls are resolved against
  `pg_proc` from both the statement text and the plan. Anything outside
  `pg_catalog`, anything `SECURITY DEFINER`, and a denylist of builtins such as
  `pg_read_file`, `lo_import`, `dblink` and `pg_sleep` are refused. The text is
  scanned *before* `EXPLAIN` because Postgres folds an `IMMUTABLE` function with
  constant arguments during planning, leaving only its result in the plan.
- **Writes only through `run-statement`**, and only `INSERT`/`UPDATE`/`DELETE`/
  `MERGE`. DDL, `TRUNCATE`, `COPY` and `CREATE TABLE AS` are refused, and
  `run-query` runs in a read-only transaction.
- **Bounded writes.** A statement that would change more rows than its `maxRows`
  is rolled back whole, and an `UPDATE` or `DELETE` with no `WHERE` needs
  `allowWholeTable: true`.

**Outbound host guard.** A connection string is an address a user chose, so by
default this server refuses one that resolves to a private or loopback address:
without that, `postgres://…@postgres:5432/evolution` pasted into the form reaches
this deployment's own database, which holds every user's messages. Set
`NUXT_ALLOW_PRIVATE_TARGETS=true` for local development and single-tenant
self-hosting — `.env.example` sets it; the app defaults to off — and leave it off
for anything shared. Independently of that setting, a target resolving to this
deployment's own PocketBase, Evolution or Evolution database is always refused.

The guard runs whenever a connection is opened, not only when it is saved, so
turning the setting off stops existing connections to private addresses. The
approved address is pinned, so the driver cannot resolve the name to somewhere
else afterwards — except for an IPv6 address, which is checked but not pinned.

### Bring your own Evolution server

A WhatsApp connection can be created against a user's own Evolution server: the
create form takes the base URL and that server's `AUTHENTICATION_API_KEY`, and
the app provisions an instance on it exactly as it does on the default server.
Both halves or neither — half a configuration is never completed from this
deployment's own, because sending our global key to a server someone else
controls would hand them every account on ours.

With `NUXT_EVOLUTION_URL` and `NUXT_EVOLUTION_ADMIN_KEY` unset there is no
default server, and supplying one becomes required to create a WhatsApp
connection. Everything else in the app still works.

Server URLs are compared by origin, so a trailing slash on `NUXT_EVOLUTION_URL`
does not reclassify this deployment's own connections as bring-your-own. If a
connection's server has no global key available any more — the variables were
unset, or the row no longer matches the configured server — deleting it still
removes the row and its tokens, and logs the instance left behind on that server.

### Adding tools

Drop a file in `apps/web/server/mcp/tools/<group>/` — it is discovered
automatically — and define it with `defineKindTool` from
`server/utils/mcp-kind-tool.ts` rather than `defineMcpTool` directly:

```ts
export default defineKindTool({
  name: 'my-tool',
  kind: 'postgres',
  title: 'Shown in client UI',
  description: 'Written for the model.',
  annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: { /* zod shape */ },
  handler: async (args) => { /* … */ },
})
```

`kind` sets the tool's `group` and its `enabled` gate, so it registers only for a
connection of that kind and only for a token whose scope allows it. Declaring the
kind once is what makes a WhatsApp tool unreachable from a Postgres token. An
optional `available()` adds a deployment-level prerequisite.

`kind` also takes an **array**, for a tool that means exactly the same thing on
more than one kind — the `sql/` set, where the engine behind the call is absorbed
by `server/utils/sql-engine.ts` and anything a model needs to know about the
difference is in that kind's `instructions`. A multi-kind tool must state its
`group` too, since there is no single kind to infer it from. Do **not** use it to
share a tool whose arguments differ: that is why Telegram has
`read-telegram-messages` rather than a second kind on `read-messages`.

Keep the basename globally unique: collisions are detected across groups, and two
tools with one name make the MCP server throw. One shared file for several kinds
satisfies that rather than straining it. Give every tool an explicit
`name`, a `title` and accurate `readOnlyHint` / `destructiveHint`; see
`whatsapp/get-connection-status.ts` (read) and `sql/run-statement.ts`
(write) for the pattern. `enabled` cannot see arguments, so anything that
depends on them belongs in the handler: enforce chat scope there if the tool
touches a conversation, and run SQL through `server/utils/sql-engine.ts`, which
dispatches to the engine's runner and applies the table checks. Existing scoped
tokens will not be granted the new tool — they list the tools they were given, so
new tools are denied by default.

Tool handlers get the MCP SDK's `RequestHandlerExtra`, not an H3 event, so
credentials are reached through `useMcpAuth()`, `useEvolutionClient()` and
`pgFor()`, which all go through `useEvent()`. That is why
`nitro.experimental.asyncContext` is enabled in `nuxt.config.ts` — do not turn it off.

## Telegram connections

`apps/telegram-bridge` is to Telegram what Evolution is to WhatsApp: a separate
service that holds each linked account's session, keeps its chats in Postgres,
and answers the app over HTTP. Nothing off the shelf does this for a *personal*
account linked by QR code, so it lives in this repo. It is built on
[teleproto](https://www.npmjs.com/package/teleproto), the maintained GramJS fork.

> ⚠️ **Read Telegram's terms before offering this to anyone.** Telegram's API
> Terms of Service and its content-licensing terms forbid using data from the
> platform for artificial intelligence, with an exception only where everyone in
> a chat has consented. Accounts that sign in through unofficial clients are also
> watched more closely than official ones, and one that breaks the terms can be
> restricted or banned. This project ships the integration and does not make
> that risk go away.

### Setting it up

1. **Get your own API credentials** at <https://my.telegram.org> → API
   development tools, and put them in `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`.
   Never reuse a pair from an example or another project — Telegram refuses
   published ones.
2. **Generate the two keys:** `TELEGRAM_BRIDGE_ADMIN_KEY` (`openssl rand -hex
   24`) and `TELEGRAM_SESSION_ENCRYPTION_KEY` (`openssl rand -hex 32`). Set
   `NUXT_TELEGRAM_ADMIN_KEY` to the same value as the admin key.
3. **Point the app at it:** `NUXT_TELEGRAM_URL` and
   `NUXT_TELEGRAM_DATABASE_URL`. `.env.example` has working development values.
4. `pnpm services:up:telegram`, restart `pnpm dev`, and create a **Telegram
   account** connection. Until `NUXT_TELEGRAM_URL` and `NUXT_TELEGRAM_ADMIN_KEY`
   are both set, creating one is refused with "No Telegram bridge is available"
   unless the user supplies their own bridge.

**The encryption key is the most sensitive value the bridge has.** Every stored
session is sealed with it, and each session is full access to that Telegram
account. Losing or changing it unlinks every account; leaking it together with a
database backup hands every account over.

### Where the data lives

In the **same Postgres database Evolution uses**, in its own `telegram` schema.
The bridge creates the schema and its tables on first start and never touches
`public`, where Evolution's tables are, so the two cannot collide. On Railway that
means one Postgres service for both.

The bridge connects with the database's owner credential — the same URL
Evolution has. That is a deliberate trade for a simpler setup: the credential can
read every WhatsApp message in that database, so a compromised bridge is a
compromised Evolution. If you want the app to read Telegram data with less, create
a role with `LOGIN` and nothing else, set `TELEGRAM_READER_ROLE` to its name on
the bridge (it re-grants `SELECT` on synced data, column by column, at every
start — never on sessions, access hashes or phone numbers), and use that role in
`NUXT_TELEGRAM_DATABASE_URL`.

### What syncs

Private chats, bots, groups, supergroups (including forum topics) and channels —
live, plus older history fetched in the background. Edits replace the message
text, reactions are counted on the message, and a deleted message loses its
text rather than staying readable.

Backfill is **slow on purpose**: one page of 100 messages at a time with a pause
between pages, newest chats first, stopping at `TELEGRAM_BACKFILL_MAX_PER_CHAT`
messages or `TELEGRAM_BACKFILL_DAYS` days per chat, and skipping broadcast
channels unless `TELEGRAM_BACKFILL_BROADCAST=true`. An unofficial client that
hammers history is how an account gets restricted. The read tools say when a
chat's history stops at what was synced rather than at its first message.

**Secret chats are never visible.** They exist only on the devices that took
part in them and cannot be synced by any client.

**Unlinking deletes the synced chats**, whether through **Unlink** on the
dashboard or by deleting the connection. A session ended from Telegram → Devices
keeps them, because the likeliest next step is linking the same account again.

### One bridge process at a time

Two processes using the same Telegram session make Telegram kill it, which costs
a QR scan. The bridge takes a Postgres advisory lock per session, so a second
process waits rather than connecting, and takes the session over within about 30
seconds of the first one stopping. Run it as **one instance**, and do not give it
a deployment overlap: while two copies run, the one without the lock reports those
connections as held elsewhere. A short overlap is harmless — alerts wait ten
minutes for that state — but it buys nothing.

### Bring your own bridge

Like Evolution, a user can tick **Use my own Telegram bridge** and give its URL,
admin key and, optionally, a database URL for reading its chats. The URL passes
the same outbound host guard as a user's Evolution server, this deployment's
admin key is never sent to it, and theirs is never sent to ours.

### Developing against Telegram's test servers

`TELEGRAM_TEST_SERVERS=true` points the bridge at Telegram's separate test
environment, where accounts use numbers of the form `99966XYYYY`. That
environment is separate from the real one: an account from one does not exist in
the other, so link a test bridge only from a test account.

## PocketBase schema

`users` holds accounts; an account can read only its own record. `instances`
holds one row per connection, with a `kind` of `whatsapp` or `postgres`:

- **WhatsApp** — the Evolution instance's `name` and `instance_id`, its
  `base_url`, and the per-instance `api_key`. A bring-your-own connection also
  carries its server's `admin_key` and, once supplied, `evolution_db_url`.
- **Postgres** — the `dsn`, plus `db_host`, `db_port` and `db_database` for
  display. Those four are shared by every database kind rather than named for
  one engine; nothing connects through the display three, and each engine's DSN
  parser refuses the other engines' schemes.

`mcp_tokens` holds hashed connector tokens — `token_hash`, `label`,
`last_used_at`, `expires_at`, `revoked` and six scope columns — each bound to one
instance and cascade-deleted with it; instances cascade with their user.
`instances` and `mcp_tokens` are superuser-only — the browser never talks to
PocketBase, so the session cookie is `httpOnly` and every read goes through a
Nuxt route.

Two more columns on `instances` carry outage state — `down_since` and
`alerted_at`, both dates, both written only by the server. See "Connection
alerts".

`api_key`, `admin_key`, `dsn` and `evolution_db_url` are `hidden` fields: absent
from every API response, including to the owning user, but **not encrypted** —
they sit in clear in `pb_data` and in every backup. So is the SMTP password, and
for the same reason: PocketBase encrypts its settings only when
`PB_ENCRYPTION_KEY` is set.

`pb_hooks/mail.pb.js` is the one hook file. It applies the SMTP settings from the
environment at boot and registers `POST /api/app/send-email`, superuser-only —
PocketBase has no generic send-email endpoint of its own, only the auth-flow
ones.

`services/pocketbase/pb_migrations/` is committed and is the source of truth.
`pb_migrations/` and `pb_hooks/` are bind-mounted, so schema changes you make in
the admin UI are written straight back into the working tree — commit them. A
PocketBase restart is what applies new migration files.

Restarting PocketBase also rotates the superuser's token key (the entrypoint's
`superuser upsert` does that). The app notices the rejected token, signs in again
and retries once, logging `superuser token rejected … re-authenticating and
retrying once` — expected after a restart, not a fault.

`pb_data/` is gitignored runtime state. The container runs as root, so on Linux
the directory ends up root-owned; remove it through a container:

```bash
docker compose -f docker-compose.dev.yml stop pocketbase
docker run --rm -v "$PWD/services/pocketbase:/x" alpine:3.22.5 rm -rf /x/pb_data
docker compose -f docker-compose.dev.yml up -d pocketbase
```

That resets everything, including the superuser, and re-applies every migration.

## Connection alerts

A WhatsApp or Telegram connection that stops working emails everyone who can
reach it, and emails them again once it recovers. Always on, no setting; it needs SMTP
configured on the pocketbase service (`PB_SMTP_*`) and nothing else.

The same SMTP settings deliver organization invitations: the invitation-link
dialog has **Send invite email**, and each pending invitation has **Resend
email**, which replaces the old link with a new one. Without SMTP both answer
with an error and the link can still be copied by hand.

**Who gets it:** every admin of the owning organization, plus the members the
connection is assigned to — the same set that can reach it in the app, decided by
the same predicate. One message each rather than one message addressed to all of
them, so nobody's alert discloses the roster. The two roles get different advice:
reconnecting and re-pairing are management, so a member is told what happened and
that an admin can fix it rather than being sent to press a button they do not
have.

Two things feed it, and they are not redundant.

| | What it catches | Latency |
|---|---|---|
| Per-connection webhook | logout, ban, session replaced, QR limit; for Telegram, any state change the bridge sees | seconds |
| Hourly sweep | everything, including a socket that died and never came back, and a Telegram bridge that is down | up to an hour |

The sweep is not a backstop for a flaky webhook. In Evolution 2.3.7 a close that
Evolution intends to **retry** emits no `connection.update` at all — it rebuilds
the socket and returns — so the failure worth catching most is the one the
webhook can never report. That is the same disagreement `sessionLost` is built
on: the stored column still says `open`, nothing live is behind it, and the
dashboard showed "Connected" for a week over a dead socket. Only a live read
finds it, and the sweep is what performs one.

Both paths end in the same function, and **neither trusts the webhook payload**.
Its `state` is never read. Evolution v2 does not sign deliveries, so the route is
reachable by anyone who knows the URL; a delivery means *look at this
connection*, and `GET /instance/connectionState` says what is actually true. A
forged post costs one rate-limited round-trip and can never produce an email.

What it will and will not send:

- A connection that has **never been paired** is skipped. A fresh instance sits
  in `close` until somebody scans its QR code, and `ownerJid` is the only thing
  that tells that apart from a logout.
- A live `close` mails immediately — Evolution only reports that once it has
  given up. `connecting` and `unknown` serve out a 10-minute grace period first,
  so a reconnect in progress or one failed status read stays quiet.
- One mail per outage. `alerted_at` is written only once a message actually went
  out, so a broken SMTP configuration delays an alert rather than losing it.
- The mail says which fix applies: a dropped session asks for **Reconnect**, an
  unlinked account asks for a QR scan. Sending someone to scan a code they did
  not need to costs a real phone.

**Telegram** follows the same rules, with four failures told apart:

| What happened | What the mail says |
|---|---|
| The connection to Telegram dropped | Press **Reconnect**; no scan |
| The session was ended from Telegram → Settings → Devices, or by Telegram | Link again by QR code; synced chats are kept |
| The bridge could not be reached | Nothing to scan; check the bridge service |
| Another bridge process holds the session | Nothing to scan; run the bridge as one instance |

A Telegram connection counts as linked from its first link until someone presses
**Unlink**. It keeps counting through a dropped connection or a revoked session,
so those alert, and an unlink closes an open outage without mailing anyone. A
bridge that cannot be reached is treated as an outage even for a connection that
was never linked, because the app cannot tell the two apart from outside.

The bridge posts to `/api/webhook/telegram` with the same `x-webhook-secret`, and
the route reads the live state back from the bridge before acting, exactly like
Evolution's. Deliveries go to `NUXT_TELEGRAM_WEBHOOK_URL` if it is set, and
otherwise to `NUXT_PUBLIC_APP_URL` + `/api/webhook/telegram` — so on Railway
there is nothing to set, and in development `.env.example` points it at
`host.docker.internal`.

The sweep runs in-process on the `alerts:sweep` scheduled task, so keep the web
service to a single replica or it mails twice. In development the tasks are
reachable by hand at `/_nitro/tasks/alerts:sweep`.

Registration is re-asserted on every sweep, which is what picks up a connection
created before this existed, or one whose Evolution server or Telegram bridge was
rebuilt. It uses the connection's own key, not a global one.

**Configuring SMTP also switches on PocketBase's own login alerts.** The web
server signs in as the superuser, so that account gets a "Login from a new
location" mail on roughly every restart. Turn the auth alert off on the
`_superusers` collection in the admin UI if the noise is not worth it — nothing
in this repo disables it for you.

To try it locally without a mail provider, point `PB_SMTP_HOST` at a catcher on
the compose network:

```bash
docker run -d --name wamcp-mailpit --network claude-whatsapp-mcp_app -p 8025:8025 axllent/mailpit:v1.21
# .env: PB_SMTP_HOST=wamcp-mailpit, PB_SMTP_PORT=1025, PB_SENDER_ADDRESS=alerts@automata.test
```

Then read what was sent at <http://localhost:8025>. `PB_SENDER_ADDRESS` has to be
a valid address — PocketBase rejects `alerts@localhost` and the hook logs
`[mail] WARNING: could not apply the SMTP settings`. The sweep can be triggered
by hand in development with `curl -X POST
http://localhost:3000/_nitro/tasks/alerts:sweep`.

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
turned on cannot be backfilled in place — **Import full history** on the
connection's dashboard sets the flag, signs the device out and puts the QR back
up; the import rides in on the re-scan. Nothing already stored is lost: Evolution
skips messages whose `key.id` it already has, so re-importing merges rather than
duplicates.

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

Up to six services. Three are built from this repo; Redis and evolution you
provision only for WhatsApp, the Telegram bridge only for Telegram, and Postgres
for either. A deployment that serves database connections alone is
**pocketbase** and **web**.

| Service | Source | Target port | Volume |
|---|---|---|---|
| **Postgres** *(WhatsApp or Telegram)* | Railway template | — | managed |
| **Redis** *(WhatsApp only)* | Railway template | — | managed |
| **evolution** *(WhatsApp only)* | image `evoapicloud/evolution-api:v2.3.7` | 8080 | `/evolution/instances` |
| **telegram-bridge** *(Telegram only)* | this repo, root directory `/`, Dockerfile path `/apps/telegram-bridge/Dockerfile` | 8095 | — |
| **pocketbase** | this repo, root directory `services/pocketbase` | 8090 | `/pb_data` |
| **web** | this repo, root directory `/`, Dockerfile path `apps/web/Dockerfile` | 3000 | — |

The web service and the Telegram bridge build from the **repo root**, not their
`apps/` directory — the lockfile and workspace manifest live there. Leave the root
directory at `/` and set the Dockerfile path. A root directory of
`/apps/telegram-bridge` fails the build with `"/pnpm-workspace.yaml": not found`.
If you use watch paths, the bridge needs `/apps/telegram-bridge/**` and
`/pnpm-lock.yaml`.

The bridge needs no volume: its sessions and chats are in Postgres.

> **The volumes are not optional.** Without `/evolution/instances`, every deploy
> unpairs every WhatsApp account and forces a fresh QR scan on each one. Without
> `/pb_data`, you lose all users, connections and tokens.
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
| telegram-bridge | `TELEGRAM_BRIDGE_PORT=8095` (it follows `PORT` only when this is unset) |
| web | nothing — it is the public service, let Railway assign it |

Then the internal URLs below match, and each service's target port matches the
table above.

### Environment

Use Railway's variable references (`${{Service.VAR}}`) so a rotated secret
propagates instead of drifting out of sync.

**evolution** *(WhatsApp only)*

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
WEBHOOK_GLOBAL_ENABLED=false
TELEMETRY_ENABLED=false
```

`WEBHOOK_GLOBAL_ENABLED=false` is deliberate. The app registers a webhook **per
connection** instead, and Evolution fires the global and per-instance deliveries
independently — so with both on, every event arrives twice. The global one also
sends no custom headers, so once `NUXT_WEBHOOK_SECRET` is set that copy 401s on
every event and is dropped rather than retried. Turning it back on buys no
coverage either: it never reached a connection on a user's own Evolution server.

The `DATABASE_SAVE_DATA_*` flags are what populate the dashboard counts and make
`list-chats` and `read-messages` return anything. Turn them off and those tools
go quiet.

`DATABASE_SAVE_DATA_HISTORIC` is the odd one out: the others cover live traffic,
that one covers the history WhatsApp hands over *once*, when a number is paired.
Evolution checks it in the `messaging-history.set` handler and silently drops the
whole payload if it is false — with no way to ask for the history again short of
disconnecting and re-scanning the QR. See "Importing existing history" above.

**telegram-bridge** *(Telegram only)*

```
TELEGRAM_BRIDGE_PORT=8095
TELEGRAM_API_ID=<from my.telegram.org>
TELEGRAM_API_HASH=<from my.telegram.org>
TELEGRAM_BRIDGE_ADMIN_KEY=<openssl rand -hex 24>
TELEGRAM_SESSION_ENCRYPTION_KEY=<openssl rand -hex 32>
TELEGRAM_BRIDGE_DATABASE_URL=${{Postgres.DATABASE_URL}}
```

The database URL is the same one Evolution uses; the bridge keeps to its own
`telegram` schema — see "Where the data lives". The backfill variables in
`.env.example` are optional. **Keep this service at one replica and leave
`RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` unset (it defaults to 0)** — see "One bridge
process at a time". Losing `TELEGRAM_SESSION_ENCRYPTION_KEY` unlinks every
account, so keep a copy somewhere other than Railway.

**pocketbase** — the superuser it upserts at boot, and the SMTP settings it sends
mail with. Both admin values must be identical to the web service's; use a Railway
variable reference so they cannot drift:

```
PORT=8090
NUXT_POCKETBASE_ADMIN_EMAIL=<you>
NUXT_POCKETBASE_ADMIN_PASSWORD=<generate>

# Mail. Optional — with PB_SMTP_HOST empty, connection alerts are computed and
# then not delivered.
PB_SMTP_HOST=<smtp host>
PB_SMTP_PORT=587
PB_SMTP_USERNAME=<username>
PB_SMTP_PASSWORD=<password>
PB_SMTP_TLS=false          # false = STARTTLS on 587; true = implicit TLS on 465
PB_SMTP_AUTH_METHOD=PLAIN  # or LOGIN
PB_SENDER_ADDRESS=<a from address the provider will accept>
PB_SENDER_NAME=Automata MCP
```

The SMTP values are applied on every boot by `pb_hooks/mail.pb.js`, so changing
one is a redeploy rather than a click through the admin UI — look for `[mail]
SMTP configured from the environment` in the logs. `PB_SENDER_ADDRESS` must be a
real address: PocketBase validates it, and rejects something like
`alerts@localhost` with `[mail] WARNING: could not apply the SMTP settings`. The
password is stored in `pb_data` in clear unless `PB_ENCRYPTION_KEY` is set — the
same standing as the hidden fields on `instances`.

**web** — internal addresses for the backends, public URLs for anything a user sees:

```
NUXT_POCKETBASE_URL=http://pocketbase.railway.internal:8090   # matches PORT=8090 above
NUXT_POCKETBASE_ADMIN_EMAIL=<you>
NUXT_POCKETBASE_ADMIN_PASSWORD=<generate>
NUXT_PUBLIC_APP_URL=https://<web-domain>

# WhatsApp only
NUXT_EVOLUTION_URL=http://evolution.railway.internal:8080    # matches SERVER_PORT above
NUXT_EVOLUTION_ADMIN_KEY=${{evolution.AUTHENTICATION_API_KEY}}
NUXT_EVOLUTION_DATABASE_URL=postgres://wamcp_search:<password>@<postgres-private-host>:<port>/<database>
NUXT_WEBHOOK_URL=https://<web-domain>/api/webhook/evolution
NUXT_WEBHOOK_SECRET=<openssl rand -hex 32>   # used by Telegram's webhook too

# Telegram only
NUXT_TELEGRAM_URL=http://<telegram-bridge-service>.railway.internal:8095   # matches TELEGRAM_BRIDGE_PORT
NUXT_TELEGRAM_ADMIN_KEY=${{telegram-bridge.TELEGRAM_BRIDGE_ADMIN_KEY}}
NUXT_TELEGRAM_DATABASE_URL=${{Postgres.DATABASE_URL}}
```

`NUXT_TELEGRAM_WEBHOOK_URL` is not needed here: the bridge posts to
`NUXT_PUBLIC_APP_URL` + `/api/webhook/telegram`.

`NUXT_PUBLIC_APP_URL` is what connector URLs are built from. Get it wrong and
every token you hand out points at the wrong host.

`NUXT_EVOLUTION_ADMIN_KEY` is the most sensitive value in the deployment: it can
create, read and delete every user's WhatsApp connection.

`NUXT_EVOLUTION_DATABASE_URL` points at the same Postgres service Evolution uses,
but as the read-only role from "Reading and searching messages" — create it
there first. Do not reference `${{Postgres.DATABASE_URL}}`: that is the
database's owner, and this connection reaches every user's messages.

**Set `NUXT_WEBHOOK_SECRET`.** The app registers a webhook per connection and
attaches it as `x-webhook-secret`; per-instance webhooks are the only ones
Evolution sends custom headers on. That is also why `WEBHOOK_GLOBAL_ENABLED` is
off above — the global webhook sends none, so with a secret set every global
delivery would 401, which Evolution treats as non-retryable and drops.

**Keep the web service at one replica.** The hourly connection sweep runs
in-process, so a second replica means a second sweep and duplicate alert emails.

**Leave `NUXT_ALLOW_PRIVATE_TARGETS` unset.** It defaults to off, which is right
for any deployment more than one person uses — see "Database connections".

### First run

Nothing to do. Set `NUXT_POCKETBASE_ADMIN_EMAIL` and
`NUXT_POCKETBASE_ADMIN_PASSWORD` on the **pocketbase** service as well as the web
service — to the same values — and its entrypoint upserts the superuser on every
boot. The schema needs no action either; `pb_migrations/` is baked into the image
and applied at startup.

Both admin variables must match across the two services: the web server signs in
with them to read hidden fields and the admin-only collections. A Railway variable
reference (`${{pocketbase.NUXT_POCKETBASE_ADMIN_EMAIL}}`) keeps them in step.

Because the upsert runs every boot, rotating the password is editing the variable
on both services and redeploying. Look for `[entrypoint] superuser ready:` in the
pocketbase logs to confirm.

That account can read every stored credential — Evolution keys, connection
strings and message database URLs. Give it a long password — PocketBase's CLI
will accept a short one without complaint, though the entrypoint warns.

Then open the web service's domain and sign up.

### Notes

- **Do not ship a `.env`.** It is gitignored, and Railway variables replace it.
- **`host.docker.internal` does not exist here.** The webhook uses the public
  HTTPS URL instead, which is the only thing that differs between dev and prod —
  and it differs by configuration, not code.
- All three containers built from this repo bind `::`, which accepts IPv4 and IPv6. Railway environments
  created before 16 October 2025 route the private network over IPv6 only, where
  binding `0.0.0.0` is unreachable internally.
- `docker-compose.dev.yml` is for local development only. Nothing in it is used
  by Railway.

## Editor

`.zed/` ships tasks (`services: up`, `web: dev`, `mcp: inspector`, …) and language
server settings. Install the **Vue** extension in Zed for `vue-language-server`;
TypeScript uses the bundled `vtsls`, pointed at `apps/web/node_modules/typescript`
because pnpm does not hoist.
