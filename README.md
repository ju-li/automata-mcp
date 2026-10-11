<p align="center">
  <a href="https://getautomata.app">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
      <img src="docs/images/logo-light.svg" alt="Automata" width="300">
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://getautomata.app">Website</a> ·
  <a href="https://www.getautomata.app/docs">Documentation</a> ·
  <a href="https://www.getautomata.app/contact">Contact</a>
</p>

<p align="center">
  <a href="https://railway.com/deploy/automata-or-whatsapp-telegram-sql-mcp?referralCode=HxrUPo&utm_medium=integration&utm_source=template&utm_campaign=generic"><img src="https://railway.com/button.svg" alt="Deploy on Railway"></a>
</p>

**Automata MCP safely gives Claude (or Codex or any AI Agent) access to your WhatsApp, Telegram and PostgreSQL.** Connect an
account or a database once, mint a connector token scoped to the chats or
tables you choose, and paste its URL into Claude as a custom connector. Claude
can then read, search and summarise your conversations, query your data, and —
only if you allow it — send messages and write rows.

Run your own with one click on Railway or with Docker Compose.

## Screenshots

<p align="center">
  <img src="docs/images/claude-chat.png" alt="Claude reading a WhatsApp team chat and querying a database to prepare for a meeting" width="720">
  <br><em>Claude pulls a meeting plan from a WhatsApp group and the numbers from your database, in one answer.</em>
</p>

<p align="center">
  <img src="docs/images/dashboard.png" alt="The Automata connections page with WhatsApp, Telegram and PostgreSQL connections" width="720">
  <br><em>Every connection — WhatsApp, Telegram or PostgreSQL — gets its own Claude connector.</em>
</p>

<p align="center">
  <img src="docs/images/claude-connector.png" alt="An Automata connector in Claude's connector settings, with its tools" width="720">
  <br><em>Added to Claude as a custom connector, with per-tool permissions.</em>
</p>

## Features

- **Three kinds of connection.** A WhatsApp account paired by QR, a Telegram
  account linked by QR, or a PostgreSQL database by connection string.
- **Fifteen MCP tools, five per kind.** Check status, list chats, read and search
  messages, send text; list and describe tables, run queries and — when granted —
  write statements. See [the tool list](docs/using-automata.md#mcp-tools).
- **Your history, not just what arrives next.** WhatsApp history is imported when
  a number is paired; Telegram chats are synced and backfilled.
- **Scoped connector tokens.** Each token reaches exactly one connection, and can
  be narrowed to specific chats, specific tables and specific tools. Tokens are
  shown once, stored only as a hash, and can expire, be rotated or be revoked.
- **Read-only databases by default.** Queries run in read-only transactions, one
  statement at a time, checked against the token's table allowlist by inspecting
  the query plan. Writes need the write tool granted explicitly, and roll back if
  they would touch more rows than allowed.
- **Answers Claude can trust.** Every page says when there is more, reactions and
  WhatsApp's control records are filtered and counted, duplicate copies of a
  message are collapsed, and @-mentions are resolved to names.
- **Built for teams.** Organizations with admins and members, email invitations,
  and connections assigned to the people who should use them.
- **Disconnect alerts.** When a WhatsApp or Telegram connection drops, everyone
  who can reach it gets an email — and another when it recovers.
- **Bring your own backend.** Point a connection at your own Evolution API server
  or Telegram bridge instead of the deployment's.

## Quick start

### Railway (one click)

<a href="https://railway.com/deploy/automata-or-whatsapp-telegram-sql-mcp?referralCode=HxrUPo&utm_medium=integration&utm_source=template&utm_campaign=generic"><img src="https://railway.com/button.svg" alt="Deploy on Railway"></a>

1. Deploy the template.
2. Open the web service's domain and sign up — the first account is the admin.
3. Optional: set `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` on the bridge for
   Telegram, and the `NUXT_SMTP_*` variables on the web service for email.

Every service and variable is explained in [Deploying to Railway](docs/deploy-railway.md).

### Docker Compose

```bash
git clone https://github.com/ju-li/automata-mcp.git && cd automata-mcp
cp .env.selfhost.example .env
for k in POSTGRES_PASSWORD WEBHOOK_SECRET EVOLUTION_API_KEY TELEGRAM_BRIDGE_ADMIN_KEY TELEGRAM_SESSION_ENCRYPTION_KEY; do
  echo "$k=$(openssl rand -hex 32)"; done >> .env

docker compose up -d                                         # database connections
docker compose --profile whatsapp up -d                      # + WhatsApp
docker compose --profile whatsapp --profile telegram up -d   # + Telegram
```

Open <http://localhost:3000> and sign up. Set `NUXT_PUBLIC_APP_URL` in `.env` to
the public `https://` address before Claude connects — connector URLs are built
from it. See [Self-hosting](docs/self-hosting.md).

> [!WARNING]
> Pairing binds a real WhatsApp number, and numbers that pair and unpair
> repeatedly can be banned — use a spare SIM. Never run `docker compose down -v`:
> it deletes every paired session.

### Connect Claude

1. Create a connection and pair it, link it, or paste a connection string.
2. On its dashboard, create a **connector token** and choose what it may reach.
3. In Claude, open **Settings → Connectors → Add custom connector** and paste the
   connector URL. For Claude Code: `claude mcp add --transport http <name> <url>`.

## Documentation

- Product documentation: <https://www.getautomata.app/docs>
- Running and developing this repository: [docs/](docs/README.md) —
  [self-hosting](docs/self-hosting.md), [Railway](docs/deploy-railway.md),
  [WhatsApp](docs/whatsapp.md), [Telegram](docs/telegram.md),
  [PostgreSQL](docs/postgres.md), [alerts](docs/alerts.md),
  [development](docs/development.md)

## License

[MIT](LICENSE)
