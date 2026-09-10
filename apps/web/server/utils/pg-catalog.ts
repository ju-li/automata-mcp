import type { AppInstance } from './pocketbase'
import type { McpScope } from './mcp-scope'

/**
 * Schema introspection for a user's Postgres connection.
 *
 * Shared by the MCP tools and by the token scope picker, so what a model can
 * see and what an owner can grant are computed by the same query. Two lists
 * that could disagree about which tables exist would be a support problem the
 * first time they did.
 *
 * **Scope is a predicate, never a post-filter.** The allowlist goes into the
 * WHERE clause, so out-of-scope names never enter this process — the same rule
 * `evolution-db.ts` follows for chat scope, and the reason `hasMore` here means
 * "more tables *you can see*" rather than "more rows we then hid from you".
 */

export interface PgTable {
  schema: string
  name: string
  qname: string
  kind: 'table' | 'partitioned table' | 'view' | 'materialized view' | 'foreign table'
  comment?: string
  /**
   * `pg_class.reltuples`, which is a planner statistic and not a count. Null
   * until the table has been analysed. Named `estimatedRows` everywhere it is
   * surfaced, because a number labelled `rows` will be quoted as a fact.
   */
  estimatedRows: number | null
}

export interface PgTablePage {
  tables: PgTable[]
  hasMore: boolean
}

const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema']

/**
 * Ceiling for one page of tables. The scope picker asks for a big page because
 * it renders a checkbox list; a database with more relations than this pages,
 * and the caller is told it did.
 */
export const MAX_TABLE_PAGE = 1000

export interface ListTablesOptions {
  schema?: string
  search?: string
  limit: number
  page: number
}

export async function listPgTables(
  instance: Pick<AppInstance, 'id' | 'dsn'>,
  scope: McpScope,
  options: ListTablesOptions,
): Promise<PgTablePage> {
  const sql = await pgFor(instance)
  const offset = (options.page - 1) * options.limit
  const pattern = options.search ? `%${escapeLike(options.search)}%` : null

  const rows = await sql<Array<{
    schema: string
    name: string
    kind: string
    comment: string | null
    estimated_rows: string | null
  }>>`
    SELECT n.nspname AS schema,
           c.relname AS name,
           c.relkind AS kind,
           pg_catalog.obj_description(c.oid, 'pg_class') AS comment,
           CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS estimated_rows
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = ANY ('{r,p,v,m,f}')
      -- A partition is an implementation detail of its parent. Listing every
      -- child would bury the tables a caller actually addresses.
      AND NOT c.relispartition
      AND n.nspname <> ALL (${SYSTEM_SCHEMAS}::text[])
      AND n.nspname NOT LIKE 'pg\\_toast%'
      AND n.nspname NOT LIKE 'pg\\_temp%'
      -- Nothing is listed that this role could not read anyway; a name in a
      -- listing that then refuses to open is worse than an absence.
      AND pg_catalog.has_table_privilege(c.oid, 'SELECT')
      AND (${scope.allTables}
           OR (n.nspname || '.' || c.relname) = ANY (${scope.tableNames}::text[]))
      AND (${options.schema ?? null}::text IS NULL OR n.nspname = ${options.schema ?? null})
      AND (${pattern}::text IS NULL OR c.relname ILIKE ${pattern})
    ORDER BY n.nspname, c.relname
    OFFSET ${offset}
    LIMIT ${options.limit + 1}`

  const hasMore = rows.length > options.limit

  return {
    hasMore,
    tables: rows.slice(0, options.limit).map(row => ({
      schema: row.schema,
      name: row.name,
      qname: qualifiedName(row.schema, row.name),
      kind: relkindLabel(row.kind) as PgTable['kind'],
      ...(row.comment ? { comment: row.comment } : {}),
      estimatedRows: row.estimated_rows === null ? null : Number(row.estimated_rows),
    })),
  }
}

// Type aliases rather than interfaces, for the reason `InstanceStatus` in
// instances.ts gives: an MCP tool handler may return `Record<string, unknown>`,
// and an interface has no implicit index signature, so `describe-table` would
// fail to typecheck on the value it returns.
export type PgColumn = {
  name: string
  type: string
  nullable: boolean
  default?: string
  identity: boolean
  comment?: string
}

