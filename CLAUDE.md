# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

One Nuxt/Nitro server exposing two surfaces over the same [Evolution API](https://doc.evolution-api.com/) (WhatsApp) backend:

1. **Web UI** — users pair WhatsApp numbers and mint connector tokens. PocketBase session cookie.
2. **MCP endpoint** — Claude connects to `/mcp` as a custom connector. App-minted bearer token.

PocketBase is the app's database (users, sessions, connected accounts and their Evolution credentials). Evolution API, Postgres and Redis are dependencies you run, not code in this repo.

`README.md` is the operator's manual — first-run setup, networking tables, the Linux firewall rule, Railway deploy, MCP client connection. Read it before doing anything involving Docker or the local stack; this file covers the code.

**Status:** the product loop works end to end — sign up, provision an Evolution instance, pair by QR, per-account dashboard with stats, connector token provisioning. Five MCP tools: `get-connection-status`, `list-chats`, `read-messages`, `search-messages` (opt-in, see below), `send-text-message`. Webhook event handling is not built; `/api/webhook/evolution` is a stub.

A user may connect **several** WhatsApp accounts. Each is a row in `instances`, and each MCP token is bound to exactly one of them.

## Commands

Package manager is **pnpm**, pinned to `pnpm@11.22.0` via `packageManager`. Do not use npm/yarn.

Run from the repo root — root scripts delegate with `pnpm --filter web`:

```bash
pnpm install          # postinstall runs `nuxt prepare` in apps/web
pnpm services:up      # postgres, redis, evolution, pocketbase (compose)
pnpm dev              # Nuxt on the host, http://localhost:3000
pnpm typecheck        # nuxt typecheck across app + server
pnpm build            # production build -> apps/web/.output/
pnpm services:down / :logs / :ps
```

Nuxt is deliberately **not** in compose (HMR), and there is no `predev` hook — bring services up yourself. There is no lint config and **no test framework**; `pnpm typecheck` is the only automated check that exists.

## Environment

One `.env` at the repo root serves everything. Compose reads it by adjacency; Nuxt reads it because every `apps/web` script passes `--dotenv ../../.env`. `.env.example` documents every variable.

Nuxt only overrides `runtimeConfig` from `NUXT_`-prefixed vars, so a few values are duplicated under two names (`WEBHOOK_URL` for compose, `NUXT_WEBHOOK_URL` for Nuxt) — **keep the pair in sync**. That pair is the only thing that differs between dev and prod; there is no environment branch in code.

## Layout

```
apps/web/                    Nuxt 4 app. srcDir = app/. Own Dockerfile (context = repo root).
  app/pages/                 login, signup, instances/{index,new,[id]}
  app/components/            app components + ui/ (shadcn-vue, bare names)
  app/composables/           useSession, useConnectionState
  app/middleware/            auth.global.ts — session gate only
  modules/mcp-token-route.ts local Nuxt module — registers /mcp/:token
  server/api/                auth/, instances/, tokens/
  server/mcp/index.ts        default MCP handler (auth middleware)
  server/mcp/tools/          one file per tool, auto-discovered
  server/utils/              pocketbase, session, auth-cookie, mcp-auth, instances, tokens, evolution, evolution-db, redact
services/pocketbase/         pinned PocketBase build + committed schema migrations
docker-compose.dev.yml       services only, NOT Nuxt
```

Aliases resolve relative to `apps/web` (the Nuxt root), not the repo root: `~`/`@` → `apps/web/app/`, `~~`/`@@` → `apps/web/`, `#shared` → `apps/web/shared/` (not yet created). `apps/web/tsconfig.json` holds no compiler options — it only references the four generated `.nuxt/tsconfig.*.json` projects. Never hand-edit `.nuxt/`.

## The auth split (load-bearing)

The two surfaces have **entirely separate** credential paths, and there is no shared "get current user" helper. This is the central invariant of the codebase — do not collapse it.

| | Web UI | MCP |
|---|---|---|
| Credential | PocketBase cookie (`pb_auth`, `httpOnly`) | `Authorization: Bearer` or `/mcp/<token>` |
| Resolved by | `server/middleware/session.ts` → `utils/session.ts` | `server/mcp/index.ts` → `utils/mcp-auth.ts` |
| Context key | `event.context.user` | `event.context.mcpAuth` |
| Evolution client | `evolutionClientForInstance(instance)` | `useEvolutionClient()` |
| On failure | 401 JSON | 401 **+ `WWW-Authenticate`**, JSON-RPC shaped |

Three things enforce it:

- `server/middleware/session.ts` returns early on any `/mcp*` path, so cookies are never parsed there. Without that early return, a browser signed into the app could authenticate an MCP tool call with a cookie.
- `useEvolutionClient()` reads `event.context.mcpAuth` and has no branch that reaches a session user; it throws 401 if the key is absent.
- MCP tokens are minted by this app (`wamcp_` + 32 random bytes) and stored **only** as a SHA-256 hash in the superuser-only `mcp_tokens` collection. A token resolves to one `instances` row, which carries that account's Evolution token.

**Failure-mode semantics matter here:** a PocketBase outage answers **503**, never 401. A 401 tells a client its credential is bad — an MCP client discards a token it should keep, and a browser user gets silently signed out mid-outage. Both surfaces make the distinction: `resolveMcpAuth` returns `undefined` (→ 401) only on a genuine 404, and `getSessionUser` only on 401/403/404 from `authRefresh`. Everything else rethrows as 503. Preserve that in any auth code you add.

**A handled `createError` is not logged by Nitro.** Only unhandled/fatal errors reach its error handler, so a deliberate 503 produces a response with *nothing whatsoever* in the server logs — which is how an outage turns into guesswork. Both admin-auth and session failures log the underlying cause themselves, and say which of the two fixes applies. Do the same for any handled error an operator would need to diagnose.

## MCP wiring

Built on `@nuxtjs/mcp-toolkit` (**pinned to 0.19.0**). It auto-imports `defineMcpHandler` / `defineMcpTool` and configures the server via the `mcp` key in `nuxt.config.ts`.

**Adding a tool:** drop a file in `apps/web/server/mcp/tools/` — discovery is automatic, no registration. Give every tool a `title` (shown in client UI), a `description` written for the model, and accurate `readOnlyHint` / `destructiveHint`. Copy `get-connection-status.ts` (read) or `send-text-message.ts` (write).

**Tools take no account argument.** The token is bound to one instance, so `useMcpAuth()` and `useEvolutionClient()` already resolve to it. Adding an instance parameter would reintroduce the possibility of addressing the wrong number. Never accept an Evolution API key as a tool argument either.

**`nitro.experimental.asyncContext: true` is required — do not turn it off.** Tool handlers are invoked by the MCP SDK with its `RequestHandlerExtra`, not an H3 event, so `useEvent()` is the only way to reach per-request credentials, and it needs async context.

**`modules/mcp-token-route.ts` is deliberately fragile.** It deep-resolves a file inside `@nuxtjs/mcp-toolkit` that is not in the package's `exports` map, to register `/mcp/:token` against the same handler (Claude and other clients cannot attach an `Authorization` header to a custom connector). A middleware URL rewrite does not work — h3 1.15.x re-assigns `event._path` before every layer. If a toolkit upgrade moves that file the module throws at build with a pointer to the documented fallback. Bumping the toolkit version means re-verifying this module.

**Token redaction:** `server/plugins/redact-mcp.ts` scrubs `event.node.req.originalUrl` (what Nitro's error handler actually reads — scrubbing `event.path` alone is insufficient) and sets `event.context.noLog`. `mcp.logging` is off for the same reason. Route any error reporter or logger you add through `redactPath` / `redactHeaders` in `server/utils/redact.ts`.

## Two rules that are easy to break later

**No admin-key fallback in per-instance credentials.** `credentialsForInstance()` returns `undefined` when an instance has no `api_key`, and callers must fail. Falling back to `runtimeConfig.evolutionAdminKey` would hand any MCP token holder access to *every* user's WhatsApp account. The admin key has exactly two callers, both in `server/utils/instances.ts`: create and delete.

**The Evolution database connection is read-only and search-only.** `server/utils/evolution-db.ts` is the one file that talks to Evolution's Postgres, and it exists because Evolution 2.3.7 has no message-content search: `POST /chat/findMessages` accepts a `where.message` and never reads it, so a content search returns an unfiltered page that reads as a result set. Do not try to search over the HTTP API — that field is a trap. The connection is far wider than anything else the app holds (every user's messages, every instance), so three things are load-bearing: the role is `SELECT`-only on `"Message"` and the app never writes or runs DDL; every query carries `"instanceId" = <this account>`, which `searchMessages()` cannot be called without; and chat scope is a **predicate in the SQL**, not a filter applied to rows after they are read. `resolveEvolutionInstanceId()` throws rather than querying without an id — `createInstance()` can store `''`, and an empty id would mean a query with no account predicate at all. Search is optional: with no `NUXT_EVOLUTION_DATABASE_URL` the tool's `enabled` guard is false and it is never registered.

**Hidden fields require the admin client.** `instances.api_key` is a `hidden` PocketBase field. It is absent from anything fetched with a session-scoped client, including `getSessionUser()`'s `authRefresh`. Anything that needs it must go through `pocketbaseAdmin()` — `requireOwnedInstance()` already does.

**Never normalise JIDs locally.** Evolution's `createJid` carries country-specific rules (Brazil's ninth digit, Mexico and Argentina prefixes). A JID stored by our rules but matched by theirs is a token scope that silently reaches the wrong chat, or refuses the right one. `resolveNumberToJid` in `server/utils/mcp-scope.ts` asks Evolution; both storing a scope and checking one go through it.

