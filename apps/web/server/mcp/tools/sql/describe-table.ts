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
export default defineKindTool({
  name: 'describe-table',
  kind: ['postgres'],
  group: 'sql',
  title: 'Describe a database table',
  description:
    'Show one table\'s columns — name, type, nullability, default, identity, and '
    + '`enumValues` where the type is an enum — plus its primary key, unique and '
    + 'CHECK constraints, indexes, comments, and BOTH directions of its foreign '
    + 'keys: `foreignKeys` is where this table points, `referencedBy` is what '
    + 'points at it. Those two are the join graph — read them before inventing a '
    + 'join condition. `enumValues` and the CHECK constraints are a column\'s '
    + 'permitted values: a filter on a value outside them returns no rows and '
    + 'reads like an empty result rather than a mistake. For a view, '
    + '`viewDefinition` is the SQL it is defined as, which names its base tables '
    + 'and join keys. Use the exact `schema` and `name` that list-tables returned; '
    + 'identifiers are case-sensitive. Read this before writing SQL against a table '
    + 'you have not already described in this conversation: guessing a column name '
    + 'costs a round trip, and guessing a type produces a query that runs and '
    + 'quietly returns the wrong thing. A foreign key whose `reachable` is false '
    + 'points at a table this token cannot describe or query, and '
    + '`referencedByOutOfScope` counts inbound keys from tables it cannot name — '
    + 'in both cases tell the user, since only the account owner can widen the '
    + 'allowlist. If the table itself is not reachable the answer is a refusal, not '
    + 'an empty description — call list-tables to see what is reachable.',
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

    const table = await describeSqlTable(instance, scope, schema, name)

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
