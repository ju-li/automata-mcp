# WhatsApp connections

## Reading and searching messages

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

**Which credential.** The same URL as `NUXT_DATABASE_URL` works, and it is what
the [Railway setup](deploy-railway.md) uses. Every query the app sends here is fixed SQL with
bound parameters — nothing a model or a user writes reaches this connection as
SQL — and the pool opens each session with `default_transaction_read_only`, so a
write fails even under a superuser. That setting is a backstop, not a boundary: a
superuser can switch it off, but only through SQL, and the app never sends any it
did not write.

```bash
NUXT_EVOLUTION_DATABASE_URL=postgres://evolution:change-me@localhost:5432/evolution
```

**Optional hardening: a role that can do nothing else.** This connection reaches
every user's messages in every instance. A dedicated role does not protect them
from a compromised web service — that process already holds `NUXT_DATABASE_URL`,
the database's owner — but it does contain a bug in the app's own message queries
to reading `"Message"`, where under the owner such a bug would reach every stored
credential in the `app` schema. If you want that, the grants below serve reading,
searching and connection status:

```sql
CREATE ROLE wamcp_search LOGIN PASSWORD 'change-me';
GRANT CONNECT ON DATABASE evolution TO wamcp_search;
GRANT USAGE ON SCHEMA public TO wamcp_search;
GRANT SELECT ON "Message" TO wamcp_search;
-- Connection status: the account's own row and per-account counts.
GRANT SELECT ("id", "connectionStatus", "ownerJid", "profileName", "profilePicUrl", "number", "disconnectionAt", "updatedAt")
  ON "Instance" TO wamcp_search;
GRANT SELECT ("instanceId") ON "Chat", "Contact" TO wamcp_search;
```

The `"Instance"` grant is column by column on purpose: the same row holds
`token`, every instance's API key, and this role has no reason to read it.

**Why status reads this database at all.** Evolution's `fetchInstances` answers
with message, chat and contact counts that Prisma computes over *every* account's
rows and joins to the one asked about — a full scan of `"Message"` on every call.
With this URL set, the dashboard, the connection list, the alert sweep and
`get-connection-status` read the account's `"Instance"` row by primary key, and
count only that account's rows, caching the counts for five minutes (the history
import screen after pairing asks for them fresh; the alert sweep reads no counts
at all). A role created before these grants existed still works: status falls
back to `fetchInstances`, cached per connection for five minutes, and the web
log says a grant is missing. Without this URL at all — a bring-your-own server
with no database URL — that cached fallback is the only path.

`"updatedAt"` is what tells a reconnect loop from a healthy connection (see
"Stuck reconnecting" below). It has no fallback: without the grant everything
else keeps working, the log says the column is unreadable, and loops go
undetected.