**`enabled` guards cannot see tool arguments.** They receive only the event, so they can gate a whole tool but not "this tool, for this chat". Anything argument-dependent — every chat check — belongs in the handler. See the table in `mcp-scope.ts`.

**PocketBase materialises an unset boolean as `false`, not absent.** A write path that forgets `all_tools` mints a token that can call nothing. `scopeFields()` in `tokens.ts` always writes all four scope columns for this reason.

## Ownership checks answer 404

`requireOwnedInstance()` and `revokeToken()` return **404**, not 403, when a record belongs to someone else. A 403 confirms the id exists and turns the route into a probe for other users' data.

## PocketBase

Two clients in `server/utils/pocketbase.ts`, and the distinction is a security boundary:

- `pocketbaseAdmin()` — memoized superuser client, re-auths on expiry, concurrent callers share one in-flight request. Reads hidden fields and `mcp_tokens`. **Never build a filter for it from user input** (use `pb.filter()` with bindings, as `mcp-auth.ts` does).
- `pocketbaseForRequest()` — fresh unauthenticated client per request, loaded with the caller's own cookie. Its auth store must never be shared across requests, and must never overwrite the admin store's.

`pb_migrations/` and `pb_hooks/` are **COPYed into the PocketBase image**, and also bind-mounted in development. The mount shadows the baked copy, which is what lets schema edits made in the admin UI land back in the repo — but the baked copy is the only one that exists in production. A change that removes the COPY ships a deployment with no collections at all.

