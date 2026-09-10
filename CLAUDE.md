# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

One Nuxt/Nitro server exposing two surfaces:

1. **Web UI** — users create *connections* and mint connector tokens for them. PocketBase session cookie.
2. **MCP endpoint** — Claude connects to `/mcp` as a custom connector. App-minted bearer token.

A connection is a row in `instances` with a `kind`, and a connector token is bound to exactly one row. Two kinds exist:

- **`whatsapp`** — an [Evolution API](https://doc.evolution-api.com/) instance, paired by QR, on the Evolution server this deployment is configured with *or* one the user supplied.
- **`postgres`** — a user-supplied PostgreSQL DSN.

`kind` is read through `instanceKind()` in `mcp-scope.ts`, never off the record directly: PocketBase materialises an unset SelectField as `''`, and a row written before the field existed is a WhatsApp account. That default lives in exactly one function.

PocketBase is the app's database (users, sessions, connections and their credentials). Evolution API, its Postgres and its Redis are dependencies you run **only for WhatsApp connections** — they sit behind a `whatsapp` compose profile, and the `NUXT_EVOLUTION_*` variables are optional.

`README.md` is the operator's manual — first-run setup, networking tables, the Linux firewall rule, Railway deploy, MCP client connection. Read it before doing anything involving Docker or the local stack; this file covers the code.

**Status:** the product loop works end to end for both kinds — sign up, create a connection, pair by QR (importing that number's WhatsApp history as it connects) or paste a DSN, per-connection dashboard, connector token provisioning with per-chat or per-table scoping. Ten MCP tools, gated by kind:

- `whatsapp`: `get-connection-status`, `list-chats`, `read-messages`, `search-messages`, `send-text-message`
- `postgres`: `get-database-info`, `list-tables`, `describe-table`, `run-query`, `run-statement` (write)

Webhook event handling is not built; `/api/webhook/evolution` is a stub that logs and acks.

A user may hold **several** connections of either kind. Each is a row in `instances`, and each MCP token is bound to exactly one of them.

## Commands

Package manager is **pnpm**, pinned to `pnpm@11.22.0` via `packageManager`. Do not use npm/yarn.

Run from the repo root — root scripts delegate with `pnpm --filter web`:

```bash
pnpm install          # postinstall runs `nuxt prepare` in apps/web
pnpm services:up      # pocketbase only (compose)
pnpm services:up:whatsapp   # + postgres, redis, evolution
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
  server/mcp/tools/<kind>/    one file per tool, auto-discovered; the directory
                              sets `group`, which is what gates a tool to a kind
  server/utils/              pocketbase, session, auth-cookie, mcp-auth, instances, tokens,
                             evolution, evolution-db, mentions, redact,
                             net-guard, pg-pool, pg-guard, pg-run, pg-catalog
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
| Backend client | `evolutionClientForInstance(instance)` / `pgFor(instance)` | `useEvolutionClient()` / `pgFor(instance)` |
| On failure | 401 JSON | 401 **+ `WWW-Authenticate`**, JSON-RPC shaped |

Three things enforce it:

- `server/middleware/session.ts` returns early on any `/mcp*` path, so cookies are never parsed there. Without that early return, a browser signed into the app could authenticate an MCP tool call with a cookie.
- `useEvolutionClient()` reads `event.context.mcpAuth` and has no branch that reaches a session user; it throws 401 if the key is absent, and again if the connection is not a WhatsApp one.
- MCP tokens are minted by this app (`wamcp_` + 32 random bytes) and stored **only** as a SHA-256 hash in the superuser-only `mcp_tokens` collection. A token resolves to one `instances` row, which carries that account's Evolution token.

`McpAuth` is a **union discriminated on `kind`** — `{ kind: 'whatsapp', evolution }` or `{ kind: 'postgres' }`. A union rather than optional fields, so a handler reaching for `evolution` must first establish it is talking to WhatsApp. Postgres carries no credential object: the DSN lives on the instance row and `pgFor()` is the only thing that reads it, so copying it into request context would put a second live copy of a user's database password there for nothing.

**Failure-mode semantics matter here:** a PocketBase outage answers **503**, never 401. A 401 tells a client its credential is bad — an MCP client discards a token it should keep, and a browser user gets silently signed out mid-outage. Both surfaces make the distinction: `resolveMcpAuth` returns `undefined` (→ 401) only on a genuine 404, and `getSessionUser` only on 401/403/404 from `authRefresh`. Everything else rethrows as 503. Preserve that in any auth code you add.

**A handled `createError` is not logged by Nitro.** Only unhandled/fatal errors reach its error handler, so a deliberate 503 produces a response with *nothing whatsoever* in the server logs — which is how an outage turns into guesswork. Both admin-auth and session failures log the underlying cause themselves, and say which of the two fixes applies. Do the same for any handled error an operator would need to diagnose.

## MCP wiring

Built on `@nuxtjs/mcp-toolkit` (**pinned to 0.19.0**). It auto-imports `defineMcpHandler` / `defineMcpTool` and configures the server via the `mcp` key in `nuxt.config.ts`.

**Adding a tool:** drop a file in `apps/web/server/mcp/tools/<kind>/` — discovery is automatic and recursive, no registration. Give every tool an explicit `name`, an explicit `group`, a `title` (shown in client UI), a `description` written for the model, and accurate `readOnlyHint` / `destructiveHint`. Copy `whatsapp/get-connection-status.ts` (read) or `postgres/run-statement.ts` (write).

**Every tool is gated on kind as well as scope.** `isToolAllowed(event, name, kind)` checks both, and both fail closed. The kind half is not decoration: a Postgres token minted with `all_tools` would otherwise register `send-text-message`, whose handler calls `useEvolutionClient()` on a row with no Evolution credentials. Which tools *exist* is a property of the connection; which of those a token may call is a property of the token, and that is the only order that composes.

Three facts about discovery, verified against 0.19.0 and worth not rediscovering:

- **A tool's name comes from the file's basename, never the directory.** `_meta.filename` is set with `path.split('/').pop()` (`loaders/utils.js:94-96`), and the fallback in `definitions/utils.js:13-16` kebab-cases only that. Moving a tool between group directories therefore cannot rename it — which is what made the `tools/` → `tools/whatsapp/` move safe for every `tool_names` row already minted. Every tool sets `name` explicitly anyway.
- **`group` is exactly the directory segment** (`loaders/utils.js:167-178`), read back as `def.group ?? def._meta?.group`. It is also stated explicitly on each tool, so a future move cannot silently re-gate one.
- **Basename collisions are global, not per-group.** `loaders/index.js:19-34` only warns, and `McpServer.registerTool` then throws on the duplicate. Keep every basename unique across groups.

**`enabled` is evaluated twice per request per tool** — once in `filterRawDefinitions` via `handler.js:12`, once again in the toolkit's own `filterByEnabled` (`utils.js:17-24`). Keep it a synchronous property read.

**Per-kind `instructions` cannot be a getter, and this is not obvious.** `createMcpHandler` calls `resolveConfig(config, event)` as its *first* statement (`utils.js:195`) and only reaches the auth middleware at `:208`, so anything read off the handler object — including a getter — fires before `event.context.mcpAuth` exists and would serve one kind's prose to the other on every request. The working seam is the `mcp:config:resolved` Nitro hook at `:203`, which fires inside `next()` on the object then handed to `createMcpServer`; `server/plugins/mcp-instructions.ts` uses it. `mcp.name` genuinely cannot vary — it is read in the same too-early pass. `nuxt.config`'s `instructions` stays the WhatsApp text so a regression degrades to today's behaviour, and the toolkit logs a throwing hook rather than swallowing it. The hook's type is declared locally in `server/types/mcp-hooks.d.ts` because the toolkit ships the augmentation outside its `exports` map. **A toolkit bump means re-checking that ordering.**

**Reactions are excluded from reads and searches by default.** Evolution stores every 👍 as an ordinary `Message` row — its own id, author, timestamp and type, to carry one emoji — so in an active group they are a large share of a page and almost never help reconstruct a conversation. `read-messages` and `search-messages` both take `includeReactions`, default `false`, and both say `reactionsExcluded: true` in the response when they left them out; a page that silently drops a message class reads as "nobody reacted". Both paths exclude them in SQL, on the **payload** — `message->'reactionMessage' IS NULL` — and never on `messageType`, because `messageType` is Baileys' `getContentType()` verbatim: it returns the *first* `conversation`/`*Message` key, so a reaction arriving with a `messageContextInfo` is typed as that instead. The payload is the authority; the type is a hint. `searchMessages()`' `COALESCE` also carries a `reactionMessage->>'text'` arm — before it, a reaction had no `body` and `body IS NOT NULL` dropped it, silently rather than by decision.

**Control records are dropped; edits are not.** Three types arrive with nothing readable where the extractors look, and they need three different answers — `classifyContent()` in `chats.ts` gives them. `protocolMessage` is WhatsApp's control plane (deletions, disappearing-message timers, key exchanges, history-sync notifications): dropped, and **counted** as `protocolMessagesExcluded` on `MessagePage` and in the `read-messages` envelope, because a page that quietly loses a class of row reads as a complete one. The exception is `type: 14` (MESSAGE_EDIT), which nests the whole `editedMessage` — that one is unwrapped and kept, with `editOf` naming the message it replaces. Keeping it is not a nicety: Evolution's live path skips every top-level `protocolMessage` (`baileys.service.ts` checks `received.message.protocolMessage` and `continue`s before the insert), so these rows exist only from history sync, where nothing patches the original — the edit row is the *only* copy of the new text. `associatedChildMessage` is not noise at all: it is a `FutureProofMessage`, a transparent `{ message: Message }` wrapper that official WhatsApp clients use for album media and caption edits, so it is **unwrapped, never filtered** — filtering it would delete real messages. `secretEncryptedMessage` is an *encrypted edit* (`SecretEncType`: `EVENT_EDIT=1`, `MESSAGE_EDIT=2`), not a view-once and not a disappearing message; it is kept with no `text` and `unreadable: 'encrypted-edit'`, because a caller told only "encrypted" reports the wrong gap. Decryption is out of scope — the key derives from the *original* message's `messageContextInfo.messageSecret`, which the row does not carry, and neither Baileys rc.9 nor Evolution 2.3.7 attempts it.

Four things about that are easy to get wrong later. **`protocolMessage.type` is an integer, and absent means REVOKE** — proto3 omits a zero, so a deletion arrives carrying no `type` at all; reading that as "unknown, so keep" surfaces every deletion as an empty message, which is the bug this exists to fix. Same trap in `secretEncType`, which is why `UnreadableReason` has a second `'encrypted-content'` value rather than asserting an edit it cannot show. **None of it can move into `where.messageType`**: that column carries no subtype, so excluding `protocolMessage` upstream would delete every edit with the bookkeeping, and `associatedChildMessage` has to be kept — hence the drop is local, `total` (and so `totalMatching`) overcounts by whatever was dropped, and the count is reported rather than subtracted. Subtracting it would be right for one page and confidently wrong across a range. **`hasMore` is still counted on `records`**, before both the reaction and the control-record filters, or a bookkeeping-heavy page reads as the end of the conversation. And in `searchMessages()` the nested `COALESCE` arms name **explicit paths only** — a `$.**` recursive jsonb path would also match `contextInfo.quotedMessage.conversation` and make a reply findable by the text it quoted, which is misattribution by construction.

Deliberate non-goals, so they are not mistaken for oversights: a deletion is dropped like any other control record rather than surfaced as "this was retracted" (the original row stays in history with its text, and nothing marks it); `ephemeralMessage` and the `viewOnceMessage*` family are *not* unwrapped, because flattening a view-once photo to a bare `[image]` presents it as an ordinary photo and doing it honestly needs its own marker; and album items are surfaced individually rather than grouped by `messageContextInfo.messageAssociation.parentMessageKey`.

**Tools take no connection argument.** The token is bound to one instance, so `useMcpAuth()`, `useEvolutionClient()` and `pgFor()` already resolve to it. Adding an instance parameter would reintroduce the possibility of addressing the wrong number — and now the wrong database. Never accept an Evolution API key or a DSN as a tool argument either.

**`nitro.experimental.asyncContext: true` is required — do not turn it off.** Tool handlers are invoked by the MCP SDK with its `RequestHandlerExtra`, not an H3 event, so `useEvent()` is the only way to reach per-request credentials, and it needs async context.

**`modules/mcp-token-route.ts` is deliberately fragile.** It deep-resolves a file inside `@nuxtjs/mcp-toolkit` that is not in the package's `exports` map, to register `/mcp/:token` against the same handler (Claude and other clients cannot attach an `Authorization` header to a custom connector). A middleware URL rewrite does not work — h3 1.15.x re-assigns `event._path` before every layer. If a toolkit upgrade moves that file the module throws at build with a pointer to the documented fallback. Bumping the toolkit version means re-verifying this module.

**Token redaction:** `server/plugins/redact-mcp.ts` scrubs `event.node.req.originalUrl` (what Nitro's error handler actually reads — scrubbing `event.path` alone is insufficient) and sets `event.context.noLog`. `mcp.logging` is off for the same reason. Route any error reporter or logger you add through `redactPath` / `redactHeaders` in `server/utils/redact.ts`.

## Credential rules that are easy to break later

**No global-key fallback in per-instance credentials.** `credentialsForInstance()` returns `undefined` when an instance has no `api_key`, and callers must fail. Falling back to a global key would hand any MCP token holder access to *every* account on that Evolution server. Global keys have exactly two callers, both in `server/utils/instances.ts`: create and delete.

That rule now has a sharper edge, because a global key can sit **on the instance row itself**: `instances.admin_key` holds the key for a bring-your-own Evolution server. `credentialsForInstance()` must never read it, which is why its parameter is typed `Pick<AppInstance, 'base_url' | 'api_key'>` — the field is not even in scope.

**The global key from config is used only against the URL from config, and a user's key only against their own URL.** `evolutionAdminCredentials()` returns `undefined` for half a bring-your-own configuration rather than completing it from ours. Sending our global key to a server the user chose hands them every account on ours; sending their key to our URL is a probe of ours. Neither is a fallback, and there is no branch that produces either pairing.

**User-supplied hosts go through `server/utils/net-guard.ts`.** A DSN or Evolution URL is an outbound connection to an address a user chose, and `postgres://…@postgres:5432/evolution` pasted into the create form reaches Evolution's own database — every user's messages. Two checks: address class (loopback, RFC1918, CGNAT, link-local, NAT64, `::ffff:` v4-mapped), disableable with `NUXT_ALLOW_PRIVATE_TARGETS` because a single-tenant self-hosted deployment needs it; and this deployment's own backends, resolved from config and matched on `address:port`, which is never disabled and is what still stops `postgres:5432` when the first check is off. The opt-out is deployment-wide and must stay that way — a per-connection checkbox would let any user disable the guard for themselves, which is the whole attack.

Only Postgres **pins** the approved address (`postgres({ host })`, so the driver never resolves the name itself). The Evolution path re-checks before every request but cannot pin, because `$fetch` resolves DNS for itself; closing that window needs an undici `Agent` with a `connect` hook, and `undici` is not a direct dependency. The residual rebinding window is documented at the call site in `evolution.ts` — do not delete that note without closing the hole.

**`hidden` is an API-projection flag, not encryption.** `api_key`, `admin_key` and `dsn` are absent from the REST projection, including to the owning user, and sit in clear in `pb_data` and in every backup.

**The Evolution database connection is read-only, and it is now the only way messages are read at all.** `server/utils/evolution-db.ts` is the one file that talks to Evolution's Postgres. It began as a search escape hatch — 2.3.7's `POST /chat/findMessages` accepts a `where.message` and never reads it, so a content search returns an unfiltered page that reads as a result set, and that field is a trap — and `read-messages` joined it for a second reason, below. `NUXT_EVOLUTION_DATABASE_URL` is therefore **required**; there is no HTTP fallback to keep in step, and a missing value is announced once at startup (`server/plugins/evolution-db-check.ts`) and answers 500, not 503, because it will not fix itself on a retry.

The connection is far wider than anything else the app holds (every user's messages, every instance), so four things are load-bearing: the role is `SELECT`-only on `"Message"` and the app never writes or runs DDL; every query carries `"instanceId" = <this account>`, which neither `searchMessages()` nor `listMessagesPage()` can be called without; chat scope is a **predicate in the SQL**, not a filter applied to rows after they are read; and the module returns rows, never rendered messages — naming a sender and previewing a payload belong to `chats.ts`, which is what keeps the import one-directional. `resolveEvolutionInstanceId()` throws rather than querying without an id — `createInstance()` can store `''`, and an empty id would mean a query with no account predicate at all.

**One message is stored more than once, and the app must collapse it.** 2.3.7 dedupes a history import against an in-memory `Set` of `key.id` rebuilt from the database at the top of each `messaging-history.set`, and the `createMany` behind it passes `skipDuplicates` — inert, because the only unique constraint on `Message` is a `@default(cuid())` primary key that can never collide. Nothing in the schema stops a second write, so two batches in flight together, or an import racing live traffic, both insert; `enableFullHistorySync()` is what puts them in flight. The copies disagree about the sender, each carrying whatever `pushName` was on the wire — a real name, a bare LID, a LID JID, or the sender's own device-locale self-label (`Você`). Reported raw, one message reads as three from three different people, a range reports triple its true size, and pages come back ragged. Collapsing after the fact cannot fix it: `skip`/`take` are applied upstream to the duplicate rows, so the page boundaries are already drawn in the wrong place. Hence `DISTINCT ON (m.key->>'id')` inside a CTE with `LIMIT`/`OFFSET` outside it, on **both** queries. `bestNamed()` decides which copy survives and must stay deterministic — otherwise an identical second call returns a different author.

## Postgres connections: what the allowlist does and does not close

`pg-pool.ts` connects, `pg-guard.ts` decides what a statement may touch, `pg-run.ts` composes the two, `pg-catalog.ts` introspects. The honest summary, which belongs in front of every change here: **the table allowlist keeps a model inside the tables it was pointed at; the security boundary is the database role on the DSN.** README carries the `GRANT` recipe.

**Four checks, and each closes something the obvious design leaves open.** All verified against Postgres 16.

1. **One statement, enforced by the protocol.** `sql.unsafe(text)` with no parameters defaults to `simple: true` (`postgres/src/index.js:119-126`) — the *simple* query protocol, which runs everything after a semicolon: `SELECT 1; DROP TABLE t` executes both. `unsafeSingle()` forces the extended protocol, where Postgres itself answers 42601 to a second statement. It exists as one function precisely so no call site can write the options inline and be one `simple` away from a bypass. `simple` is honoured at runtime but missing from postgres.js's `UnsafeQueryOptions`, hence the cast.
2. **`DECLARE CURSOR` is the statement-kind gate for reads,** not a `SELECT * FROM (…) LIMIT n` wrap. Postgres's grammar refuses `INSERT`/`UPDATE`/`DELETE`/`CREATE TABLE AS` outright, refuses `SELECT … INTO` by name, and answers 0A000 to a data-modifying `WITH`. `FETCH FORWARD n+1` is then the row cap. A wrap would have broken on a trailing line comment and on duplicate output column names — and would not have caught the shapes in (3).
3. **Plan inspection, with four traps.** `EXPLAIN (FORMAT JSON, VERBOSE)`, walking *every* element of the top-level array because the rewriter emits one per rule.
   - `VERBOSE` is **mandatory**: without it a `ModifyTable` carries `Relation Name` and no `Schema`. A relation with no schema is refused, never assumed `public`.
   - Key strictly on `Relation Name`. A `Function Scan` node carries a `Schema` and a `Function Name` but no relation, so collecting `Schema` opportunistically fabricates pairs.
   - **`CREATE TABLE AS` and `SELECT … INTO` plan to a bare `Result` node with no target relation, and `REFRESH MATERIALIZED VIEW` answers the literal string `"Utility Statement"` with no `Plan` key at all.** A relations-only check reads all three as "touches nothing". Hence: every top-level element must be an object with a `Plan`, and a write must have a `ModifyTable` **root** with `Operation ∈ {Insert, Update, Delete, Merge}`.
   - **A partitioned table never surfaces its parent** — a `SELECT` on `public.t` plans as `Append` over `t_p1`, `t_p2`. The allowlist is expanded *downward* through `pg_inherits`; expanding cannot admit a sibling, mapping the plan upward could. This one is a correctness bug that reads to a user as a security bug.
4. **Function gate.** `SELECT pg_read_file('/etc/passwd')` plans to a `Result` node with **zero relations**, and so does any call into a plpgsql body — relations alone do not contain a query. Function names are collected from the plan's expression strings (a heuristic that errs toward refusing; names resolving to nothing are ignored), resolved against `pg_proc`, and anything outside `pg_catalog`, anything `prosecdef`, and a denylist of reaching builtins is refused.

**One transaction, not two.** The plan check and the execution share it, so EXPLAIN's `AccessShareLock` is still held when the statement runs — that is what stops a concurrent `CREATE OR REPLACE VIEW` from repointing a view between check and execution — and both run under one `SET LOCAL`, so the same text provably resolves to the same objects. Reads use `sql.begin('read only', …)`; a `CREATE TEMP TABLE` inside that fails 25006, which is the last line of defence beneath the other three.

**`SET LOCAL` goes through `set_config(name, value, true)` as bind parameters.** Its `value` is a plain `text` parameter, so nothing is interpolated into SQL text. A literal `SET LOCAL search_path = …` would be string-built DDL over user-chosen schema names.

**`search_path` is pinned but is not the control.** The plan reports every schema fully resolved by the planner whatever the path was. Pinning buys two other things: the check and the execution agree, and an unqualified name lands inside the allowlist rather than resolving elsewhere and being refused confusingly.

**Never `EXPLAIN ANALYZE`.** It executes everything, triggers included. Plain `EXPLAIN` does not — `EXPLAIN (FORMAT JSON) SELECT pg_sleep(3)` returns in 50 ms.

**Table names are matched case-sensitively, on both halves.** Postgres folds *unquoted* identifiers when parsing but stores what was created — Evolution's own tables are `public.Message` and `public.Chat`. Folding would refuse a legitimately allowlisted table; loosening would let `public.orders` match a different `public.Orders`.

**Scope is a predicate in the SQL, never a post-filter** — `listPgTables` puts the allowlist in the `WHERE`, and `describePgTable` in its anchor CTE. Same rule as chat scope, and it is why `hasMore` means "more tables you can see" rather than "more rows we then hid".

**Deliberate holes, documented rather than papered over.** Triggers are invisible to `EXPLAIN` without `ANALYZE`, so a write to an allowed table can cascade anywhere. `postgres_fdw`/`dblink` name the local foreign table, not the remote object. `pg_catalog` and `information_schema` stay readable, so schema names leak regardless of the allowlist. A superuser DSN makes all of it best-effort — `probePgConnection` detects that so the UI can say so.

**The pool cache is keyed on the connection id, not the DSN.** A DSN-keyed Map holds every user's database password as a live string in something that shows up in a heap snapshot; the id finds the pool and a fingerprint notices a rotation. Eviction runs on acquire, not on a timer — an interval outlives nothing useful in a worker the platform stops and starts. `onnotice` is silenced because a `RAISE NOTICE` in a trigger can carry row data into the process log, which is the one place this must not leak to.

**A DSN change does not invalidate tokens, on purpose.** Tokens name the *connection*, not the credential. Making an owner reissue them because a password rotated would be a reason not to rotate it.

**Hidden fields require the admin client.** `instances.api_key` is a `hidden` PocketBase field. It is absent from anything fetched with a session-scoped client, including `getSessionUser()`'s `authRefresh`. Anything that needs it must go through `pocketbaseAdmin()` — `requireOwnedInstance()` already does.

**Never normalise JIDs locally.** Evolution's `createJid` carries country-specific rules (Brazil's ninth digit, Mexico and Argentina prefixes). A JID stored by our rules but matched by theirs is a token scope that silently reaches the wrong chat, or refuses the right one. `resolveNumberToJid` in `server/utils/mcp-scope.ts` asks Evolution; both storing a scope and checking one go through it.

**`enabled` guards cannot see tool arguments.** They receive only the event, so they can gate a whole tool — including by connection kind — but not "this tool, for this chat" or "this tool, for this table". Anything argument-dependent belongs in the handler: every chat check, and the whole Postgres plan walk. See the table in `mcp-scope.ts`.

**PocketBase materialises an unset boolean as `false`, not absent.** A write path that forgets `all_tools` mints a token that can call nothing. `scopeFields()` in `tokens.ts` always writes all **six** scope columns for this reason — `all_chats`/`chat_jids`, `all_tables`/`table_names`, `all_tools`/`tool_names` — whatever kind the connection is. The same trap applies to a SelectField, which materialises as `''`: it is why the `kind` migration backfills before marking the field required, and why `instanceKind()` exists.

## History arrives once, at pairing

WhatsApp pushes a burst of past conversations while a device is being linked, and never again. **No endpoint fetches history after the fact** — not in this app, not in Evolution, not in Baileys in any form that works for a linked device. `/chat/findMessages` reads Evolution's own Postgres, not WhatsApp. Do not go looking for a date-range import; the upstream request for one was closed unimplemented, and `fetchMessageHistory` appears in Evolution only behind a debug easter-egg whose result is `console.log`ed and discarded.

Three preconditions, two of which must hold **before** the QR is scanned:

- `DATABASE_SAVE_DATA_HISTORIC=true` on the evolution service. Evolution checks it once, inside the `messaging-history.set` handler, and drops the whole payload if it is false. It is not one of the flags that covers live traffic.
- `syncFullHistory: true` in the `POST /instance/create` body (`provisionInstance` in `server/utils/instances.ts`). It reaches Baileys' socket config, so it only takes effect when a socket is constructed.
- A genuinely fresh device link. Reconnecting an existing session sends nothing.

`enableFullHistorySync()` is what backfills an account paired before this existed: it writes the setting, then logs the instance out so the next connect is a new device link. It is exposed at `POST /api/instances/:id/resync` and behind a confirm dialog, because the cost is a QR scan on a real phone — see the pairing warning below. Re-importing is safe: Evolution skips messages whose `key.id` it already holds, so it merges rather than duplicates.

**Writing a settings change is read-modify-write, never partial.** Evolution's `setSettings` copies every field of the request body onto the live instance's in-memory settings, so a key you leave out becomes `undefined` on a running socket. Its schema also marks all six booleans required and types `msgCall`/`wavoipToken` as `string`, so a partial body — or one echoing back the `null` that `settings/find` returns for an unset string — is a 400. `settingsBody()` in `instances.ts` handles both; go through it.

**`syncFullHistory: true` also turns off Evolution's group filter.** Its `shouldIgnoreJid` stops excluding `@g.us` regardless of `groupsIgnore`, so group chats sync and show up in `list-chats` and the token scope picker. Per-token chat scoping contains that, but it is a wider default surface than before.

**Bumping the pinned Evolution tag means re-verifying this.** Specifically: that `messaging-history.set` still gates on `SAVE_DATA.HISTORIC`, that the settings schema still requires those six booleans, that `syncFullHistory` still reaches the socket config, and that `Message` still has no unique constraint on the message id (if one ever appears, the duplicates stop and the dedupe becomes belt-and-braces rather than load-bearing). Also that `prepareMessage` still calls `getContentType` on the **un-normalized** payload, so a wrapper still types its own row — a bump onto a Baileys whose `normalizeMessageContent` unwraps `associatedChildMessage` makes the local unwrap a no-op rather than breaking it, but the paragraph above would then be describing something that no longer happens — and that `ProtocolMessage.Type.MESSAGE_EDIT` is still `14` and still stored as an integer. Message reads no longer depend on `fetchMessages`' envelope, ordering or skip/take at all — they are SQL now — but `Message`'s columns are still Evolution's to change: `key` and `message` are `JsonB NOT NULL`, `messageTimestamp` is an `Int` of unix **seconds**, `contextInfo` is nullable, and `@@index([instanceId])` is the only index.

Reading it back: `listMessages()` in `chats.ts` takes `{ limit, page, since, until, includeReactions }` and delegates to `listMessagesPage()` in `evolution-db.ts`. Range bounds are ordinary SQL predicates, so a one-sided range means one predicate — the old widening (Evolution honoured a `messageTimestamp` filter only with **both** bounds set) is gone with the HTTP path. `chats.ts` keeps the shaping: `previewOf()` for the payload, and one name directory used for both the authors and the @-mentions.

**A page must say it is a page.** `listMessages()` returns `MessagePage` — `{ messages, hasMore, total? }` — not a bare array, and `read-messages` surfaces `hasMore`, `nextPage`, `covered` and a `note` in words. It reads newest-first, so truncating a `since`-bounded window drops the **old** end: precisely the part a caller who named a date range asked for, keeping the part they would have got without asking. Returned bare it reads as the complete window, and the summary written from it has a hole in it — which is the bug this replaced.

Two rules hold that up. `hasMore` comes from fetching `limit + 1` rows and is **never** derived from `total`, even now that `total` is exact: a count that went wrong would otherwise drive a caller into paging forever, whereas a full final page merely costs one extra call that returns nothing. And `read-messages` still pins `until` itself as soon as `since` is given — not because a bound would be ignored, but because an unpinned upper bound moves between calls, so page 2 would come from a different range than page 1. The pinned window is echoed back as `window` for the caller to pass to the next page. No range is added when there is no `since`; `Message` is indexed by `instanceId` and nothing else.

`total` is a `COUNT(*) OVER ()` across the **deduplicated** set, taken from the same scan as the page, and surfaced as `totalMatching` with `totalPages` alongside. It counts distinct messages in the range asked for — not rows, and not the chat — so it can be quoted as an answer, which Evolution's own count could not: that one counted every copy. It rides on the returned rows, so a page past the end carries no count rather than a zero; "I did not measure" and "there are none" are different answers. Still read defensively (finite number or dropped).

Ordering is ours now, and both queries end `ORDER BY "messageTimestamp" DESC, key->>'id' DESC`. The tiebreaker is not decoration: Evolution's `orderBy: { messageTimestamp: 'desc' }` has none, and rows sharing a timestamp can then land on two pages or on neither. Pages stay 1-based and newest-first (`OFFSET (page - 1) * limit`).

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

The column rule below holds for top-level content only: a message nested inside `protocolMessage.editedMessage` or `associatedChildMessage.message` never went through that rewrite and keeps its own `contextInfo`, so `listMessages` falls back to the payload for exactly those rows — which are the ones the classifier just surfaced for the first time, and so the ones where the column under-delivers.

**Read it from the `contextInfo` column, not from `message`.** 2.3.7's
`prepareMessage` rewrites `extendedTextMessage` into `message.conversation` and
`delete`s the original, so a mentioning text message stores *nothing* under
`message->extendedTextMessage->contextInfo` — which is also why such a message
arrives with `messageType: "conversation"`. The mentions survive in the dedicated
`Message.contextInfo` column, which both queries in `evolution-db.ts` select as
`contextInfo->'mentionedJid'` — still a column of `"Message"`, so inside the
existing read-only grant.

**Names come from group participants first, contacts second.** Evolution's
`Contact` rows are written keyed on `key.remoteJid`, which for a group message is
the *group's* JID — a good source for 1:1 chats and a poor one for group members.
`GET /group/participants` is the authority on who is in a group, and a participant
is indexed under every identity it carries (`id`, `lid`, `phoneNumber`, `jid`)
because which form appears in `mentionedJid` is WhatsApp's choice. The directory is
keyed on the **local part** so either form resolves, and the lookup is display-only
— no JID is constructed and nothing addresses a chat by one, so the "never
normalise JIDs locally" rule below is not in play.

**The same directory names the sender.** `authorName()` resolves `key.participant`
through it and falls back to `pushName` only when that fails — never the other way
round, because `pushName` is whatever the sending device put on the wire and two
copies of one message routinely disagree. A value that is a number or a JID is
refused outright: an id in an `author` field reads as a name and gets quoted as
one. A message you sent has **no author at all** — `fromMe` already says so in a
field that cannot contradict itself, and the alternative is the localised
self-label sitting next to the account's real name on the very same message. That
was the reported bug.

Baileys stores `participant` for a group message on both the live and the history
path, and `participantAlt` (the sender's other addressing form) only on the live
one, so nothing may require the alternate to be there. In a 1:1 chat there is no
participant and the chat's own JID is the sender.

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

`requireOwnedInstanceOfKind()` answers 404 for the *wrong kind* too, for the same reason: the route genuinely does not exist for that connection, and a distinguishable error would confirm which id is which kind. The five WhatsApp-only routes — `qr`, `logout`, `resync`, `chats/*` — go through it.

## PocketBase

Two clients in `server/utils/pocketbase.ts`, and the distinction is a security boundary:

- `pocketbaseAdmin()` — memoized superuser client, re-auths on expiry, concurrent callers share one in-flight request. Reads the hidden fields (`api_key`, `admin_key`, `dsn`) and `mcp_tokens`. **Never build a filter for it from user input** (use `pb.filter()` with bindings, as `mcp-auth.ts` does).
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

**Provisioning is click-triggered, not on-mount.** Creating a WhatsApp instance reserves a live socket on the Evolution server, so a page refresh must never create a second account. A database connection is proved by actually connecting, which a refresh should not re-do either.

**The dashboard is two panels, not one with fields hidden.** `pages/instances/[id].vue` picks `InstanceWhatsapp.vue` or `InstancePostgres.vue` from `instance.kind`; a database has no QR, no profile and no message count, and rendering an empty version of any of those suggests a state it can be in. The page decides from `/api/instances/:id/summary` — a PocketBase read with no backend call — because the panel it picks then makes the expensive call itself, and deciding from a full status fetch would mean two.

**Only the axis a kind has is fetched by the scope picker.** `TokenScopeFields.vue` sets `immediate` per kind: asking a WhatsApp connection for its tables answers 404, and a 404 in the console on every dialog open reads as a bug. A new Postgres token starts read-only, with the read tools pre-checked from the server's own catalogue.

**The token list is shown even while a connection is down** — otherwise you could not revoke a token for an offline account or an unreachable database, which is exactly when you would want to.

**Restart the dev server after adding shadcn components.** The component manifest is built at startup; a component added while it runs renders as a literal unknown element (`<radiogroupitem>`) and SSR still returns 200. A page that loads is not proof that it works.

## Things that cost real money or a phone number

- **`docker compose down -v` forces a full WhatsApp QR re-scan.** `-v` deletes the `evolution_instances` volume holding every paired session. Use `down` without `-v` for routine restarts.
- **The WhatsApp stack is behind a compose profile.** `pnpm services:up` brings up PocketBase alone; `pnpm services:up:whatsapp` adds Postgres, Redis and Evolution. `services:down`, `:logs` and `:ps` pass `--profile whatsapp` unconditionally so they still cover everything — a profiled service you forgot the flag for looks simply absent, which is the one sharp edge profiles have.
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
