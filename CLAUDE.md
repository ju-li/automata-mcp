# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

One Nuxt/Nitro server exposing two surfaces:

1. **Web UI** — users create *connections* and mint connector tokens for them. PocketBase session cookie.
2. **MCP endpoint** — Claude connects to `/mcp` as a custom connector. App-minted bearer token.

A connection is a row in `instances` with a `kind`, and a connector token is bound to exactly one row. Two kinds exist:

- **`whatsapp`** — an [Evolution API](https://doc.evolution-api.com/) instance, paired by QR, on the Evolution server this deployment is configured with *or* one the user supplied.
- **`postgres`** — a user-supplied PostgreSQL DSN.

`kind` is read through `instanceKind()` in `mcp-scope.ts`, never off the record directly: PocketBase materialises an unset SelectField as `''`, and a row written before the field existed is a WhatsApp account. That default lives in exactly one function — and it covers exactly those two spellings: any other value throws, because PocketBase and Nuxt deploy separately and a row whose kind the running build has never heard of must be refused, not served as WhatsApp. Every per-kind branch is a `switch` ending in `assertNever` (`shared/connection.ts`), never an `if … else`, so adding a kind fails to compile everywhere it has not been decided.

PocketBase is the app's database (users, sessions, connections and their credentials). Evolution API, its Postgres and its Redis are dependencies you run **only for WhatsApp connections** — they sit behind a `whatsapp` compose profile, and the `NUXT_EVOLUTION_*` variables are optional.

`README.md` is the operator's manual — first-run setup, networking tables, the Linux firewall rule, Railway deploy, MCP client connection. Read it before doing anything involving Docker or the local stack; this file covers the code.

**Status:** the product loop works end to end for both kinds — sign up (which creates an organization), invite colleagues, create a connection, pair by QR (importing that number's WhatsApp history as it connects) or paste a DSN, per-connection dashboard, assign connections to members, and connector token provisioning with per-chat or per-table scoping. Ten MCP tools, gated by kind:

- `whatsapp`: `get-connection-status`, `list-chats`, `read-messages`, `search-messages`, `send-text-message`
- `postgres`: `get-database-info`, `list-tables`, `describe-table`, `run-query`, `run-statement` (write)

A WhatsApp connection that drops emails everyone who can reach it and emails them again on recovery — see "Disconnect alerts".

An organization may hold **several** connections of either kind. Each is a row in `instances`, owned by the organization rather than by a person, and each MCP token is bound to exactly one of them and issued to exactly one member. See "Organizations and roles".

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
  app/pages/                 login, signup, no-organization, team, invite/[code],
                             instances/{index,new,[id]}
  app/components/            app components + ui/ (shadcn-vue, bare names)
  app/composables/           useSession (user + org + role), useOrg, useConnectionState
  app/middleware/            auth.global.ts — session + organization gate
  modules/mcp-token-route.ts local Nuxt module — registers /mcp/:token
  server/api/                auth/, org/, invites/, instances/, tokens/
  server/mcp/index.ts        default MCP handler (auth middleware)
  server/mcp/tools/<kind>/    one file per tool, auto-discovered; the directory
                              sets `group`, which is what gates a tool to a kind
  server/utils/              pocketbase, session, auth-cookie, org, invites,
                             mcp-auth, instances, tokens, evolution, evolution-db,
                             mentions, redact, net-guard, pg-pool, pg-guard,
                             pg-run, pg-catalog
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

**It is no longer one pool, and where the URL comes from is a precedence rule.** A connection that brought its own Evolution server carries its own read-only URL in the hidden `instances.evolution_db_url`, because its messages are in *that* server's database. `messageDbUrlFor()` is the only place the rule lives: the connection's own URL wins; failing that, a connection on the deployment's own server falls back to `NUXT_EVOLUTION_DATABASE_URL`; failing that there is no answer and the read is refused with a **501** naming the missing setting, never an empty page. `onDeploymentServer()` is the single test for "is this our server", and it is shared rather than recomputed — the bring-your-own merge already produced one bug from computing it slightly differently in two places.

Pooling is delegated to `keyedPool()` in `pg-pool.ts`, shared with the Postgres connection kind, so the host guard, the approved-address pin, fingerprint invalidation on a rotated URL and the LRU ceiling exist once. **Its `guard` flag is asymmetric on purpose:** `true` for anything a user typed, and `false` *only* for `NUXT_EVOLUTION_DATABASE_URL`, which sits on our own private network and which `net-guard` would correctly refuse as this deployment's own infrastructure. Getting that backwards either breaks the default deployment or opens the hole the guard exists to close.

`probePgConnection(url, { requireTable: '"Message"' })` proves a user-supplied URL before it is stored. The `requireTable` half is not belt-and-braces: a URL with the right host, user and password but the wrong *database* connects happily and then matches no rows, which reads as an account with no messages — the same silent-empty answer this whole arrangement exists to prevent, one layer down.

The connection is far wider than anything else the app holds (every user's messages, every instance — and for a user's own server, every account on it, which may include accounts that are not theirs if they share it), so four things are load-bearing: the role is `SELECT`-only on `"Message"` and the app never writes or runs DDL; every query carries `"instanceId" = <this account>`, which neither `searchMessages()` nor `listMessagesPage()` can be called without; chat scope is a **predicate in the SQL**, not a filter applied to rows after they are read; and the module returns rows, never rendered messages — naming a sender and previewing a payload belong to `chats.ts`, which is what keeps the import one-directional. `resolveEvolutionInstanceId()` throws rather than querying without an id — `createInstance()` can store `''`, and an empty id would mean a query with no account predicate at all.

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

**Hidden fields require the admin client.** `instances.api_key` is a `hidden` PocketBase field. It is absent from anything fetched with a session-scoped client, including `getSessionUser()`'s `authRefresh`. Anything that needs it must go through `pocketbaseAdmin()` — `requireReadableInstance()` already does.

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

## Connection state lives in two places, and only one is true

`fetchInstances` returns `connectionStatus` from Evolution's **database** row. 2.3.7 writes that column when a socket opens and when it closes for a reason it will not retry (`loggedOut`, `forbidden`, 402, 406) — nowhere else. Every other close takes the retry path in `connectionUpdate`, which touches only the in-memory `stateConnection`, so if that retry never opens, the column says `open` indefinitely over a dead socket. Not hypothetical: production showed "Connected" for a week while every `/group/participants` call answered `428 Connection Closed`. `getInstanceStatus()` therefore takes `state` from `GET /instance/connectionState` (in-memory) and only the profile and counts from the row, and reports `unknown` — never the column — when the live read fails.

`sessionLost` is the disagreement: column `open`, live anything else. It is what separates a dropped session from no session, because a fresh instance and a logout both leave the column `close` and a QR on screen leaves it `connecting`. The dashboard gives it its own mode with a **Reconnect** button (`POST /api/instances/:id/reconnect` → `reconnectInstance()`).

Three things about reconnecting that are easy to get wrong:

- **The call depends on the live state.** `connect` rebuilds the socket only in `close`; in `connecting` it returns the cached QR object and does nothing, so a socket that hung while connecting needs `restart`. In `open` neither helps even if the socket is dead — Baileys' `end()` returns early on a socket it already closed — which is also why there is no liveness probe: it could detect that state, but nothing could act on it.
- **Both routes answer 200 with `{ error: true, message }` on failure.** A resolved request is not a success.
- **The QR poll must never run against a lost session.** It calls `connect`, which in `close` builds a new socket on every tick; pointed at an instance Evolution cannot bring back, that is a WhatsApp login every two seconds. `applyMode` in `InstanceWhatsapp.vue` keeps that poll to pairing mode.

A reconnect that has not landed within a minute means Evolution's own session for that account is stuck — most likely its serial event queue (`eventProcessingQueue`), which no API call replaces. Restarting the Evolution service recovers it without a scan, because `setInstance` auto-connects every row whose column is `open` or `connecting`, which a dropped session's column still is. The UI says so rather than leaving the button to be pressed forever.

`CONNECTION_UPDATE` webhooks would not have caught this: the retry path sends none, and the webhook is sent from inside that same queue. Re-verify all of the above on a tag bump — the column writes in `connectionUpdate`, `codesToNotReconnect`, the per-state branches of `connectToWhatsapp` and `restartInstance`, and `setInstance`'s auto-connect condition.

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

## Webhooks are registered per instance, and the global one is off

`registerConnectionWebhook()` in `instances.ts` does it, at provision time and again on every sweep. `WEBHOOK_GLOBAL_ENABLED` is `false` in `docker-compose.dev.yml` and in the README's Railway block, and turning it back on delivers everything twice.

Two reasons the per-instance route is the one that works, and they are independent:

- **Only the per-instance webhook sends custom headers.** The global one sends none, so `NUXT_WEBHOOK_SECRET` could never be satisfied by it — a value there made every delivery 401, which Evolution treats as non-retryable and drops rather than retries. That is why the secret was documented as "leave empty" until now, and why it should now be **set**.
- **A bring-your-own Evolution server has no `WEBHOOK_GLOBAL_URL` pointing here**, and no reason to. Global-only means those connections deliver nothing at all.

The global path had a second gate worth remembering if it is ever re-enabled: `WEBHOOK_GLOBAL_ENABLED` + `WEBHOOK_GLOBAL_URL` deliver nothing on their own, because Evolution also checks the matching `WEBHOOK_EVENTS_<EVENT>` flag and every one of them defaults to false.

## Disconnect alerts

`server/utils/alerts.ts` decides; `server/utils/mailer.ts` and `services/pocketbase/pb_hooks/mail.pb.js` deliver.

**Recipients are not a new policy.** `recipientsFor()` runs `authorizesInstance()` over `listOrgMembers()` — every admin of the owning organization plus the members the connection is assigned to, which is the set that can reach it and therefore the set it breaking is a problem for. Inventing a second definition of "reaches this connection" is how the two drift. One message each, never one addressed to all of them: these are colleagues, not a mailing list, and the `to` header would disclose the roster. `alerted_at` is written when the mail reached **anyone**, so one bad address does not queue a repeat to everyone else on every sweep. The outage mail is also role-aware — a member has no Reconnect button and never enters pairing mode, so telling them to press one reproduces in their inbox exactly the failure `InstanceWhatsapp.vue` is careful to avoid. Two date fields on `instances` hold the state — `down_since` (empty = healthy) and `alerted_at` (set = the current outage has been reported). Dates rather than a status field so neither PocketBase default (`''` for a select, `false` for a bool) can mean something unintended.

**The webhook cannot be the whole mechanism, and the sweep is not a backstop.** In 2.3.7 a close Evolution intends to retry emits *no* `connection.update` — `connectionUpdate` rebuilds the socket and returns, and only a close it will not retry (`loggedOut`, `forbidden`, 402, 406) sends anything. So the failure this feature exists for — a socket that died and stayed dead, the one `sessionLost` is built on — is invisible to the webhook by construction. The hourly `alerts:sweep` task is the only thing that sees it, because it performs a live read.

**The payload is a hint; the live read is the fact.** Neither path reads `state` off the delivery. Evolution v2 does not sign webhooks, and with no secret set the route is reachable by anyone, so trusting the payload would let a stranger mail a user that their account is down. A delivery resolves an instance by name, is rate-limited per connection (30s), and then goes through `getInstanceStatus()` like the sweep does.

Three rules in `evaluateConnectionHealth` that are easy to undo:

- **`ownerJid` absent means never paired, and is skipped.** A fresh connection sits in `close` until somebody scans its QR, and nothing else distinguishes that from a logout — both leave the column `close`.
- **A live `close` alerts immediately; everything else serves the grace period.** Evolution reports `close` live only once it has given up, so waiting on it adds nothing. `connecting` and `unknown` are the states that routinely resolve themselves.
- **`alerted_at` is written only after a mail actually went out.** A broken SMTP configuration then delays an alert instead of losing it. Same for the recovery mail clearing the fields.

The sweep is in-process, so **more than one replica mails more than once**. `nitro.scheduledTasks` needs `nitro.experimental.tasks`; both are in `nuxt.config.ts`.

PocketBase is the mailer because it has no generic send-email REST endpoint at all — every mail route it ships is auth-flow bound — so `pb_hooks/mail.pb.js` registers `POST /api/app/send-email` behind `$apis.requireSuperuserAuth()` and applies the SMTP settings from `PB_SMTP_*` on boot. **Turning SMTP on also turns on PocketBase's own login-alert mail**, so the superuser gets a "Login from a new location" message whenever the Nuxt server signs in from a new client — which is every restart. Disable the auth alert on `_superusers` in the admin UI if that noise matters; it is not disabled in code, because silently turning off a security notification is worse than the noise.

## Organizations and roles

A connection belongs to an **organization**, never to a person. Every signup silently creates one and makes that user its admin; joining another happens only by accepting an invitation. A user belongs to exactly **one** organization — `UNIQUE(memberships.user)` is that rule, and it is why accepting an invitation is an `UPDATE` of the existing membership row and never a delete-then-create: the row is the user's single slot, so one write is atomic and there is no window in which they belong to nothing.

Two roles. An **admin** manages the organization, invites, changes roles, creates connections, assigns them, mints tokens and edits token scope. A **member** uses the connections assigned to them, sees only their own tokens on those connections, and may revoke or rotate a token's secret but never widen it — rotating a leaked credential must not queue behind someone else's approval.

**Role is not a field on `users`, and the reason is not the obvious one.** `users` is the one collection a visitor's own PocketBase credential can write to (`updateRule = 'id = @request.auth.id'`; `pb_auth` is `httpOnly`, which hides it from `document.cookie` and not from the devtools Application panel). A `hidden: true` role field would *probably* hold — the non-superuser record upsert refuses to load hidden fields, which is what `instances.api_key` already relies on — but `hidden` means "absent from the API projection" everywhere else in this schema, and a superuser-only `memberships` collection needs no *probably*. The organizations migration also sets `users.createRule` and `users.deleteRule` to `null`: signup now creates the account through `pocketbaseAdmin()`, which is what makes "every user has a membership" an invariant rather than a hope, and there is deliberately **no** lazy self-heal — creating an organization for whoever turns up without one would hand a free one to anyone who can reach PocketBase, and silently resurrect a user an admin had just removed.

**`instances.created_by` does not cascade, and that is load-bearing.** It was `user`, `required`, `cascadeDelete: true`. Under org ownership a cascade there deletes `instances` rows straight out of the database whenever a creator's account goes — bypassing `deleteInstance()` entirely: no `/instance/delete` on Evolution, no pool closed, a live socket on a real phone number left running with nothing recording that it exists. `instances.org` is non-cascading for the same reason, so deleting an organization that still owns connections fails loudly. `mcp_tokens.assigned_to` **does** cascade: a deleted account's tokens must stop working.

**Authorization answers 404, then 403.** The old rule — ownership failures answer 404 so an id cannot be probed — still holds and gains a second half now that a connection can be visible to someone who may not act on it:

- **invisible → 404** — another organization's connection, an unassigned one for a member, a missing one. Indistinguishable, which is the point.
- **visible but forbidden → 403** — a member pressing Delete on a connection assigned to them. They are looking at it; refusing by role confirms nothing new and is a far better error.

`requireReadableInstance` / `requireManagedInstance` / `requireManagedInstanceOfKind` in `server/utils/org.ts` are the only implementations. The order inside the kind-gated one is **readable → role → kind**, and the role check must stay in front: kind-first would let a member probing `/dsn` distinguish 404 (a WhatsApp connection) from 403 (a Postgres one). Role-first answers 403 for a member whatever the kind. For an admin the wrong kind is still 404.

`requireReadableInstanceOfKind` consults **no role at all**, so `chats/*` and `tables` answer 404 for the wrong kind to everyone. Those two are reads a member is entitled to — an assigned connection's chats and tables are already reachable through `list-chats` and `list-tables` over MCP, and refusing them in the UI while serving them on the wire would be incoherent.

`resolveTokenForActor()` replaces the old `findOwnedToken`, whose `user = me` predicate is now wrong in both directions: too narrow, because an admin must reach a member's token, and too wide, because it never looked at the connection's organization. A token belonging to a colleague on a shared connection is a **404**, not a 403 — a member cannot see that it exists.

**The MCP surface answers the same question separately, and must keep doing so.** `resolveMcpAuth` loads the holder's membership and assignment itself; `org.ts` is for the session surface. What the two share is `authorizesInstance()` — a *pure* predicate over already-loaded facts, no event, no PocketBase — so the rule lives once while each surface keeps its own credential path and its own failure semantics. A single `getCurrentActor(event)` used by both would collapse the auth split.

**Every new PocketBase read on an auth path uses `firstOrNone()`, never `getFirstListItem`.** `getFirstListItem` throws 404 for an empty result *and* PocketBase answers 404 for a collection that does not exist, and `isPocketBaseNotFound` cannot tell them apart. Nuxt and PocketBase deploy as separate services with nothing ordering them, so a membership read written the obvious way turns a not-yet-migrated PocketBase into a **401 storm** — every connected client told its valid token was revoked, and invited to throw it away. `firstOrNone` makes an empty result a value and leaves a throw meaning a fault (→ 503). Verified: renaming `memberships` out from under a running server answers 503, not 401.

**Four ordinary actions would otherwise leave tokens that read "Active" and answer 401** — unassigning a connection, demoting an admin, removing a member, and minting for a member who holds no assignment. Each falsifies the MCP predicate without touching `mcp_tokens`, and `toPublicToken` computes status from the row alone. `revokeTokensFor()` exists for the first three; the fourth is refused at mint time. Never add a path that changes membership or assignment without dealing with the tokens it kills.

Every refusal inside `resolveMcpAuth` logs which half failed. A handled 401 is invisible to Nitro, and "my token stopped working" with nothing in the logs is the failure that rule exists to prevent.

## Invitations and membership changes

An invitation code is a **bearer credential for joining an organization** and is handled like an MCP token: `waorg_` + 32 random bytes, returned once, stored only as a SHA-256 hash, compared in constant time. `server/utils/invites.ts` is the only file that mints or resolves one.

**A code alone cannot join you to anything.** Every invitation names an email address, and acceptance requires the accepting account's own email to match, so a link forwarded into a group chat is not redeemable by whoever reads it first. Signing up *through* an invitation checks the address **before** the account is created — a bad code must not burn an email address, which is unrecoverable for the person holding it — and creates **no** personal organization, or every invited signup would make one and delete it again one request later.

**Accepting is an `UPDATE` of the membership row.** `UNIQUE(memberships.user)` makes that row the user's single slot, so one write is atomic, trips no index, and leaves no window in which they belong to nothing — and there is no transaction to wrap the delete-then-create alternative in. Two refusals, both 409: their current organization still owns connections (those are org-owned, so leaving strands them; migrating them would move a WhatsApp account and its history across a trust boundary on the strength of a link), or they are the only admin of an organization that still has other members. The emptied old organization is deleted afterwards, best-effort — a stranded empty organization is harmless, a failed cleanup must not fail the join.

**The last admin is guarded twice, and both are needed.** `assertAdminSurvivesChange()` is a read-only pre-check: it loses a race, so it is not the authority, but it is what makes the ordinary refusal have **no side effects**. `assertAdminSurvives()` runs after the write and undoes it if the admin count hit zero: that one is the authority, and it turns a permanent lockout into a retry. Neither may be "simplified" away — the first has no teeth, the second has no manners.

**`removeMember` deletes the membership first and revokes tokens only once the removal has stuck.** The obvious order is the opposite — revoke first, so a crash over-revokes rather than under-revokes — and it is wrong for an operation that can be *refused*. The first version revoked an admin's connector tokens on its way to telling them they could not leave, and the compensating action restored the membership but could not un-revoke anything. The residual risk, a crash between the delete and the revoke, is closed at the other end: `acceptInviteInto()` revokes whatever a joiner still holds, so old tokens cannot come back to life on a re-invite.

**A demotion that would kill tokens is refused with a 409 and a count, not done quietly** — the caller retries with `revokeTokens: true`, which is an admin saying yes to that specific consequence. The last-admin check runs *before* the token question, so an absolute refusal never arrives dressed as a confirmable one. Only tokens on connections the demoted admin will no longer reach are revoked; ones on connections assigned to them keep working.

Pending invitations are admin-only on `/api/org`; the member roster is not, because "ask an admin to assign you a connection" is only actionable if you can see which of your colleagues is an admin. `/api/invites/:code` is reachable signed out — holding the code is the authorization — and exposes only the organization's name, the invited address and the role. **An invitation link escapes every redirect in `auth.global.ts`**, including the org-less one: someone who has just been removed must still be able to open one and accept it.

## Assignment, token assignment, rotation

**Assigning a connection grants use, never management.** A member with an assignment gets the dashboard and may hold connector tokens on it; they cannot delete, reconnect, resync, re-pair it or rotate its credentials. Admins hold **no** assignment rows at all — they reach every connection in the organization — so an empty assignment list is not the same as no access, and `authorizesInstance()` consults the role first.

**Minting for someone who cannot reach the connection is refused (422), and the assignment is not created as a side effect.** Such a token is born dead: it would render as "Active" and answer 401 on every call, with nothing in the Nitro log. Auto-assigning instead would quietly make "give them a token" mean "give them the dashboard", which is a different decision and belongs to a different button.

**Unassigning revokes that member's tokens on that connection, in the same handler.** This is the last of the four operations that can silently kill a token — the other three are in the membership section above — and each one deals with the consequence where it causes it. The assignment listing carries a live-token count per person so the confirmation can name the cost rather than asking "are you sure".

**Rotation replaces the secret and nothing else.** It is the one write a member may make to their own token, because responding to a leak must never queue behind someone else's approval; and it is safe to give them precisely *because* scope is untouched — rotating changes what the secret is, not what it reaches. `expires_at` and `last_used_at` are left alone too, which is why a revoked or expired token is refused with a 422 rather than rotated into a new secret that is already dead. The plaintext is returned here and nowhere else, exactly as at creation.

**`canManage` is computed server-side** and returned on `/api/instances` rows and on `/api/instances/:id/summary`; the UI never recomputes it from the session role. Same argument as `canReadMessages`: one rule, one place.

**A member never enters pairing mode in `InstanceWhatsapp.vue`.** That is a safety property, not tidiness. Pairing mode runs the QR poll, which calls `/instance/connect` — refused with a 403 for them, so it would be a failing request every two seconds forever; and pairing binds a real phone number, which is management. They get the `lost` wording without the Reconnect button, and every hint that tells someone to act (`describeState`'s text, the "re-import under Manage" footnote) is replaced for them with what the state *is* and who can fix it. A UI that instructs someone to press a button they do not have is worse than one that says nothing.

## PocketBase

Two clients in `server/utils/pocketbase.ts`, and the distinction is a security boundary:

- `pocketbaseAdmin()` — memoized superuser client, re-auths on expiry *and* when PocketBase rejects an unexpired token (a restart rotates the key through `superuser upsert`; that request is retried once), concurrent callers share one in-flight request. Reads the hidden fields (`api_key`, `admin_key`, `dsn`) and `mcp_tokens`. **Never build a filter for it from user input** (use `pb.filter()` with bindings, as `mcp-auth.ts` does).
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
