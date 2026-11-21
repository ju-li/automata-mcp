# WhatsApp connections

## Which Evolution

The deployment's own Evolution server runs **`evolution-api-reforged` 3.2.0**,
our fork of Evolution API
([repo](https://github.com/Operational-Intelligence-Inc/evolution-api-reforged),
formerly `ju-li/evolution-api-v2`). Every file that names it pins its digest:
`docker-compose.yml`, `docker-compose.dev.yml`, `docker/aio/Dockerfile` and
[deploy-railway.md](deploy-railway.md). A bring-your-own Evolution server can
still be stock `evoapicloud/evolution-api` 2.3.7, so the app works with both.
Where this page says "2.3.7", the fork behaves the same unless listed here.

What the fork changes, and why we run it:

- **Baileys 7.0.0-rc14 instead of rc.9.** On rc.9, one offline message Baileys
  can't decode (a reply from a `…@bot` account, for example) stops the
  account's offline queue for the life of the connection. The account then
  reads `open` but receives nothing until Evolution restarts. rc14 logs that one
  message and carries on.
- **Status updates are acknowledged.** Stock never acknowledges them, so WhatsApp
  drops the connection about every 50 minutes and sends them again.
- **A retried close is written to the `"Instance"` row** (`connecting` plus the
  close's time and code), where stock leaves the row `open`. Retries back off
  from 1 s to every 5 min and never give up, so an outage of any length recovers
  by itself. The app tells a dropped session from a QR waiting to be scanned by
  the recorded code (see the grant for `"disconnectionReasonCode"` below).
- **One socket per account.** A new connection ends the one it replaces, and
  `POST /instance/restart` takes a single path, so Evolution itself no longer
  produces the two-socket loop described under "Stuck reconnecting". The app
  still never sends that route.
- **One row per message.** `"Message"` has a unique index,
  `Message_instanceId_key_unique`. The app still collapses duplicates when
  reading, for stock servers and for older rows. On a large table the index has
  to be built before the switch: see below.
- **It refuses to start** when `AUTHENTICATION_API_KEY` is empty or one of the
  example keys published in Evolution's docs, and warns when the key is under
  32 characters.

- **Retries stop where they can't succeed** (3.1.0,
  [#56](https://github.com/Operational-Intelligence-Inc/evolution-api-reforged/issues/56)).
  A QR code nobody scans stops after `QRCODE_LIMIT` codes (30 in our compose
  files): the row goes to `close` and the half-made session is cleaned up, so
  Evolution no longer shows QR codes for it at every boot. Opening the pairing
  screen starts a new count. After `RECONNECT_CONFLICT_LIMIT` 440 closes in a
  row (default 10, `0` = no limit), Evolution stops fighting the other client
  but keeps the session; see "Stuck reconnecting". A connection that opens no
  longer carries the last close's code on its row.
- **Incoming events survive an Evolution restart** (3.1.0). Messages, receipts,
  chats, contacts and group updates are written to a per-account Redis stream
  before they're processed and removed once done, so a restart replays what was
  still queued instead of losing it. This needs `CACHE_REDIS_ENABLED=true` (set
  in our compose files and the all-in-one image) and a Redis that persists
  (AOF or RDB; ours run with `--appendonly yes`). `GET
  /instance/connectionState` also reports the queue's lag. Settings:
  `EVENT_QUEUE_PERSIST`, `EVENT_QUEUE_ITEM_TIMEOUT_MS`,
  `EVENT_QUEUE_MAX_ENTRY_BYTES`, `EVENT_QUEUE_MAX_LENGTH`; the defaults fit.
- **Full history means the phone's whole history, not one year** (3.2.0,
  [#64](https://github.com/Operational-Intelligence-Inc/evolution-api-reforged/issues/64)).
  - **Why it was one year:** Baileys never tells WhatsApp how much history it
    wants, and the phone then sends one year.
  - **What changed:** a connection created with **Import full history** now asks
    for up to ten years (`fullSyncDaysLimit`). In testing, that brought in
    everything the phone held. A stock 2.3.7 server still stops at one year.
  - **It also pairs as a Windows Desktop device,** so it shows as Windows under
    the phone's Linked Devices instead of "Evolution API".
  - **Existing connections get the longer history only after a re-import:**
    **Import full history** on the dashboard, then a QR scan.
  - **Each history batch is logged at INFO:** `history batch: …` when it arrives
    and `history batch stored: …` once it is written.

### Moving from stock Evolution 2.3.7

At its first start, the fork runs a migration that deduplicates `"Message"` and
adds the unique index. It does this in one transaction that blocks writes to the
table, and Evolution serves nothing until it finishes. A large table can take
many minutes. If a valid index with exactly that definition already exists, the
migration skips itself. So with more than a few hundred thousand messages, build
the index first, while stock 2.3.7 keeps serving. Run the steps at a quiet hour,
as the table owner, from a `psql` session with no `statement_timeout`:

1. **Check free space** for the sort and the new index. Expect it to be about
   the size of `Message_instanceId_keyId_idx` if you have that index; otherwise
   about a tenth of the table.
2. **Deduplicate one account at a time**, each in its own transaction. This
   takes row locks only, so live writes keep flowing. The order of the window is
   the migration's own: it decides which copy survives.

   ```sql
   SET statement_timeout = 0;
   DO $$
   DECLARE
     inst text;
     removed bigint;
   BEGIN
     FOR inst IN SELECT id FROM "Instance" ORDER BY id LOOP
       CREATE TEMP TABLE _dedupe ON COMMIT DROP AS
       SELECT id, keep_id
       FROM (
         SELECT id,
                first_value(id) OVER w AS keep_id,
                row_number()    OVER w AS rn
         FROM "Message"
         WHERE "instanceId" = inst AND key->>'id' IS NOT NULL
         WINDOW w AS (
           PARTITION BY (key->>'remoteJid'), (key->>'id'), ((key->>'fromMe')::boolean)
           ORDER BY
             (status IN ('EDITED', 'DELETED')) DESC NULLS LAST,
             CASE status
               WHEN 'PLAYED' THEN 5 WHEN 'READ' THEN 4 WHEN 'DELIVERY_ACK' THEN 3
               WHEN 'SERVER_ACK' THEN 2 WHEN 'PENDING' THEN 1 ELSE 0
             END DESC,
             ("pushName" IS NOT NULL AND "pushName" !~ '@' AND "pushName" !~ '^[0-9+ ]+$') DESC,
             id ASC
         )
       ) ranked
       WHERE rn > 1;

       UPDATE "MessageUpdate" mu SET "messageId" = d.keep_id
       FROM _dedupe d WHERE mu."messageId" = d.id;

       -- Media.messageId is unique: move one duplicate's media only when the survivor has none.
       UPDATE "Media" m SET "messageId" = moved.keep_id
       FROM (
         SELECT DISTINCT ON (d.keep_id) md.id AS media_id, d.keep_id
         FROM "Media" md
         JOIN _dedupe d ON md."messageId" = d.id
         WHERE NOT EXISTS (SELECT 1 FROM "Media" k WHERE k."messageId" = d.keep_id)
         ORDER BY d.keep_id, md."createdAt" ASC NULLS LAST, md.id ASC
       ) moved
       WHERE m.id = moved.media_id;

       DELETE FROM "Message" m USING _dedupe d WHERE m.id = d.id;
       GET DIAGNOSTICS removed = ROW_COUNT;
       RAISE NOTICE '% removed %', inst, removed;
       COMMIT;
     END LOOP;
   END $$;
   ```

   `COMMIT` inside `DO` needs `psql` in autocommit mode, not inside `BEGIN`.
3. **Reclaim the space and refresh the planner's statistics:** `VACUUM (ANALYZE) "Message";`
4. **Build the index** while nobody is pairing, so no history import races live
   traffic:

   ```sql
   CREATE UNIQUE INDEX CONCURRENTLY "Message_instanceId_key_unique"
     ON "Message" ("instanceId", ("key"->>'remoteJid'), ("key"->>'id'), (("key"->>'fromMe')::boolean));
   ```

   If it fails because a duplicate landed during the build, run
   `DROP INDEX CONCURRENTLY "Message_instanceId_key_unique";`, repeat step 2
   (only the new duplicates remain, so it is quick), then build again.
5. **Confirm** that
   `SELECT indisvalid, indisunique FROM pg_index WHERE indexrelid = '"Message_instanceId_key_unique"'::regclass;`
   returns `true, true`. The definition must be exactly the one above: with any
   other definition under that name, the migration stops Evolution from starting
   rather than rebuilding.
6. **Switch the image soon after.** Until you do, stock 2.3.7 runs with the
   index, so a duplicate it tries to store fails instead of being stored twice.

Then check that the [indexes below](#indexes-on-evolutions-tables) are still
there (`pg_indexes`). The migration doesn't touch them.

**Rolling back to stock 2.3.7** was rehearsed against the migrated schema with
the index in place
([fork #33](https://github.com/Operational-Intelligence-Inc/evolution-api-reforged/issues/33)
§5): stock ignores what the fork added, and runs with the unique index as in
step 6. Nothing the fork's migrations changed is undone by a rollback, and stock
does not record retried closes or acknowledge status updates, so the problems
the fork fixes come back.

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
searching, connection status and group names:

```sql
CREATE ROLE wamcp_search LOGIN PASSWORD 'change-me';
GRANT CONNECT ON DATABASE evolution TO wamcp_search;
GRANT USAGE ON SCHEMA public TO wamcp_search;
GRANT SELECT ON "Message" TO wamcp_search;
-- Connection status: the account's own row and per-account counts.
GRANT SELECT ("id", "connectionStatus", "ownerJid", "profileName", "profilePicUrl", "number", "disconnectionAt", "disconnectionReasonCode", "updatedAt")
  ON "Instance" TO wamcp_search;
GRANT SELECT ("instanceId") ON "Chat", "Contact" TO wamcp_search;
-- Group names, read from Evolution's own chat rows.
GRANT SELECT ("remoteJid", "name") ON "Chat" TO wamcp_search;
-- Send acknowledgements, for stuck-session detection.
GRANT SELECT ("messageId", "instanceId", "status") ON "MessageUpdate" TO wamcp_search;
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
at all). An account with 100,000 messages or more is never counted while a page
waits: its last counts are shown with their age, and it is recounted in the
background at most once an hour, one account at a time, on a connection of its
own with a 60-second limit — on a cold disk, counting a few million rows can take
longer than the 10 seconds other reads get. With `NUXT_REDIS_URL` set, counts are
shared between replicas and survive a redeploy. Counts are kept for a week after
the last count, so an account nobody opens for a few days still shows them. A role created before these grants existed still works: status falls
back to `fetchInstances`, cached per connection for five minutes, and the web
log says a grant is missing. A count that is only *slow* — it hit the statement
timeout, or the account already has a read running — never falls back, since
`fetchInstances` would scan every account to answer for one: the dashboard shows
the last counts, or a dash, and the log says the count was too slow. Without this URL at all — a bring-your-own server
with no database URL — that cached fallback is the only path.

`"updatedAt"` is what tells a reconnect loop from a healthy connection (see
"Stuck reconnecting" below). It has no fallback: without the grant everything
else keeps working, the log says the column is unreadable, and loops go
undetected. A stuck session (below) is then reported from the failed calls
alone, for 30 minutes after the last one, since a reopen by Evolution can't be
seen to clear it.

`"disconnectionReasonCode"` is how a dropped session is recognised on an
Evolution that records the closes it retries (the fork, see "Which
Evolution" above): there the stored status reads `connecting` while
Evolution retries, and the recorded reason is what tells that from a QR waiting
to be scanned. Stock 2.3.7 never needs it. Without the grant, the log says the
column is unreadable and, on the fork, a dropped session reads as needing a QR
scan rather than as **Connection lost**. A role granted before this column was
read: run the `"Instance"` line again with it added.

```bash
NUXT_EVOLUTION_DATABASE_URL=postgres://wamcp_search:change-me@localhost:5432/evolution
```

### Indexes on Evolution's tables

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

The dashboard's "Last message received" and `lastInboundAt` in
`get-connection-status` also need this index. They read the account's newest
inbound message, newest first, and stop at the first one. Without the index that
read would cover every message the account holds on every status poll, so the
app leaves the time unknown and logs once that the index is missing.

**Index each chat's messages by time.** This one index serves two reads:

- `read-messages` reads one chat, and `message_instance_ts_idx` still visits
  every row the account holds in the requested time range before filtering by
  chat. With this index, one chat's page skips the rest.
- `list-chats`, the token scope picker and the dashboard's chats dialog list an
  account's conversations. With this index the app reads one index entry and
  usually one row per chat. On an account with 1.9M messages and 3,200 chats
  that is about 0.1 s warm and 2.4 s cold. Without it, every listing reads
  every message of the account, and large accounts hit the 10-second timeout.

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS message_instance_chat_ts_idx
  ON "Message" ("instanceId", (key->>'remoteJid'), "messageTimestamp" DESC);
```

It costs disk and insert time on every message. Any index on these three
columns in this order counts, whatever its name and whichever direction the
timestamp sorts: if one exists already (for example `message_chat_ts_idx`),
don't build a second. The chat listing looks for an index of this shape every
ten minutes, so there's no need to restart the app. Until it finds one, it keeps
the full scan and logs once that the index is missing. Either way, one
account's listing is read at most once a minute and shared by every page and
caller.

To check that `read-messages` uses it, take your largest account's id from
`"Instance"` and one of its busy chats:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT 1 FROM "Message" m
WHERE m."instanceId" = '<instance id>' AND m.key->>'remoteJid' = ANY(ARRAY['<jid>'])
ORDER BY m."messageTimestamp" DESC LIMIT 51;
```

The plan should name the new index. If it still names `message_instance_ts_idx`
or a sequential scan, `read-messages` gains nothing from it on that account, but
keep it anyway: the chat listing still needs it. Like the indexes below, it
lives on Evolution's table and must be re-checked after an image-tag bump.

**Index the messages that link a LID to a phone number.** The app reads which
LID chats belong to which phone numbers ([Chats addressed by
LID](#chats-addressed-by-lid-lid)) from the few live messages that carry
`remoteJidAlt`. Without this index that read opens every message in the
account's LID chats; on an account with 1.9M messages it took 25 s and never
finished inside the timeout, so its LID chats showed no phone number and were
never merged. With it, and with the per-chat index above, the read walks the
account's chats and the handful of rows this index holds (about 2,000 of 1.9M
there):

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS message_lid_alt_idx
  ON "Message" ("instanceId")
  WHERE key ? 'remoteJidAlt';
```

The `WHERE` clause has to match the app's query word for word, or Postgres
won't use the index; any btree index leading with `"instanceId"` under that
exact clause counts, whatever its name. The app looks for it every ten minutes,
uses the old read until it finds it, and logs once that it is missing. It needs
the per-chat index above too; without that one the old read stays.

**Index message text for search.** Without this index, `search-messages` and
the dashboard's message filter read every message of the account on every
search, and open each message's stored payload to find its text. On an account
with 1.3M messages, that was about 330 MB read per search, and some searches
timed out. A trigram index on the message text lets Postgres read only the
messages that contain the words. It needs `pg_trgm`; find its schema as shown
under `"IsOnWhatsapp"` below, and qualify the operator class the same way:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS message_body_trgm
  ON "Message" USING gin ((COALESCE(
    message->>'conversation',
    message->'extendedTextMessage'->>'text',
    message->'imageMessage'->>'caption',
    message->'videoMessage'->>'caption',
    message->'documentMessage'->>'caption',
    message->'documentWithCaptionMessage'->'message'->'documentMessage'->>'caption',
    message->>'speechToText',
    message->'reactionMessage'->>'text',
    message->'associatedChildMessage'->'message'->>'conversation',
    message->'associatedChildMessage'->'message'->'extendedTextMessage'->>'text',
    message->'associatedChildMessage'->'message'->'imageMessage'->>'caption',
    message->'associatedChildMessage'->'message'->'videoMessage'->>'caption',
    message->'associatedChildMessage'->'message'->'documentMessage'->>'caption',
    message->'protocolMessage'->'editedMessage'->>'conversation',
    message->'protocolMessage'->'editedMessage'->'extendedTextMessage'->>'text',
    message->'protocolMessage'->'editedMessage'->'imageMessage'->>'caption',
    message->'protocolMessage'->'editedMessage'->'videoMessage'->>'caption',
    message->'protocolMessage'->'editedMessage'->'documentMessage'->>'caption',
    message->'associatedChildMessage'->'message'->'protocolMessage'->'editedMessage'->>'conversation',
    message->'associatedChildMessage'->'message'->'protocolMessage'->'editedMessage'->'extendedTextMessage'->>'text',
    message->'associatedChildMessage'->'message'->'protocolMessage'->'editedMessage'->'imageMessage'->>'caption',
    message->'associatedChildMessage'->'message'->'protocolMessage'->'editedMessage'->'videoMessage'->>'caption',
    message->'associatedChildMessage'->'message'->'protocolMessage'->'editedMessage'->'documentMessage'->>'caption'
  )) telegram.gin_trgm_ops);

ANALYZE "Message";
```

Copy the expression exactly. Postgres uses the index only for a query whose
expression is identical to it, and the app's searches use this one. A copy that
differs in any arm or in their order is never used, and searches stay as slow as
before without any error. If an app release changes how message text is read,
its release notes say so; drop the index and build it again from this page.
`ANALYZE` gives the planner statistics on the new expression, so it can tell a
rare word from a common one.

What to expect:

- It covers every account on the server, so the database finds matching
  messages first and then keeps the ones from the searched account. Rare words
  are fast on any account. Very common words match many rows, and the database
  falls back to reading the account when that's cheaper.
- A word needs three letters or digits in a row to use the index. A search made
  only of shorter words or emoji (`ok`, `👍`) still reads the whole account.
- It costs disk (expect something like 1–2 GB on a table of a few million
  messages) and a little time on every insert.

Check `indisvalid` as for the `"IsOnWhatsapp"` index below. To see that searches
use it, run a typical two-word search on your largest account:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT 1 FROM "Message" m
WHERE m."instanceId" = '<instance id>'
  AND COALESCE(m.message->>'conversation', /* …every arm above, with m. … */) ILIKE '%<word>%'
  AND COALESCE(m.message->>'conversation', /* … */) ILIKE '%<other word>%';
```

The plan should show `Bitmap Index Scan on message_body_trgm`, and `Buffers`
should be a small fraction of what the same query reads without it.

**How big each account is.** `"Message"` grows without bound; nothing here or in
Evolution deletes old messages. To see where the space goes before deciding on
retention:

```sql
SELECT "instanceId", count(*) AS messages
FROM "Message" GROUP BY 1 ORDER BY 2 DESC LIMIT 20;

SELECT pg_size_pretty(pg_total_relation_size('"Message"')) AS message_table;
```

The first reads every row. Run it at a quiet hour.

Two more changes, both for Evolution's own queries rather than this app's. Make
them as a superuser too.

**Index `"IsOnWhatsapp"."jidOptions"`.** With `DATABASE_SAVE_IS_ON_WHATSAPP` on,
Evolution looks numbers up with
`WHERE "jidOptions"::text LIKE $1 OR "remoteJid" = $2`. `"remoteJid"` has a
unique index, but `"jidOptions"` has none, so every lookup reads the whole
table. On one deployment it was the most expensive statement on the server. A
trigram index lets Postgres answer the `OR` with a `BitmapOr` instead:

```sql
-- where pg_trgm lives; the Telegram bridge installs it in the telegram schema
SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
WHERE e.extname = 'pg_trgm';

CREATE INDEX CONCURRENTLY IF NOT EXISTS isonwhatsapp_jidoptions_trgm
  ON "IsOnWhatsapp" USING gin ("jidOptions" telegram.gin_trgm_ops);
```

Qualify `gin_trgm_ops` with the schema the first query names. Without the
qualifier, the statement fails with `operator class "gin_trgm_ops" does not
exist for access method "gin"`. If the query returns no row, run
`CREATE EXTENSION pg_trgm SCHEMA public;` first and use `public.gin_trgm_ops`.
An index built on the `telegram` copy depends on that schema: dropping it with
`CASCADE` drops this index too, without a word. Check that
`SELECT indisvalid FROM pg_index WHERE indexrelid = 'isonwhatsapp_jidoptions_trgm'::regclass`
is `t`. A failed concurrent build leaves an invalid index behind; drop it with
`DROP INDEX CONCURRENTLY` and build it again.

**Vacuum `"Message"` more often.** Counting an account's messages is an
index-only scan, which skips the table only for pages the visibility map marks
all-visible. Freshly imported history isn't marked until autovacuum runs. By
default autovacuum waits for inserts equal to 20% of the table, which is about
1.1M rows at 5.5M, so the accounts counted most often (fresh imports) paid a
table read for nearly every row:

```sql
ALTER TABLE "Message" SET (autovacuum_vacuum_insert_scale_factor = 0.01,
                           autovacuum_vacuum_scale_factor = 0.05);
```

The app applies this itself, once, in its migration `0025_message_autovacuum`,
when `"Message"` is in the app's own database (`NUXT_DATABASE_URL`) and the
app's role owns it — the default compose file, the all-in-one image and the
Railway template. Otherwise it skips, never failing the boot, and the boot log
says why (`[app-db] "Message" autovacuum settings …`). Run the statement above
yourself when it skipped: Evolution on a separate database, a role that doesn't
own the table, `"Message"` not created yet when the app first started, or the
table recreated by an Evolution upgrade since. Check with
`SELECT reloptions FROM pg_class WHERE oid = '"Message"'::regclass`.

`SELECT relallvisible::float / relpages FROM pg_class WHERE oid = '"Message"'::regclass`
should then stay close to 1.

The trigram index and these storage parameters live on Evolution's tables, as
`message_instance_ts_idx`, `message_instance_chat_ts_idx`,
`message_lid_alt_idx` and `message_body_trgm` do. They survive restarts, but a
Prisma migration that recreates either table drops them without any warning.
Re-check all six after
bumping Evolution's image tag. Both trigram indexes use `pg_trgm`'s operator
class, so dropping the schema it lives in with `CASCADE` drops both.

Worth knowing before you go looking for a bug:

- Both cover whatever Evolution holds: the history imported at pairing plus
  everything since. An account created without **Import full history** (the
  default) holds only the recent slice WhatsApp hands any new device, and one
  paired before history import existed has only what arrived after — see
  [Recent history only](#recent-history-only) and
  [Importing existing history](#importing-existing-history).
- Searches take at most 10 words of at most 100 characters each (500 characters
  in all). On this deployment's own message database each connection runs one
  read at a time with up to 8 more queued; past that a read answers 429 and asks
  the caller to wait. Status reads use a separate pool, so a busy account's
  searches never delay its status or the alert sweep.
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
- **Group names can lag behind a rename by up to a week.** Asking WhatsApp for
  all of an account's groups at once costs two WhatsApp queries per group, fired
  together, and drew `rate-overlimit` answers on large accounts however rarely
  it ran — so it is never done. Group names come from Evolution's own chat rows
  (`"Chat".name`), which cost WhatsApp nothing but are written once, when the
  chat first arrives, and never updated on a rename. Groups with no name there,
  and every group once a week, are looked up one at a time — at most four per
  account every 15 minutes, five seconds apart — and the answers kept in
  `app.whatsapp_groups`. So a renamed group shows its old name until its next
  lookup, a group with no stored name shows the contact name or bare id until
  its first one, and a group's member count appears only once it has been
  looked up. Without the `"Chat"` grant above, names come from the lookups
  alone, and a warning says so in the log. Chats and their last messages are
  read live; only group names lag.

  Groups the account has left keep a chat row, so they get looked up too, and
  WhatsApp refuses: such a group is marked gone, keeps its last name, and is
  not asked about again for 30 days. The log says so at info level — that is
  expected, not a fault. Only lookups that nothing answered, or that WhatsApp
  answered with `rate-overlimit`, back the account's lookups off (1 h, doubling
  to a day); those log `[groups] every group lookup failed` or `[groups]
  WhatsApp is rate-limiting group lookups` with WhatsApp's error text.
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
  GRANT SELECT ("id", "connectionStatus", "ownerJid", "profileName", "profilePicUrl", "number", "disconnectionAt", "disconnectionReasonCode", "updatedAt")
    ON "Instance" TO evo_reader;
  GRANT SELECT ("instanceId") ON "Chat", "Contact" TO evo_reader;
  GRANT SELECT ("remoteJid", "name") ON "Chat" TO evo_reader;
  -- Send acknowledgements, for stuck-session detection.
  GRANT SELECT ("messageId", "instanceId", "status") ON "MessageUpdate" TO evo_reader;
  ```

  It is checked before it is stored — including that `"Message"` is actually
  readable, because a URL that connects to the *wrong* database is otherwise
  indistinguishable from an account with no messages.

On Railway, Evolution's Postgres is its own service — use its private URL, and
note the port there is whatever that service actually listens on (see [Pin the
ports](deploy-railway.md#pin-the-ports)).

## Chats addressed by LID (`…@lid`)

WhatsApp addresses a person in one of two ways. The familiar one is a
phone-number JID, `5511999999999@s.whatsapp.net`. The other is a **LID**, such as
`79972425314508@lid`: a per-person alias WhatsApp uses so that group members and
people who never exchanged numbers don't learn each other's phone numbers. **A
LID's digits are not a phone number.** They carry no country code, and dialling
them reaches whoever owns that number, if anyone.

Which form a chat gets is WhatsApp's decision, not this app's. Group members are
usually LIDs, and many 1:1 chats are too, especially in
history imported at pairing. So `list-chats`, the dashboard and the token scope
picker routinely show chats whose identifier ends in `@lid`.

What the connector does with them:

- **Reading and searching** work the same for both forms.
- **Replying** works: `send-text-message` takes the chat's full JID
  (`…@lid`) and the message lands in the existing conversation, stored under the
  LID. The tool description and the server instructions tell the model to pass
  the JID as returned, and never to strip the suffix and send to the digits.
  If it does anyway, a send to digits this account has seen as a LID (as a chat,
  a group sender or an @-mention) is refused with the full JID to use instead.
  Digits it has never seen as a LID — a new contact's phone number — still send.
- **Names** for senders and @-mentions are resolved from the account's contacts
  and from group membership, which knows both forms of each member. A LID it
  cannot resolve stays a raw id rather than being guessed.
- **Phone numbers** are shown as `number` only for chats addressed by phone
  number. A LID chat has no `number`; instead it carries `phoneNumber` in
  `list-chats` (and shows it in the dashboard's Chats table, marked "via LID")
  **when WhatsApp has revealed it**: Evolution keeps the phone-number form as
  `remoteJidAlt` on some live messages in the LID chat. History import never
  carries it, so a LID chat with only imported messages shows no number even
  when the phone itself shows one. A LID seen with more than one number (or a
  number with more than one LID) is left unlinked rather than guessed. Nothing
  else is consulted — not contact names, not the alias's own digits, not data
  from other accounts on the same Evolution server. The chat is still the LID:
  replies and token scope follow its JID, not the number.
- **One person, two chats, shown as one.** Someone who moved from phone-number
  to LID addressing has part of their history under each id. When the two are
  linked as above, `list-chats` and the dashboard's Chats table show one row,
  under the LID, with both ids in `jids`. `read-messages` and `search-messages`
  given either id read both, as one timeline with no duplicates, and search
  labels every hit with one id per person. A token reads only the halves it is
  scoped to and is told, as a count, when part of the conversation is outside
  its scope. A chat with no link says so (`linkUnknown`) where a second part
  could exist. Links are re-read every half hour, so a link revealed by a new
  message can take that long to merge the two rows. The dashboard's Chats
  *card* still shows Evolution's own count, which is not comparable.

What it can't do yet:

- **Tell you the phone number behind every LID.** WhatsApp reveals the link
  only on some live messages, never on imported history, and Evolution has no
  API for Baileys' own mapping. So `phoneNumber` is partial, and the model is
  told its absence means "unknown", not "none". It also needs the message
  database: a connection without one never shows it.
- **Link chats it has no link for.** A LID chat with no revealed number stays
  a separate chat from that person's phone-number chat, if they have one. A
  read of either says the conversation may continue under another id.

**Token scope stays a list of exact chat ids.** A linked person is one row in
the token's chat picker, showing their number and "2 chats". Ticking it allows
both ids, and unticking removes both. A token that holds only one of the two
(one scoped before they were linked, say) shows the row as partly ticked, with
a note. It keeps reaching only that half until you tick the row, and the model
is told part of the conversation is outside its scope. A link never lets a
token reach an id that wasn't ticked.

On a bring-your-own Evolution server with `DATABASE_SAVE_IS_ON_WHATSAPP=true`,
Evolution may resolve a LID to the phone-number JID it has linked it to. For a
token scoped only to the LID chat, sending to that LID is then refused, because
the message would go to the phone-number id. The refusal says so. Ticking the
person's row so both ids are included, or turning the setting off, avoids it.

## Stuck reconnecting (`conflict: replaced`)

The signature, in Evolution's log: `stream errored out` dozens of times a minute
for one instance, each with `reasonNode: {"tag":"conflict","attrs":{"type":"replaced"}}`,
`statusReason: 428` / `440`, and a fresh `CONNECTED TO WHATSAPP` after every one.
Two sockets are logging in with the same credentials and replacing each other.
Evolution 2.3.7 retries a 440 close at once with no backoff, and replaces its
client without ending the old socket, so nothing inside Evolution ends it. The
stored status reads `open` throughout.

On the fork, Evolution no longer makes a second socket itself (see "Which
Evolution"), and it retries a 440 with the same backoff as any other close.
What's left is a second client using the same session: another Evolution
pointed at the same `instances` volume or database, for example a staging copy,
or an old container still running. Stop that one first; restarting ours alone
starts the fight again.

After `RECONNECT_CONFLICT_LIMIT` 440s in a row (default 10), the fork stops
retrying and keeps the session. The row reads `close` with code 440. A restart
does **not** bring such an account back, because Evolution only auto-connects
rows that are `open` or `connecting`. Once the other client is gone, have an
admin (or the member who created the connection) open its page in the app. It
shows the pairing screen, whose first request asks Evolution to connect, and
Evolution resumes the kept session without a QR scan. The app doesn't yet say
that another client was holding the session.

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
`flapping: true`. The web log gets one line naming the instance and the fix,
and with `NUXT_OPS_ALERT_EMAIL` set the operator is mailed straight away.
After the usual ten-minute grace period, everyone who can reach the connection
is emailed (see [alerts.md](alerts.md), which also covers what the hosted
offering tells customers instead). That takes the message database URL
and, with a dedicated role, the `"updatedAt"` grant above.

## Stuck with the socket dead (`Connection Closed`)

The signature: the dashboard says **Connected** and `get-connection-status`
answers `state: open`, but every send fails with "The WhatsApp connection is
down", the web log has `[evolution] send on connection … failed: WhatsApp socket
not connected` and `[groups] every group lookup failed … Error: Connection
Closed`, and no new message has been stored since some point. Evolution's
stored status reads `open` too, and its row is not being rewritten, so this is
not the reconnect loop above.

Evolution's in-memory state for the account still reads `open` over a socket
that is gone or no longer processed. The likeliest cause is the account's
serial event queue sticking when Evolution's database writes failed mid-event —
seen right after a Postgres restart. Nothing inside Evolution recovers it.

**Fix: restart the Evolution service**, as for a loop. On boot it reconnects
every account whose status is `open`, which this one's still is, so no QR scan
is needed. Reconnect in the app cannot help: it acts only on a `close` socket.

The app detects it from the failures themselves. A send or a group lookup that
Evolution answers with `Connection Closed` (or `not connected` / `connection
lost`) records the time on the connection (`socket_dead_seen_at`, at most once a
minute). So do sends Evolution accepts but WhatsApp never acknowledges: on a
wedged account a send still answers 200, but its stored row stays `PENDING`.
Two minutes after each send the app reads that status back — the `"Message"`
row and, while that still says `PENDING`, the send's receipts in
`"MessageUpdate"`, since Evolution often records an ack there without updating
the row. A role without the `"MessageUpdate"` grant above gets no signal from
sends at all, rather than false alarms. Two sends to people in a row still
`PENDING` record the time of the later send. One stray `PENDING` changes
nothing — they happen on healthy accounts too. Neither does a send still `PENDING`
when a message has arrived since it, and a message arriving between two
misses starts the count again: received messages come in over the same
socket, so they prove it works — receipts for some contacts are only written
when that contact's next message arrives, minutes late. A group send still `PENDING`
counts for nothing either way: on healthy accounts about one group send in
eight never gets a receipt recorded, while sends to people always do. A group
send that is acknowledged still counts as proof the socket works. This check needs
`message_instance_ts_idx` (see "Indexes on Evolution's tables"). A status read
that finds the account `open` live and stored, with no
socket opened since — judged from the `"Instance"` row's `"updatedAt"`, which
Evolution writes on every open — marks it **Stuck** on the dashboard, and
`get-connection-status` returns `stalled: true`. With `NUXT_OPS_ALERT_EMAIL` set
the operator is mailed straight away; after two hours (longer than the usual
ten minutes, since a stuck socket is inferred rather than read), everyone who
can reach the connection is emailed that the service needs
restarting (see [alerts.md](alerts.md)). The record clears when WhatsApp next
acknowledges a send (a receipt past `PENDING`) or answers a group lookup
(even with a refusal), when a message is received after it, when Evolution reopens
the socket, or when the account is next read as not `open`.

Limits: it needs the message database URL — without it a stuck session cannot
be told from a brief drop that already recovered, and nothing is reported. With
a dedicated role missing the `"updatedAt"` grant above, it is reported from the
failed calls alone, for 30 minutes after the last one. `Timed Out` is not
counted, since a healthy socket can answer it too. A webhook delivery never
records anything (deliveries are unsigned). And it is found only by a call that
needs the socket: an account nobody sends from waits for its next group lookup.

## Stopped receiving (inbound silence)

The signature: every signal says healthy — **Connected**, no loop, no failed
send — but no new message has arrived for hours, and the customer notices when
replies dry up. Seen in production on Nov 14–15 2026 (#238): one busy account
went fourteen hours without a live inbound message, then received only bursts
of hours-old backlog after each socket reopen. The fork (see "Which Evolution")
removes both causes found then; this is the safety net for causes not known yet.

The app judges it from what actually stopped: messages arriving. Every five
minutes the alert sweep compares the time since the account last received a
message (`lastInboundAt`, WhatsApp's own timestamp — so a redelivered backlog
does not count as live) with **the account's own history**:

- Once a day (`whatsapp:silence-baselines`, hourly, a few accounts per run) the
  app measures each account's gaps between received messages over the past four
  weeks, split into weekday/weekend × four-hour bands in
  `NUXT_WHATSAPP_SILENCE_TIME_ZONE`. Quiet nights, weekends and lunch breaks raise
  their own bands' thresholds. Numbers only are stored
  (`app.whatsapp_silence_baselines`).
- **Account rule:** silent when the current silence is longer than the 99.9th
  percentile gap of the band its last message arrived in, and never under
  45 minutes.
- **Fleet rule:** when three or more busy accounts on one Evolution server (and
  at least a fifth of the busy ones judged there) are each past their own 99th
  percentile, and past 20 minutes, at once, each of them is silent. That is what
  a server-wide failure looks like.
- **Never judged:** a band with fewer than 10 received messages an hour or 200
  gaps measured, an account with less than two weeks of history, an account that
  is already dropped, looping or stuck, and any account without the message
  database URL or `message_instance_ts_idx` (see "Indexes on Evolution's tables").
  Those accounts still show when they last received a message.
- **Ends only on a live message** — one stamped within 45 minutes of now. A
  socket reopen that delivers old backlog does not end it, nor does a send.

`NUXT_WHATSAPP_SILENCE_ALERTS` decides who hears about it:

| Value | What happens |
|---|---|
| `shadow` (default) | Episodes are recorded on the connection, logged (`[silence] shadow: …` with the rule, threshold, band and last inbound time, and `… is receiving again` when they end), and mailed to `NUXT_OPS_ALERT_EMAIL` for connections on this deployment's Evolution. Nobody else is told: no customer mail, nothing on the dashboard or over MCP. |
| `on` | As shadow, plus: unhealthy for alerts (ten-minute grace, then everyone who can reach the connection is mailed that the Evolution service needs restarting), **Not receiving** on the dashboard, `silent: true` from `get-connection-status`, and the operator mail goes out with the other stuck-session mails. |
| `off` | Nothing is measured; any open episode is cleared quietly. |

Run `shadow` for a couple of weeks before `on`, and compare the episodes in the
log with what really happened. Unknown values read as `shadow`.

**Fix: restart the Evolution service**, as for the two failures above. No QR
scan is needed; Reconnect in the app cannot help.

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
  `ownerJid` and stored messages. A connection signed out before upgrading is
  still recognised: Evolution keeps the account's `ownerJid` through a logout,
  and the live check below reads it (through Evolution's API when the app has
  no URL for that server's database).
- **Re-checked live just before deleting.** If Evolution now reports the account
  `open` or linked, or its database holds messages for it, the connection is
  marked paired and kept. If the check can't reach Evolution or its database,
  the connection is kept and checked again on the next run. A role that cannot
  read `"Message"` counts as can't-reach; without the `"Instance"` grant the
  check asks Evolution's API instead.
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
| `syncFullHistory: true` | sent at `POST /instance/create` when **Import full history** is ticked on the create form, in `server/utils/instances.ts` | Only the recent slice arrives (`type: 3` below) |
| A fresh device link | scanning the QR | Reconnecting an existing session sends no history |

The first and third are automatic. The second is the owner's choice: **Import
full history** on the create form is **off by default for everyone**, Pro and
self-hosted included, so a new account imports the recent slice unless asked
for more. An account paired without it cannot be backfilled in place — **Import full history** on the
connection's dashboard sets the flag, signs the device out and puts the QR back
up; the import rides in on the re-scan. Nothing already stored is lost. The
re-import can write a second copy of a message Evolution already holds (see
[Reading and searching messages](#reading-and-searching-messages)), but reads and
searches collapse copies by `key.id`, so each message is still reported once.

Watch it land with `pnpm services:logs` while scanning. The fork (3.2.0) logs
each batch at INFO, with its date range and what was stored:

```
history batch: type=2 msgs=4976 chats=434 contacts=450 progress=79 isLatest=false from=2024-09-20T14:36:26.000Z to=2025-12-30T03:40:50.000Z
history batch stored: type=2 inserted=4381 failed=0 skippedKnown=0 skippedIncomplete=595 skippedOutOfRange=0
```

Stock 2.3.7 logs only at VERBOSE: `recv 412 chats, 1180 contacts, 39204 msgs
(is latest: false, progress: 34%), type: 2`.

`type=2` is a full sync, `type=3` is the recent-only one. Anything but `2` means
`syncFullHistory` never reached the socket. `skippedIncomplete` counts system
events with no content, such as the encryption notice or "X created the group".
Their dates can reach back years before the oldest real message, so a batch's
`from` is not how far back the stored messages go.

The connection's page shows it too, to whoever scanned: after the scan it reads
**Importing your WhatsApp history** with message and chat counts climbing, and
moves on to the dashboard once they have stopped changing for about fifteen
seconds (three minutes at most; **Show dashboard now** skips the wait). The
import carries on in Evolution either way, and the dashboard counts catch up.

Caveats worth knowing before you rely on it:

- **Media is not downloaded.** History gives message records; the bytes still need
  `getBase64FromMediaMessage` per message.
- **Depth is whatever the phone holds.** On the fork, the import reaches the
  start of the phone's own history. A phone where WhatsApp was set up or
  restored without older chats has nothing older to send. A stock 2.3.7 server
  stops at one year even when the phone holds more.
- **Groups come too.** `syncFullHistory` overrides Evolution's group filter, so
  group chats appear in `list-chats` and in the token scope picker.
- **Reads get slower as it grows.** Evolution indexes its `Message` table on
  `instanceId` only; `remoteJid` lives inside a JSONB column with no index.

### Recent history only

With **Import full history** unticked — the default — a connection is created
with `syncFullHistory: false`. On the hosted offering a Free organization cannot
tick it (`app.organizations.recent_history_only`, written by the cloud service;
see [Plans and billing](billing.md)). Baileys then sends
`requireFullSync: false`, and WhatsApp hands over only what it gives any linked
browser — the `type: 3` sync above. Evolution still stores it, since it
persists every history sync type under `DATABASE_SAVE_DATA_HISTORIC`. How far
back that reaches is WhatsApp's choice, not a setting here.

Group chats still sync live and in that slice: with `syncFullHistory` off,
Evolution's group filter falls back to `groupsIgnore`, which instances are
created with off.

The Free limit is enforced in three places, all in
`server/utils/instances.ts`:

- **Create**: the box is locked on the form (`/api/auth/me` carries
  `recentHistoryOnly`), and `provisionWhatsappInstance` answers 402
  `plan_limit` to `fullHistory: true` before anything is provisioned.
- **Import full history** answers 402 `plan_limit`; the dashboard hides it and
  points admins at Billing instead.
- **Pairing**: before the QR poll's `connect`, a connection still carrying
  `syncFullHistory: true` (created while the organization was on Pro) has it
  turned off, at most once a minute per connection. Never the other way:
  upgrading turns nothing on, since full history costs a QR scan and that is the
  owner's call.

It never applies to a bring-your-own Evolution server, and it deletes nothing
already imported. Self-hosted deployments never set it.

Older messages are not fetched later either: reads and searches only query
Evolution's database, and nothing can ask WhatsApp for history after pairing.
So the MCP tools say when the history is partial. `read-messages`,
`search-messages` and `get-connection-status` carry `recentHistoryOnly: true`
when the connection's Evolution settings have `syncFullHistory` off — the
setting its pairing actually used, not the current plan, so an organization that
upgraded but has not re-imported still reads as partial. `read-messages` adds a
`note` once it reaches the oldest stored message, and `search-messages` adds one
on every response. Self-hosted accounts paired before full-history sync existed
report it too, accurately. Read through `recentHistoryOnly()` in
`server/utils/instances.ts`, cached five minutes per connection.

## Bring your own Evolution server

**Self-hosted only.** The hosted service refuses it (422) and doesn't offer the
option: there, any self-signup could point our scheduled tasks at a server they
control. Self-hosted deployments are unaffected.

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