```bash
NUXT_EVOLUTION_DATABASE_URL=postgres://wamcp_search:change-me@localhost:5432/evolution
```

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
  only what arrived after — see [Importing existing history](#importing-existing-history).
- Reads are deduplicated by message id, so `totalMatching` counts distinct
  messages and can be quoted as an answer. It will often be smaller than the row
  count Evolution's own API reports for the same range. The two are not
  comparable, and the smaller one is the true one.
- **The dashboard's chat count and `list-chats` count different things.** The
  count is every conversation the phone listed at pairing; `list-chats` lists
  conversations Evolution holds messages for, which is routinely fewer. The gap
  is not more pages — `hasMore` is the only signal that there are.
- **There are no unread counts.** Neither `list-chats` nor the dashboard says
  which chats are unread, and the tool tells the model so. Evolution 2.3.7 does
  not keep the one signal that says a chat was read on the phone, and an unread
  count derived from message statuses was tried and found wrong (651 "unread" on
  an account with no unread badges).
- **Group names can lag by up to six hours.** Fetching an account's groups from
  WhatsApp costs about two WhatsApp queries per group and drew `rate-overlimit`
  answers when it ran every few minutes, so it runs at most once every six hours
  per account (an hour after a failed attempt), in the background, and the
  result is kept in `app.whatsapp_groups`. A group joined or renamed since the
  last scan shows its old name, or the contact name or bare id, until the next
  one. Chats and their last messages are read live; only group names lag.
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
  GRANT SELECT ("id", "connectionStatus", "ownerJid", "profileName", "profilePicUrl", "number", "disconnectionAt", "updatedAt")
    ON "Instance" TO evo_reader;
  GRANT SELECT ("instanceId") ON "Chat", "Contact" TO evo_reader;
  ```

  It is checked before it is stored — including that `"Message"` is actually
  readable, because a URL that connects to the *wrong* database is otherwise
  indistinguishable from an account with no messages.

On Railway, Evolution's Postgres is its own service — use its private URL, and
note the port there is whatever that service actually listens on (see "Pin the
ports").

## Stuck reconnecting (`conflict: replaced`)

The signature, in Evolution's log: `stream errored out` dozens of times a minute
for one instance, each with `reasonNode: {"tag":"conflict","attrs":{"type":"replaced"}}`,
`statusReason: 428` / `440`, and a fresh `CONNECTED TO WHATSAPP` after every one.
Two sockets are logging in with the same credentials and replacing each other.
Evolution 2.3.7 retries a 440 close at once with no backoff, and replaces its
client without ending the old socket, so nothing inside Evolution ends it. The
stored status reads `open` throughout.

**Fix: restart the Evolution service.** On boot it reconnects every account whose
status is `open` or `connecting` with one socket each. Every account drops
briefly; none needs a QR scan. Do it soon: repeated logins on a real number can
get it flagged by WhatsApp, and the log volume can hit Railway's 500 lines a
second cap, which hides every other account's logs.

Reconnect in the app does not help, and the app no longer sends Evolution's
`POST /instance/restart`. On Baileys that route ends the socket and can then
connect a second time itself, which is one way two sockets appear. The dashboard
offers Reconnect only for a connection whose socket is `close`.

The app detects the loop from Evolution's own `"Instance"` row, not from
webhooks (deliveries are unsigned): every socket that opens writes the row. A
connection whose `open` row keeps being freshly written for ten minutes is
marked **Unstable** on the dashboard, and `get-connection-status` returns
`flapping: true`. The web log gets one line naming the instance and the fix.
After the usual ten-minute grace period, everyone who can reach the connection
is emailed (see [alerts.md](alerts.md)). That takes the message database URL
and, with a dedicated role, the `"updatedAt"` grant above.

## Connections never paired are removed after an hour

A WhatsApp connection that nobody pairs within **one hour** of creating it is
deleted automatically, together with any connector tokens on it. While it waits,
it isn't idle. Evolution keeps it `connecting`, generates a fresh QR every few
minutes and prints each one to its log, and reconnects it at every Evolution
restart. On the hosted offering it also counts toward the organization's
connection limit. The pairing screen shows how much time is left.

The `instances:reap-unpaired` task runs every ten minutes. These rules decide
what it deletes:

- **Only connections this app has never seen paired.** The app records the first
  time it sees an account linked (`app.instances.paired_at`). A logout later
  does not clear it, so a connection that was paired and later signed out is
  never removed. Rows that existed before this was added were backfilled from
  alert history and, where Evolution shares the app's database, from Evolution's
  `ownerJid` and stored messages. One case neither the backfill nor the live
  check below can see: a connection signed out *before* upgrading, on a server
  whose database the app has no URL for, that never raised an alert. It looks
  exactly like one nobody paired, and the first run after the upgrade removes
  it. To keep one, add its database URL (**Enable reading**) or pair it again
  first.
- **Re-checked live just before deleting.** If Evolution now reports the account
  `open` or linked, or its database holds messages for it, the connection is
  marked paired and kept. If the check can't reach Evolution or its database,
  the connection is kept and checked again on the next run. A dedicated role
  without the `"Chat"`/`"Contact"` grants above counts as can't-reach, so no
  connection read through such a role is removed until the grants are added.
- **Deleted the same way as the Delete button**: the instance is first removed
  from Evolution, then the row. If this deployment has no admin key for the
  connection's server, the connection is kept, because deleting the row would
  leave the instance generating QRs there with nothing recording it. This applies
  to bring-your-own servers too, using that server's own key.
- Each row is leased while it is checked, so several replicas can run the task.
  Each deletion logs one line with the connection and organization ids. On the
  hosted offering it also writes a `connection.deleted` event with
  `reason: 'unpaired_expired'`.

Telegram connections are not affected. An unlinked Telegram session holds no
socket and polls nothing.

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
up; the import rides in on the re-scan. Nothing already stored is lost. The
re-import can write a second copy of a message Evolution already holds (see
[Reading and searching messages](#reading-and-searching-messages)), but reads and
searches collapse copies by `key.id`, so each message is still reported once.

Watch it land with `pnpm services:logs` while scanning:

```
recv 412 chats, 1180 contacts, 39204 msgs (is latest: false, progress: 34%), type: 2
```

`type: 2` is a full sync, `type: 3` is the recent-only one. Anything but `2` means
`syncFullHistory` never reached the socket.

The connection's page shows it too, to whoever scanned: after the scan it reads
**Importing your WhatsApp history** with message and chat counts climbing, and
moves on to the dashboard once they have stopped changing for about fifteen
seconds (three minutes at most; **Show dashboard now** skips the wait). The
import carries on in Evolution either way, and the dashboard counts catch up.

Caveats worth knowing before you rely on it:

- **Media is not downloaded.** History gives message records; the bytes still need
  `getBase64FromMediaMessage` per message.
- **Depth is whatever the phone volunteers.** `syncFullHistory` asks for
  everything; it is not a guarantee of everything.
- **Groups come too.** `syncFullHistory` overrides Evolution's group filter, so
  group chats appear in `list-chats` and in the token scope picker.
- **Reads get slower as it grows.** Evolution indexes its `Message` table on
  `instanceId` only; `remoteJid` lives inside a JSONB column with no index.

## Bring your own Evolution server

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

## ⚠️ WhatsApp pairing burns a real phone number

Scanning the QR binds a real WhatsApp account to an instance. WhatsApp rate-limits
and can ban numbers that pair and unpair repeatedly, or that send unsolicited
messages from a freshly-paired session. **Use a spare SIM, not your primary
number**, and keep test traffic to conversations you control.

Routine restarts must never use `docker compose down -v` — see [Self-hosting](self-hosting.md).
