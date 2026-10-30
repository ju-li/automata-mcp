# Database connections

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
outright), and anything at all if the role is a superuser. The connection's
dashboard shows a notice when the role is a superuser, bypasses row-level
security, or can read server files (`pg_read_server_files`), checked again on
every health check, and `get-database-info` reports `superuser`. The boundary is
the role:

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
deployment's own database (`NUXT_DATABASE_URL`), Evolution, Evolution database
(`NUXT_EVOLUTION_DATABASE_URL`), Telegram bridge (`NUXT_TELEGRAM_URL`) or
Telegram bridge database (`NUXT_TELEGRAM_DATABASE_URL`) is always refused.

The guard runs whenever a connection is opened, not only when it is saved, so
turning the setting off stops existing connections to private addresses. The
approved address is pinned, so the driver cannot resolve the name to somewhere
else afterwards — except for an IPv6 address, which is checked but not pinned.