export type PgTableDescription = {
  schema: string
  name: string
  qname: string
  kind: string
  comment?: string
  estimatedRows: number | null
  columns: PgColumn[]
  primaryKey: string[]
  foreignKeys: Array<{ name: string, definition: string }>
  uniqueConstraints: Array<{ name: string, definition: string }>
  indexes: Array<{ name: string, definition: string }>
}

/**
 * Describe one table, or answer `undefined` when it is not reachable.
 *
 * The allowlist is applied in the anchor CTE, so an out-of-scope table produces
 * no rows at all rather than a description we then discard. The caller turns
 * that into one message covering both "does not exist" and "out of scope": two
 * distinguishable answers would make this an oracle for table names the token
 * was not granted.
 */
export async function describePgTable(
  instance: Pick<AppInstance, 'id' | 'dsn'>,
  scope: McpScope,
  schema: string,
  name: string,
): Promise<PgTableDescription | undefined> {
  const sql = await pgFor(instance)
  const qname = qualifiedName(schema, name)

  const [target] = await sql<Array<{
    oid: number
    kind: string
    comment: string | null
    estimated_rows: string | null
  }>>`
    SELECT c.oid,
           c.relkind AS kind,
           pg_catalog.obj_description(c.oid, 'pg_class') AS comment,
           CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS estimated_rows
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema}
      AND c.relname = ${name}
      AND pg_catalog.has_table_privilege(c.oid, 'SELECT')
      AND (${scope.allTables} OR ${qname} = ANY (${scope.tableNames}::text[]))`

  if (!target) return undefined

  // The three below depend only on `target.oid` and on nothing else, so they go
  // out together rather than in series. `describe-table` is a tool the
  // instructions tell the model to call before querying anything it has not
  // seen, so three sequential round trips to a managed database was the
  // dominant cost of using it.
  const [columns, constraints, indexes] = await Promise.all([
    sql<Array<{
    name: string
    type: string
    nullable: boolean
    default: string | null
    identity: boolean
    comment: string | null
  }>>`
    SELECT a.attname AS name,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
           NOT a.attnotnull AS nullable,
           pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default,
           a.attidentity <> '' AS identity,
           pg_catalog.col_description(a.attrelid, a.attnum) AS comment
    FROM pg_catalog.pg_attribute a
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = ${target.oid}
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY a.attnum`,

    sql<Array<{ name: string, type: string, definition: string }>>`
    SELECT con.conname AS name,
           con.contype::text AS type,
           pg_catalog.pg_get_constraintdef(con.oid) AS definition
    FROM pg_catalog.pg_constraint con
    WHERE con.conrelid = ${target.oid}
      AND con.contype = ANY ('{p,f,u}')
    ORDER BY con.contype, con.conname`,

    sql<Array<{ name: string, definition: string }>>`
    SELECT c.relname AS name, pg_catalog.pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = ${target.oid}
    ORDER BY c.relname`,
  ])

  const primary = constraints.find(c => c.type === 'p')

  return {
    schema,
    name,
    qname,
    kind: relkindLabel(target.kind),
    ...(target.comment ? { comment: target.comment } : {}),
    estimatedRows: target.estimated_rows === null ? null : Number(target.estimated_rows),
    columns: columns.map(column => ({
      name: column.name,
      type: column.type,
      nullable: column.nullable,
      ...(column.default ? { default: column.default } : {}),
      identity: column.identity,
      ...(column.comment ? { comment: column.comment } : {}),
    })),
    primaryKey: primary ? parseKeyColumns(primary.definition) : [],
    foreignKeys: constraints.filter(c => c.type === 'f').map(({ name, definition }) => ({ name, definition })),
    uniqueConstraints: constraints.filter(c => c.type === 'u').map(({ name, definition }) => ({ name, definition })),
    indexes: indexes.map(({ name, definition }) => ({ name, definition })),
  }
}

function relkindLabel(relkind: string): string {
  switch (relkind) {
    case 'r': return 'table'
    case 'p': return 'partitioned table'
    case 'v': return 'view'
    case 'm': return 'materialized view'
    case 'f': return 'foreign table'
    default: return relkind
  }
}

/** `PRIMARY KEY (a, b)` -> `['a', 'b']`. The definition is kept alongside anyway. */
function parseKeyColumns(definition: string): string[] {
  const inner = /\(([^)]*)\)/.exec(definition)?.[1]
  if (!inner) return []
  return inner.split(',').map(part => part.trim().replace(/^"|"$/g, '')).filter(Boolean)
}
