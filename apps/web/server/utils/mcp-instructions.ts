/**
 * What each kind of connection tells a model about itself.
 *
 * These reach the client in the `initialize` response, and most clients paste
 * them into the model's system prompt — so they are written for the facts a
 * model gets wrong, not as a feature list.
 *
 * **Per-request selection is not as simple as it looks.** `mcp.instructions` in
 * nuxt.config is a plain string, and the toolkit resolves the handler config in
 * the FIRST statement of its request handler (`createMcpHandler`,
 * dist/runtime/server/mcp/utils.js:195) — before it calls our auth middleware at
 * :208. So a getter on the handler object fires before `event.context.mcpAuth`
 * exists and would see nothing, every time. The seam that works is the
 * `mcp:config:resolved` hook at :203, which fires inside `next()` on the object
 * that is then handed to `createMcpServer`. See server/plugins/mcp-instructions.ts.
 */

export const WHATSAPP_INSTRUCTIONS = [
  'This server is bound to exactly one WhatsApp account — the one the connector token was issued for.',
  'There is no account to choose and no tool takes an instance argument.',
  'Call `get-connection-status` to check that the account is connected (state `open`) before sending;',
  'in any other state, messages cannot be sent. When `sessionLost` is true the phone is still linked',
  'and the connection dropped — the user can press Reconnect on the account\'s page in the web app;',
  'otherwise the account is not paired and the user needs to scan a QR code there.',
  'Reading and searching cover the history imported when the account was paired as well as',
  'everything since, so older conversations are reachable. An account paired before history',
  'import was added has only what arrived since.',
  '`read-messages` answers with one page, newest first, and says so: when its `hasMore` is true',
  'there are older messages you have not seen, including inside a `since`/`until` range you asked',
  'for. Page with `nextPage` until `hasMore` is false before summarising or reporting on a range,',
  'and treat `covered` — not the range you requested — as what you have actually read.',
  'Reactions are stored as ordinary messages, one record per emoji, and are left out of both',
  'reads and searches unless you pass `includeReactions: true` — a response that omitted them',
  'says so with `reactionsExcluded`. Ask for them when who reacted is the question, not to',
  'reconstruct what was said.',
  'WhatsApp delivers an edit as a separate record and never rewrites the original, so an edited',
  'message appears twice: once as it was first sent, and once with the new text and `editOf`',
  'naming the record it replaces. Read that pair as one message that changed. Some edits arrive',
  'encrypted for the chat\'s participants only — those come back with no text and',
  '`unreadable: \'encrypted-edit\'`, which means the current wording of that message is unknown to',
  'this connector and is not searchable; say so plainly rather than presenting the earlier version',
  'as final or calling it a missing message. WhatsApp\'s own control records — deletions,',
  'disappearing-message timer changes, key exchanges — carry nothing readable and are left out of',
  'reads; when any were, `protocolMessagesExcluded` says how many, and `totalMatching` still',
  'counts them.',
].join(' ')

export const POSTGRES_INSTRUCTIONS = [
  'This server is bound to exactly one PostgreSQL database — the one the connector token was issued for.',
  'There is no database to choose and no tool takes a connection argument.',
  'Call `list-tables` before writing any SQL: it is the vocabulary for everything else here, and a',
  'table that does not appear in it cannot be reached by any tool on this connector, so a name that is',
  'not listed should not be guessed at. Identifiers are case-sensitive — a table created as "Message"',
  'is a different table from message — so use the `schema` and `name` exactly as they come back.',
  '`describe-table` is worth the round trip before querying a table you have not already described:',
  'guessing a column name costs a retry, and guessing a type produces a query that runs and returns',
  'the wrong thing. `estimatedRows` is a planner statistic and not a count; never report it as one.',
  'Every result here is ONE PAGE and says so. `list-tables` pages with `nextPage` in a stable order.',
  '`run-query` does not: when its `hasMore` is true you have not seen the whole result, and because a',
  'query without ORDER BY has no guaranteed order you cannot page it with OFFSET — add an ORDER BY on',
  'a unique column and a keyset predicate instead, or narrow the query. Never summarise a',
  '`hasMore: true` result as though it were the full answer.',
  'This connector may be scoped to specific tables. When it is, every statement is checked against the',
  'query plan before a row is read, and a query that reaches outside is refused with the offending',
  'table named — relay that name to the user, since adding it is something only the account owner can',
  'do. Queries that call functions outside `pg_catalog` are refused for the same reason: this',
  'connector cannot see which tables a user-defined function reads, so it cannot check one. Rewrite',
  'such a query against the tables directly.',
  '`run-query` is read-only and cannot change data whatever it is asked to run. Writes go through',
  '`run-statement`, which many tokens are not granted at all; it takes exactly one INSERT, UPDATE,',
  'DELETE or MERGE, refuses an UPDATE or DELETE with no WHERE clause, and rolls the whole statement',
  'back if it would affect more rows than `maxRows` — so a cap error means nothing changed, and the',
  'right response is to narrow the WHERE clause rather than to raise the cap reflexively. Confirm a',
  'destructive change with the user before making it. Note that a write can fire database triggers',
  'that this connector cannot see and that reach tables outside its allowlist.',
].join(' ')
