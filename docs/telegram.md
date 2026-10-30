# Telegram connections

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

## Setting it up

1. **Get your own API credentials** at <https://my.telegram.org> → API
   development tools, and put them in `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`.
   Never reuse a pair from an example or another project — Telegram refuses
   published ones. Both are optional, together: with neither set the bridge
   still starts, `/health` reports `"telegram": "unconfigured"`, and the app's
   **Add a connection** page says what to set instead of offering Telegram.
   Setting both later and restarting the bridge is all it takes to turn it on.
   One without the other refuses to start, so a typo cannot pass for "off".
2. **Generate the two keys:** `TELEGRAM_BRIDGE_ADMIN_KEY` (`openssl rand -hex
   24`) and `TELEGRAM_SESSION_ENCRYPTION_KEY` (`openssl rand -hex 32`). Set
   `NUXT_TELEGRAM_ADMIN_KEY` to the same value as the admin key.
3. **Give the bridge its database:** `TELEGRAM_BRIDGE_DATABASE_URL`, required —
   the bridge refuses to start without it (see
   [Where the data lives](#where-the-data-lives)).
4. **Point the app at it:** `NUXT_TELEGRAM_URL` and
   `NUXT_TELEGRAM_DATABASE_URL`. The bridge reports a dropped or restored
   connection to `NUXT_TELEGRAM_WEBHOOK_URL`, which drives disconnect alerts and
   defaults to `NUXT_PUBLIC_APP_URL` + `/api/webhook/telegram`; set it in
   development, where a bridge in a container cannot reach `localhost` on the
   host. `.env.example` has working development values.
5. `pnpm services:up:telegram`, restart `pnpm dev`, and create a **Telegram
   account** connection. Until `NUXT_TELEGRAM_URL` and `NUXT_TELEGRAM_ADMIN_KEY`
   are both set, creating one is refused with "No Telegram bridge is available"
   unless the user supplies their own bridge.

**The encryption key is the most sensitive value the bridge has.** Every stored
session is sealed with it, and each session is full access to that Telegram
account. Losing or changing it unlinks every account; leaking it together with a
database backup hands every account over.

## Where the data lives

In the **same Postgres database Evolution uses**, in its own `telegram` schema.
The bridge creates the schema and its tables on first start and never touches
`public`, where Evolution's tables are, so the two cannot collide. On Railway that
means one Postgres service for both.

The bridge connects with the database's owner credential — the same URL
Evolution has. That is a deliberate trade for a simpler setup: the credential can
read every WhatsApp message in that database, so a compromised bridge is a
compromised Evolution. If you want the app to read Telegram data with less, create
a role with `LOGIN` and nothing else, set `TELEGRAM_READER_ROLE` to its name on
the bridge (it re-grants `SELECT` at every start: on `messages` whole, on `chats`
and `users` column by column so access hashes and phone numbers stay out, and
never on `sessions`), and use that role in `NUXT_TELEGRAM_DATABASE_URL`.

## What syncs

Private chats, bots, groups, supergroups (including forum topics) and channels —
live, plus older history fetched in the background. Edits replace the message
text, reactions are counted on the message, and a deleted message loses its
text rather than staying readable.

Backfill is **slow on purpose**: one page of 100 messages at a time with a pause
of `TELEGRAM_BACKFILL_PAGE_DELAY_MS` (default 1000) between pages, newest chats
first, stopping at `TELEGRAM_BACKFILL_MAX_PER_CHAT` messages (default 2000) or
`TELEGRAM_BACKFILL_DAYS` days (default 365) per chat, and skipping broadcast
channels unless `TELEGRAM_BACKFILL_BROADCAST=true`. An unofficial client that
hammers history is how an account gets restricted. The read tools say when a
chat's history stops at what was synced rather than at its first message.

**Secret chats are never visible.** They exist only on the devices that took
part in them and cannot be synced by any client.

**Unlinking deletes the synced chats**, whether through **Unlink** on the
dashboard or by deleting the connection. A session ended from Telegram → Devices
keeps them, because the likeliest next step is linking the same account again.

## One bridge process at a time

Two processes using the same Telegram session make Telegram kill it, which costs
a QR scan. The bridge takes a Postgres advisory lock per session, so a second
process waits rather than connecting, and takes the session over within about 30
seconds of the first one stopping. Run it as **one instance**, and do not give it
a deployment overlap: while two copies run, the one without the lock reports those
connections as held elsewhere. A short overlap is harmless — alerts wait ten
minutes for that state — but it buys nothing.

## Bring your own bridge

Like Evolution, a user can tick **Use my own Telegram bridge** and give its URL,
admin key and, optionally, a database URL for reading its chats. The URL passes
the same outbound host guard as a user's Evolution server, this deployment's
admin key is never sent to it, and theirs is never sent to ours.

## Developing against Telegram's test servers

`TELEGRAM_TEST_SERVERS=true` points the bridge at Telegram's separate test
environment, where accounts use numbers of the form `99966XYYYY`. That
environment is separate from the real one: an account from one does not exist in
the other, so link a test bridge only from a test account.
