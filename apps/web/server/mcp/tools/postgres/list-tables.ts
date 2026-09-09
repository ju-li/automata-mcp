import { z } from 'zod'

/**
 * Read tool, and the vocabulary the other three describe themselves in terms
 * of. Table scope is applied by filtering rather than refusing — a listing is
 * the honest answer to "what can I see", the same call `list-chats` makes.
 */
export default defineMcpTool({
  name: 'list-tables',
  group: 'postgres',
  enabled: event => isToolAllowed(event, 'list-tables', 'postgres'),
  title: 'List database tables',
  description:
    'List the tables, views and materialized views this connector can reach, '
    + 'with their schema, kind, estimated row count and comment. Start here: the '
    + '`schema` and `name` returned are exactly the identifiers describe-table '
    + 'and your SQL must use, **including capitalisation** — a table created as '
    + '"Message" is a different table from message. If this connector is scoped '
    + 'to an allowlist, only allowlisted tables are listed and `scopedToAllowlist` '
    + 'says so; a table missing from this list cannot be reached by any tool here, '
    + 'so do not guess at names. `estimatedRows` is a planner statistic, not a '
    + 'count — never report it as one. This answers with ONE PAGE: when `hasMore` '
    + 'is true there are more tables you have not seen, and you must page with '
    + '`nextPage` before concluding that a table does not exist.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    schema: z.string().min(1).optional().describe('Restrict to one schema, e.g. public'),
    search: z.string().min(1).optional().describe('Case-insensitive substring match on the table name'),
    limit: z.number().int().min(1).max(500).default(100).describe('How many tables to return in this page'),
    page: z.number().int().min(1).default(1).describe('1-based page of `limit` tables. Walk this up while hasMore is true.'),
  },
  handler: async ({ schema, search, limit, page }) => {
    const { instance, scope } = useMcpAuth()

    const { tables, hasMore } = await listPgTables(instance, scope, { schema, search, limit, page })

    return {
      count: tables.length,
      page,
      limit,
      // Ordering is `schema, name`, which live traffic cannot reshuffle, so
      // OFFSET paging here really is stable — unlike run-query, where it is not.
      hasMore,
      ...(hasMore && { nextPage: page + 1 }),
      ...(hasMore && {
        note: `Page ${page} of tables, ordered by schema then name. More match: page with nextPage until hasMore is false before telling the user a table does not exist.`,
      }),
      ...(!scope.allTables && {
        scopedToAllowlist: true,
        allowlistSize: scope.tableNames.length,
      }),
      tables,
    }
  },
})
