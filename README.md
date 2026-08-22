# claude-whatsapp-mcp

A Nuxt app that serves two surfaces from one Nitro server:

1. **Web UI** — users manage their [Evolution API](https://doc.evolution-api.com/) (WhatsApp) instances.
2. **MCP endpoint** — Claude connects to `/mcp` as a custom connector.

PocketBase is the backend (users, sessions, per-user Evolution credentials).
Evolution API, Postgres and Redis are dependencies you run, not code in this repo.

> **Status: scaffold.** Auth, the MCP transport, the shared Evolution client and
> the local dev stack are wired and verified. There are no pages, no instance
> CRUD, and only two example tools. The product surface is yours to build.

## Layout

```
apps/web/                    Nuxt 4 + TypeScript. Has its own Dockerfile.
  modules/                   local Nuxt modules (registers /mcp/:token)
  server/mcp/                MCP handler + tools
  server/utils/              PocketBase, auth, Evolution client, redaction
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

Create the PocketBase superuser using the same credentials you put in `.env`:

```bash
docker compose -f docker-compose.dev.yml exec pocketbase \
  /pb/pocketbase superuser upsert "$NUXT_POCKETBASE_ADMIN_EMAIL" "$NUXT_POCKETBASE_ADMIN_PASSWORD" --dir=/pb_data
```

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
`last_used_at` and `expires_at`. It resolves to a user record holding the
Evolution URL + key, which stay server-side.

A PocketBase outage answers **503**, not 401 — a 401 would tell a client its
valid token had been revoked and invite it to throw the token away.

Tokens never reach logs or error bodies: `server/plugins/redact-mcp.ts` scrubs
`/mcp/<token>` to `/mcp/[redacted]` at the source (`event.node.req.originalUrl`,
which is what Nitro's error handler reads). Route any error reporter you add
through `redactPath` / `redactHeaders` in `server/utils/redact.ts`.

### Connecting an MCP client

Mint a token for a user (currently by hand — the UI is yours to build):

```js
// see server/utils/mcp-auth.ts
const { token, hash } = mintMcpToken()   // store `hash` in mcp_tokens, show `token` once
```

Then either:

- `POST http://localhost:3000/mcp` with `Authorization: Bearer <token>`, or
- `POST http://localhost:3000/mcp/<token>` — for clients that cannot set headers.

Both routes run the same handler, the same auth middleware and the same tools.

Inspect it with:

```bash
pnpm dlx @modelcontextprotocol/inspector
```

### Adding tools

Drop a file in `apps/web/server/mcp/tools/` — it is discovered automatically.
Give every tool a `title` and the applicable `readOnlyHint` / `destructiveHint`;
see `list-instances.ts` (read) and `send-text-message.ts` (write) for the pattern.

Tool handlers get the MCP SDK's `RequestHandlerExtra`, not an H3 event, so
credentials are reached through `useEvolutionClient()` → `useEvent()`. That is why
`nitro.experimental.asyncContext` is enabled in `nuxt.config.ts` — do not turn it off.

## PocketBase schema

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

Two services, each pointing at its own root directory.

| Service | Root directory | Dockerfile | Notes |
|---|---|---|---|
| web | repo root | `apps/web/Dockerfile` | needs the lockfile, so the context is the root |
| pocketbase | `services/pocketbase` | `Dockerfile` | attach a persistent volume at `/pb_data` |

Set the `NUXT_*` variables in each service's dashboard — do not ship a `.env`.
Point `NUXT_WEBHOOK_URL` at the public HTTPS URL
(`https://<app>/api/webhook/evolution`) and set `NUXT_POCKETBASE_URL` to the
PocketBase service's internal address.

Evolution API, Postgres and Redis are separate services you provision yourself;
`docker-compose.dev.yml` is for local development only.

## Editor

`.zed/` ships tasks (`services: up`, `web: dev`, `mcp: inspector`, …) and language
server settings. Install the **Vue** extension in Zed for `vue-language-server`;
TypeScript uses the bundled `vtsls`, pointed at `apps/web/node_modules/typescript`
because pnpm does not hoist.
