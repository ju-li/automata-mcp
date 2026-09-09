import { z } from 'zod'

/**
 * Read tool. Out of scope is refused rather than filtered, unlike `list-tables`:
 * a caller who named a table wants an answer about *that* table, and an empty
 * description reads as "no such table" — which sends the user looking for a
 * schema bug that does not exist.
 *
 * The refusal deliberately does not distinguish "does not exist" from "outside
 * the allowlist". Two answers would make this an oracle for the names of tables
 * this token was not granted.
 */
export default defineMcpTool({
  name: 'describe-table',
  group: 'postgres',
  enabled: event => isToolAllowed(event, 'describe-table', 'postgres'),
  title: 'Describe a database table',
  description:
    'Show one table\'s columns — name, type, nullability, default, identity — plus '
    + 'its primary key, unique constraints, foreign keys, indexes and comments. '
    + 'Use the exact `schema` and `name` that list-tables returned; identifiers are '
    + 'case-sensitive. Read this before writing SQL against a table you have not '
    + 'already described in this conversation: guessing a column name costs a round '
    + 'trip, and guessing a type produces a query that runs and quietly returns the '
    + 'wrong thing. If the table is not reachable the answer is a refusal, not an '
    + 'empty description — call list-tables to see what is reachable.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    schema: z.string().min(1).default('public').describe('Schema exactly as list-tables reported it'),
    name: z.string().min(1).describe('Table name exactly as list-tables reported it, including capitalisation'),
  },
  handler: async ({ schema, name }) => {
    const { instance, scope } = useMcpAuth()

    const table = await describePgTable(instance, scope, schema, name)

    if (!table) {
      throw createError({
        statusCode: 404,
        message: `No table ${qualifiedName(schema, name)} is reachable by this connector. `
          + 'Either it does not exist, or it is outside this token\'s allowed tables. '
          + 'Call list-tables to see what is reachable.',
      })
    }

    return table
  },
})
