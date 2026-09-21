import { z } from 'zod'

/**
 * Read tool for caller-written SQL.
 *
 * Four gates, in `pg-run.ts` and `pg-guard.ts`: the extended protocol (one
 * statement), the plan walk against the table allowlist, the function gate, and
 * a read-only transaction. `DECLARE CURSOR` does the statement-kind check by
 * Postgres's own grammar, which is also where the row cap comes from.
 */
export default defineKindTool({
  name: 'run-query',
  kind: ['postgres'],
  group: 'sql',
  title: 'Run a read-only SQL query',
  description:
    'Run one read-only SQL statement and return its rows. Exactly one statement — '
    + 'a second one after a semicolon is rejected by the database, not silently '
    + 'run. It executes inside a read-only transaction with a statement timeout, '
    + 'so nothing it does can change data, and every table it touches must be '
    + 'inside this connector\'s allowlist: the planner is asked which relations '
    + 'the query resolves to, through views and CTEs included, before a single row '
    + 'is read, and a query that reaches outside is refused with the offending '
    + 'table named. Functions this connector cannot see inside — anything outside '
    + 'pg_catalog — are refused too, so a query calling a helper function must be '
    + 'rewritten against the tables directly. Prefer describe-table over SELECT * '
    + 'on a wide table. The result is ONE PAGE capped at `maxRows`: when `hasMore` '
    + 'is true you have NOT seen the whole result, and because a query without '
    + 'ORDER BY has no stable order you cannot page it with OFFSET — add an ORDER '
    + 'BY on a unique column and a keyset predicate (WHERE id > <last id>), or '
    + 'narrow the query. Never summarise a `hasMore: true` result as if it were '
    + 'the full answer.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    // Repeatable, but not guaranteed to give the same rows twice — the hint
    // describes the call, and the data underneath it moves.
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    sql: z.string().min(1).max(20_000).describe('One SQL query: SELECT, WITH … SELECT, VALUES or TABLE. Not a write.'),
    maxRows: z.number().int().min(1).max(1000).default(200).describe('Hard cap on rows returned. The query is stopped at this many rather than truncated afterwards.'),
    timeoutMs: z.number().int().min(500).max(30_000).default(10_000).describe('Server-side statement timeout, in milliseconds'),
  },
  handler: async ({ sql, maxRows, timeoutMs }) => {
    const { instance, scope } = useMcpAuth()

    const result = await runReadQuery(instance, scope, sql.trim(), { maxRows, timeoutMs })

    return {
      columns: result.columns,
      rowCount: result.rowCount,
      // Same rule as read-messages: wrong only in the safe direction. A page
      // that came back full reports true even when it happened to be the last.
      hasMore: result.hasMore,
      maxRows,
      elapsedMs: result.elapsedMs,
      ...(result.hasMore && {
        note: `Truncated at maxRows=${maxRows}; there is at least one more row. `
          + 'This query has no guaranteed order, so paging it with OFFSET would not be reproducible — '
          + 'add ORDER BY on a unique column and a keyset predicate (WHERE id > <last id>) instead.',
      }),
      // A second kind of truncation needs a second announcement: a clipped cell
      // that says nothing reads as the real value.
      ...(result.truncatedValues > 0 && {
        truncatedValues: result.truncatedValues,
        truncatedValuesNote: 'Some values were too long to return in full and end with an ellipsis. Select a substring or an aggregate if you need the whole value.',
      }),
      ...(!scope.allTables && { scopedToAllowlist: true }),
      rows: result.rows,
    }
  },
})