`services/pocketbase/pb_migrations/` is committed and is the schema source of truth. The directory is bind-mounted, so schema edits made in the admin UI are written straight back into the working tree as new migration files — **commit them**. `pb_data/` is gitignored runtime state; the container runs as root, so on Linux remove it through a container (see README).

## Frontend

**Tailwind v4** via the Vite plugin (`@tailwindcss/vite`), not the Nuxt Tailwind module. There is no `tailwind.config.js` and there should not be one — all theme config lives in `apps/web/app/assets/css/tailwind.css` as `@theme inline` plus `:root` / `.dark` custom properties (oklch). To add a token: define the CSS var under **both** `:root` and `.dark`, then map it inside `@theme inline` (`--color-foo: var(--foo)` yields `bg-foo`, `text-foo`). Dark mode is a class variant (`@custom-variant dark (&:is(.dark *))`) — it needs a `.dark` class on an ancestor; no media query is wired.

**shadcn-vue** via `shadcn-nuxt` with `prefix: ''`, so components auto-import under bare names (`<Button />`, not `<UiButton />`). Add them with the CLI, don't hand-write:

```bash
cd apps/web && pnpx shadcn-vue@latest add <component>
```

`components.json` pins the contract (`new-york`, `neutral`, CSS variables, lucide icons, `cn` at `@/lib/utils` — do not move that file).

