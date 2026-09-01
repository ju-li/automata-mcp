# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

One Nuxt/Nitro server exposing two surfaces over the same [Evolution API](https://doc.evolution-api.com/) (WhatsApp) backend:

1. **Web UI** — users pair WhatsApp numbers and mint connector tokens. PocketBase session cookie.
2. **MCP endpoint** — Claude connects to `/mcp` as a custom connector. App-minted bearer token.

PocketBase is the app's database (users, sessions, connected accounts and their Evolution credentials). Evolution API, Postgres and Redis are dependencies you run, not code in this repo.

`README.md` is the operator's manual — first-run setup, networking tables, the Linux firewall rule, Railway deploy, MCP client connection. Read it before doing anything involving Docker or the local stack; this file covers the code.

**Status:** the product loop works end to end — sign up, provision an Evolution instance, pair by QR (importing that number's WhatsApp history as it connects), per-account dashboard with stats, connector token provisioning. Five MCP tools: `get-connection-status`, `list-chats`, `read-messages`, `search-messages` (opt-in, see below), `send-text-message`. Webhook event handling is not built; `/api/webhook/evolution` is a stub that logs and acks.

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
  server/utils/              pocketbase, session, auth-cookie, mcp-auth, instances, tokens, evolution, evolution-db, mentions, redact
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

**Reactions are excluded from reads and searches by default.** Evolution stores every 👍 as an ordinary `Message` row — its own id, author, timestamp and type, to carry one emoji — so in an active group they are a large share of a page and almost never help reconstruct a conversation. `read-messages` and `search-messages` both take `includeReactions`, default `false`, and both say `reactionsExcluded: true` in the response when they left them out; a page that silently drops a message class reads as "nobody reacted". Two layers do the excluding and both are needed: `listMessages` sends `where.messageType = { not: 'reactionMessage' }` so Evolution builds a full page rather than one this app then guts, and `isReaction()` in `chats.ts` re-checks the payload because `messageType` is Baileys' `getContentType()` verbatim — it returns the *first* `conversation`/`*Message` key, so a reaction arriving with a `messageContextInfo` can be typed as that instead. `searchMessages()` filters on the payload alone for the same reason, and its `COALESCE` gained a `reactionMessage->>'text'` arm — before it, a reaction had no `body` and `body IS NOT NULL` dropped it, silently rather than by decision.

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

## History arrives once, at pairing

WhatsApp pushes a burst of past conversations while a device is being linked, and never again. **No endpoint fetches history after the fact** — not in this app, not in Evolution, not in Baileys in any form that works for a linked device. `/chat/findMessages` reads Evolution's own Postgres, not WhatsApp. Do not go looking for a date-range import; the upstream request for one was closed unimplemented, and `fetchMessageHistory` appears in Evolution only behind a debug easter-egg whose result is `console.log`ed and discarded.

Three preconditions, two of which must hold **before** the QR is scanned:

- `DATABASE_SAVE_DATA_HISTORIC=true` on the evolution service. Evolution checks it once, inside the `messaging-history.set` handler, and drops the whole payload if it is false. It is not one of the flags that covers live traffic.
- `syncFullHistory: true` in the `POST /instance/create` body (`provisionInstance` in `server/utils/instances.ts`). It reaches Baileys' socket config, so it only takes effect when a socket is constructed.
- A genuinely fresh device link. Reconnecting an existing session sends nothing.

`enableFullHistorySync()` is what backfills an account paired before this existed: it writes the setting, then logs the instance out so the next connect is a new device link. It is exposed at `POST /api/instances/:id/resync` and behind a confirm dialog, because the cost is a QR scan on a real phone — see the pairing warning below. Re-importing is safe: Evolution skips messages whose `key.id` it already holds, so it merges rather than duplicates.

**Writing a settings change is read-modify-write, never partial.** Evolution's `setSettings` copies every field of the request body onto the live instance's in-memory settings, so a key you leave out becomes `undefined` on a running socket. Its schema also marks all six booleans required and types `msgCall`/`wavoipToken` as `string`, so a partial body — or one echoing back the `null` that `settings/find` returns for an unset string — is a 400. `settingsBody()` in `instances.ts` handles both; go through it.

**`syncFullHistory: true` also turns off Evolution's group filter.** Its `shouldIgnoreJid` stops excluding `@g.us` regardless of `groupsIgnore`, so group chats sync and show up in `list-chats` and the token scope picker. Per-token chat scoping contains that, but it is a wider default surface than before.

**Bumping the pinned Evolution tag means re-verifying this.** Specifically: that `messaging-history.set` still gates on `SAVE_DATA.HISTORIC`, that the settings schema still requires those six booleans, that `syncFullHistory` still reaches the socket config, and that `fetchMessages` still passes `where.messageType` through to Prisma unmangled (the reaction filter rides on it; an operator Prisma rejects answers 500, so a regression is loud). The paging facts below — `fetchMessages`' envelope, its `count`, its ordering and its skip/take — come from the same source and need the same re-check.

Reading it back: `listMessages()` takes `{ limit, page, since, until, includeReactions }`. Evolution applies its timestamp filter only when **both** bounds are present and silently ignores a one-sided range, so `chats.ts` widens the missing side rather than passing it through. There is no text search upstream — do not offer one.

**A page must say it is a page.** `listMessages()` returns `MessagePage` — `{ messages, hasMore, total? }` — not a bare array, and `read-messages` surfaces `hasMore`, `nextPage`, `covered` and a `note` in words. It reads newest-first, so truncating a `since`-bounded window drops the **old** end: precisely the part a caller who named a date range asked for, keeping the part they would have got without asking. Returned bare it reads as the complete window, and the summary written from it has a hole in it — which is the bug this replaced.

Two rules hold that up. `hasMore` is `records.length >= limit` and is **never** derived from `total`: a count that is wrong upstream would otherwise drive a caller into paging forever, whereas a full final page merely costs one extra call that returns nothing. And `read-messages` pins `until` itself as soon as `since` is given, because `listMessages` widens a missing upper bound to *now* — a value that moves between calls, so an unpinned page 2 comes from a different range than page 1. The pinned window is echoed back as `window` for the caller to pass to the next page. No range is added when there is no `since`; `Message` is indexed by `instanceId` and nothing else.

`total` comes from Evolution's envelope, which 2.3.7's `fetchMessages` builds as `{ messages: { total, pages, currentPage, records } }`. `total` is a `prisma.message.count` over the **same** where clause as the `findMany`, `timestampFilter` included, so it is the count of the range asked for and not of the chat — verified against the pinned tag. It is surfaced as `totalMatching`, with `totalPages` alongside it. Still read defensively (finite number or dropped): a tag bump that made the count stop tracking the `where` would turn it into a confident wrong number, which is the same class of bug as the missing `hasMore`. Check that it shrinks with a narrowed `messageTimestamp` before trusting a new tag.

Also confirmed there, and depended on: `orderBy: { messageTimestamp: 'desc' }`, `skip = offset * (page - 1)` with `take = offset`, so pages are 1-based, non-overlapping and newest-first — and the timestamp filter really is applied only when both `gte` and `lte` are set.

**`_count.Chat` and `findChats` count different tables.** The dashboard's chat stat is `_count.Chat` — rows in Evolution's `Chat` table. `listChats()` reads `findChats`, whose raw query is `DISTINCT ON (remoteJid)` over `"Message"`. `messaging-history.set` takes `chats` and `messages` as separate arrays and writes a `Chat` row for every conversation the phone lists while persisting only the message slice WhatsApp actually delivered, so the listing is routinely and permanently the shorter of the two. The gap is not a page boundary and no offset closes it: a "load more" driven off that subtraction fetches nothing, forever. `listChats()` therefore returns `ChatPage` — `{ chats, hasMore }` — and `hasMore` is `rows.length >= take`, the same "the page came back full" rule as `MessagePage`. Nothing may treat the two counts as comparable.

Paging chats is real, though: 2.3.7 maps `take` to `LIMIT` and `skip` to `OFFSET`, and `contactValidateSchema` sets no `additionalProperties: false`, so both survive the route validator — re-verify that on a tag bump. Two consequences for callers. The order is `updatedAt DESC`, which live traffic reshuffles, so an accumulating client dedupes by JID and pages from rows *received* rather than rows *kept*. And naming the rows costs Evolution's whole contact table (the endpoint filters to one JID, not to a set), so it goes through `contactDirectory()` — `fetchContacts` behind a 5-minute per-account cache — rather than being re-read on every page and again for every mention lookup. Only *successes* are cached: unlike the group and participant lookups this is a plain database read that answers while the account is disconnected, so a failure is a real fault to retry, not an offline state to back off from. `listChats` still swallows a failed **first** page — an empty list is the honest answer for a fresh account and must not break the scope picker — but rethrows on `skip > 0`, because a swallowed later page reads as the end of the list.

## Mentions are resolved from `contextInfo`, never from the text

WhatsApp writes an @-mention as the bare local part of the mentioned JID, and in a
group that JID is a **LID** (`@lid`) — a per-user identity, not a phone number and
not something a country code can be read off. Left raw it reads as an opaque
number, and a model summarising a thread guesses who was addressed. That guess is
the whole bug: it produces confident misattribution.

`server/utils/mentions.ts` rewrites them inline (`@79972425314508` → `@Ju`) on both
read paths. Three things hold it up.

**Replacement is driven off `contextInfo.mentionedJid`, never off a `@\d+` scan.**
Only strings WhatsApp itself marked as mentions are ever rewritten, so an order id,
a price or a typed-out phone number is left alone. `applyMentions` does one pass
over a single alternation of every resolved local part, longest first with a
`(?!\d)` guard — without that, a short LID silently eats the front of a longer one,
and without the single pass a substituted name can be rewritten again by the next
mention.

**Read it from the `contextInfo` column, not from `message`.** 2.3.7's
`prepareMessage` rewrites `extendedTextMessage` into `message.conversation` and
`delete`s the original, so a mentioning text message stores *nothing* under
`message->extendedTextMessage->contextInfo` — which is also why such a message
arrives with `messageType: "conversation"`. The mentions survive in the dedicated
`Message.contextInfo` column. `fetchMessages` already selects it, so the HTTP path
needs no extra round trip; `evolution-db.ts` selects `contextInfo->'mentionedJid'`,
still a column of `"Message"` and so inside the existing read-only grant.

**Names come from group participants first, contacts second.** Evolution's
`Contact` rows are written keyed on `key.remoteJid`, which for a group message is
the *group's* JID — a good source for 1:1 chats and a poor one for group members.
`GET /group/participants` is the authority on who is in a group, and a participant
is indexed under every identity it carries (`id`, `lid`, `phoneNumber`, `jid`)
because which form appears in `mentionedJid` is WhatsApp's choice. The directory is
keyed on the **local part** so either form resolves, and the lookup is display-only
— no JID is constructed and nothing addresses a chat by one, so the "never
normalise JIDs locally" rule below is not in play.

All of it is best-effort and degrades to the raw id: participants need a live
socket, so a disconnected account resolves nothing and must still return its
messages. `read-messages` is one chat and so one lookup; `search-messages` spans
many, so it resolves from contacts first and only pays for group membership where
something is still unresolved, capped busiest-group-first. A raw id is honest; a
wrong name is the failure the whole module exists to prevent.

## Webhook delivery is gated twice

`WEBHOOK_GLOBAL_ENABLED` + `WEBHOOK_GLOBAL_URL` deliver **nothing** on their own. Evolution checks the matching `WEBHOOK_EVENTS_<EVENT>` flag for every global delivery, and every one of them defaults to false. An event not listed on the evolution service in `docker-compose.dev.yml` never reaches the handler.

The other half of the trap: only the *per-instance* webhook sends custom headers. The global webhook sends none, so setting `NUXT_WEBHOOK_SECRET` while relying on the global URL makes every delivery 401 — and Evolution treats 401 as non-retryable, so it is dropped rather than retried. Leave the secret empty until per-instance webhooks are registered with the header.

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