`app/plugins/ssr-width.ts` calls `provideSSRWidth(1024)` so VueUse viewport composables render deterministically server-side. Change the number only to change the app-wide SSR breakpoint assumption.

**Components must be explicitly closed** in Vue SFC templates — `<Input ... />`, not `<Input ...>`. Only HTML void elements may be left open, and `nuxt typecheck` does **not** catch this; it surfaces as a 500 "Element is missing end tag" the first time the page renders. Load a page after editing a template.

**Routing gate:** `middleware/auth.global.ts` handles authentication only. It deliberately does not check WhatsApp connection state — that would put an Evolution round-trip on every navigation. `/instances` redirects to `/instances/new` when the user has none, and `/instances/[id]` decides between the QR panel and the dashboard.

**Provisioning is click-triggered, not on-mount.** Creating an instance reserves a live socket on the Evolution server, so a page refresh must never create a second account.

**The token list is shown even while an account is disconnected** — otherwise you could not revoke a token for an offline account, which is exactly when you would want to.

**Restart the dev server after adding shadcn components.** The component manifest is built at startup; a component added while it runs renders as a literal unknown element (`<radiogroupitem>`) and SSR still returns 200. A page that loads is not proof that it works.

## Things that cost real money or a phone number

- **`docker compose down -v` forces a full WhatsApp QR re-scan.** `-v` deletes the `evolution_instances` volume holding every paired session. Use `down` without `-v` for routine restarts.
- **Pairing burns a real phone number.** Scanning the QR binds a real WhatsApp account; repeated pair/unpair or unsolicited sends get numbers banned. Use a spare SIM.
- **`pnpm dev` runs `nuxt dev --host 0.0.0.0`**, which it must — bound to localhost, Nuxt is unreachable from the Evolution container. That means the socket listens on the LAN interface too.
- **On a Linux host with ufw, the inbound webhook silently times out** until you allow container→host traffic. The compose subnet is pinned to `172.31.250.0/24` so one rule covers it; the rule and the round-trip test are in README "Linux firewall". Reachable by ping but not TCP is the signature.

Every image tag in `docker-compose.dev.yml` is pinned. Do not relax one to `latest`.

**The superuser is created at boot, not by hand.** `services/pocketbase/entrypoint.sh` upserts it from `PB_SUPERUSER_EMAIL` / `PB_SUPERUSER_PASSWORD`, falling back to the `NUXT_POCKETBASE_ADMIN_*` names so one variable can be set identically on both services. `upsert` is idempotent, so it doubles as password rotation. It warns and keeps serving on failure rather than exiting — a crash-loop would take away the admin UI, which is the one place you could fix it by hand.

## Container ports

Neither image hardcodes its port. `apps/web/Dockerfile` deliberately does **not** set `NITRO_PORT`, because Nitro resolves `NITRO_PORT || PORT` and pinning it makes the server ignore the port a platform assigns; unset, it defaults to 3000. PocketBase runs through `sh -c` so `${PORT:-8090}` expands, with `exec` so it keeps PID 1 and still receives SIGTERM.

Both bind `::` rather than `0.0.0.0`, which accepts IPv4 and IPv6. Legacy Railway environments route the private network over IPv6 only.

**Following `$PORT` means the listen port is not the Dockerfile default.** Railway injects `PORT=8080` into every service, so PocketBase listens on 8080 there, not 8090, and anything pointing at 8090 gets `ECONNREFUSED` from a hostname that resolves fine. Pin `PORT=8090` on that service. Evolution is unaffected — it reads `SERVER_PORT`, which the README pins.

**Do not add a `VOLUME` instruction.** Railway fails the build on it outright (`docker VOLUME at Line N is not supported, use Railway Volumes`). Persistence comes from the compose bind mount locally and an attached volume in the service settings on Railway.

**Do not add a BuildKit cache mount either.** Railway rejects any `--mount=type=cache` whose `id` is not prefixed with that service's own id (`id=s/<service-id>-<target>`), which would hardcode one Railway service into the Dockerfile. `apps/web/Dockerfile` installs without one; the install layer is keyed on the lockfile, so an unchanged lockfile skips it anyway.
