import type { Sql, TransactionSql } from 'postgres'
import type { McpScope } from './mcp-scope'
import { sqlRefs, type SqlRefs } from './sql-refs.ts'

/**
 * What a caller-supplied SQL statement is allowed to touch.
 *
 * **Read this before changing anything here.** The checks below are not a
 * stylistic preference; each one closes a specific hole that was verified
 * against Postgres 16, and three of them close holes that the obvious design
 * leaves wide open:
 *
 *   - `EXPLAIN` on `CREATE TABLE AS` and on `SELECT ... INTO` produces a bare
 *     `Result` node with **no target relation**, and `EXPLAIN` on `REFRESH
 *     MATERIALIZED VIEW` answers the literal string `"Utility Statement"` with
 *     no plan at all. A check that only collects relations reads all three as
 *     "touches nothing" and lets them through.
 *   - `SELECT pg_read_file('/etc/passwd')` plans to a `Result` node with zero
 *     relations. So does any call to a plpgsql function whose body reads
 *     whatever it likes. Relations alone do not contain a query.
 *   - `postgres.js` sends `sql.unsafe(text)` over the **simple** query protocol
 *     when no parameters are passed (`src/index.js:119-126`), which runs
 *     everything after a semicolon. One smuggled statement is a full bypass.
 *
 * And what is *not* closed, which must stay documented rather than quietly
 * assumed away:
 *
 *   - **Triggers.** `EXPLAIN` without `ANALYZE` does not mention them. A write
 *     to an allowed table can cascade into tables outside the allowlist and
 *     nothing here can see it, let alone stop it.
 *   - **A superuser role.** It can reach anything through a function the
 *     planner cannot see into. `probePgConnection` detects this so the UI can
 *     say so; the allowlist cannot make it untrue.
 *   - **Foreign tables.** A `Foreign Scan` names the local foreign table, not
 *     the remote object behind it.
 *
 * The honest summary: this keeps a model inside the tables it was pointed at.
 * The security boundary is the database role on the DSN.
 */

/** Plan keys whose values are expression text, where a function call can hide. */
const EXPRESSION_KEYS = [
  'Output', 'Filter', 'Join Filter', 'One-Time Filter', 'Index Cond',
  'Recheck Cond', 'Hash Cond', 'Merge Cond', 'TID Cond', 'Sort Key',
  'Group Key', 'Presorted Key', 'Function Call', 'Table Function Call',
  'Conflict Filter', 'Order By', 'Hash Key', 'Cache Key', 'Repeatable Seed',
]

/**
 * `pg_catalog` functions that read or write outside the query's own relations.
 * Being builtin is not the same as being harmless.
 */
const CATALOG_DENYLIST = new Set([
  'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file',
  'lo_import', 'lo_export', 'lo_get', 'lo_put',
  'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf', 'pg_rotate_logfile',
  'pg_logical_slot_get_changes', 'pg_logical_slot_peek_changes',
  'pg_create_logical_replication_slot', 'pg_drop_replication_slot',
  'set_config', 'pg_sleep', 'pg_sleep_for', 'pg_sleep_until',
  // Session-scoped locks outlive the request. `pg-pool.ts` hands the same
  // connection to the next caller, so a `pg_advisory_lock` taken here is still
  // held by whoever gets that socket next — indefinitely, since nothing in this
  // app ever unlocks it. The `_xact_` variants release at commit and would be
  // harmless, but they are denied too: telling the two apart in expression text
  // is exactly the kind of near-miss this list exists to avoid.
  'pg_advisory_lock', 'pg_advisory_lock_shared',
  'pg_advisory_xact_lock', 'pg_advisory_xact_lock_shared',
  'pg_try_advisory_lock', 'pg_try_advisory_lock_shared',
  'pg_try_advisory_xact_lock', 'pg_try_advisory_xact_lock_shared',
  'pg_advisory_unlock', 'pg_advisory_unlock_shared', 'pg_advisory_unlock_all',
  'dblink', 'dblink_exec', 'dblink_connect',
  // Run SQL text they are handed, which the plan never shows: `ts_stat(query)`
  // and `ts_rewrite(tsquery, select)`. The `*_to_xml*` family is matched by
  // name pattern in `reachesOutside` instead of listed here.
  'ts_stat', 'ts_rewrite',
])

/**
 * The SQL/XML export family: `table_to_xml`, `schema_to_xml`, `database_to_xml`,
 * `query_to_xml`, `cursor_to_xml` and every `_and_xmlschema` / `xmlschema`
 * variant. Each reads whole tables (or runs a query) *inside* the function, so
 * the plan is a bare `Result` naming no relation and `assertRelationsInScope`
 * has nothing to check — `table_to_xml('public.users'::regclass, …)` read any
 * table past a token's scope. Matched as a pattern, not a list, because listing
 * three of fifteen is how the rest got through.
 */
const XML_EXPORT_RE = /_to_xml/

/** A builtin that reads or writes outside the query's own relations. */
export function reachesOutside(name: string): boolean {
  return CATALOG_DENYLIST.has(name) || XML_EXPORT_RE.test(name)
}

/**
 * Catalog relations that hold something other than schema, refused for a token
 * scoped to specific tables (an `allTables` token can read every table anyway).
 *
 *   - `pg_statistic` and the extended-statistics pair hold values *sampled from
 *     the rows* — `most_common_vals`, `histogram_bounds` — for every table the
 *     role can read. `pg_stats` and `pg_stats_ext` are views over them, so a
 *     scoped token read an out-of-scope table's low-cardinality columns in full.
 *     Refused for in-scope tables too: the plan touches the catalog as a whole
 *     and cannot tell which table a `WHERE tablename = ...` picks.
 *   - `pg_largeobject` is large-object content (superuser-only by default; this
 *     matters for the superuser DSN the UI already warns about).
 *   - `pg_user_mapping` carries foreign-server passwords, which the
 *     `pg_user_mappings` view shows the mapping's own role.
 */
const CONTENT_CATALOGS = new Set([
  'pg_catalog.pg_statistic',
  'pg_catalog.pg_statistic_ext',
  'pg_catalog.pg_statistic_ext_data',
  'pg_catalog.pg_largeobject',
  'pg_catalog.pg_user_mapping',
])

/**
 * `pg_stat_activity` (and `pg_stat_ssl` / `pg_stat_gssapi`, built on the same
 * function) returns the query text of every session of this role — other
 * tokens' SQL, the owner's own application — and that text can quote values
 * from any table. Same rule as `CONTENT_CATALOGS`, but a function, not a relation.
 */
const SCOPED_CONTENT_FUNCTIONS = new Set([
  'pg_stat_get_activity', 'pg_stat_get_backend_activity',
  // The extension's own text of every normalised statement, constants included
  // unless jumbled. Installed into `pg_catalog` on some servers, so the
  // non-`pg_catalog` refusal in `assertFunctionsSafe` does not reach it there.
  'pg_stat_statements',
])

export interface PlanRelation {
  schema: string
  relation: string
  qname: string
}

export interface PlanFacts {
  relations: PlanRelation[]
  /**
   * Every function, operator and identifier the plan's expressions mention,
   * names in exact case (unquoted ones folded, as Postgres does), for
   * `assertFunctionsSafe`.
   */
  refs: SqlRefs
  /** Every ModifyTable operation found anywhere in the plan. */
  modifyOperations: string[]
  /** True when the root node of the first plan is a ModifyTable. */
  rootIsModify: boolean
  /** Set when a ModifyTable's target is scanned with no filter at all. */
  unfilteredWriteTarget?: string
}

const MODIFY_OPERATIONS = new Set(['Insert', 'Update', 'Delete', 'Merge'])

function refuse(message: string): never {
  throw createError({ statusCode: 403, message })
}

/**
 * Turn EXPLAIN (FORMAT JSON, VERBOSE) output into the facts the checks need.
 *
 * Walks **every** element of the top-level array: the rewriter produces one
 * query tree per rule, and EXPLAIN emits one element for each.
 */
export function readPlan(queryPlan: unknown): PlanFacts {
  if (!Array.isArray(queryPlan) || queryPlan.length === 0) {
    refuse('The database could not produce a query plan for that statement, so it cannot be checked against this token\'s allowed tables. Rewrite it as a plain query.')
  }

  const relations: PlanRelation[] = []
  const refs: SqlRefs = { calls: [], operators: [], identifiers: [], opaque: false }
  const modifyOperations: string[] = []
  let rootIsModify = false
  let unfilteredWriteTarget: string | undefined

  queryPlan.forEach((element, index) => {
    // `REFRESH MATERIALIZED VIEW` answers the *string* "Utility Statement" with
    // no Plan key. Anything without a plan is refused rather than read as
    // "touches nothing" — that is the whole trap.
    if (typeof element !== 'object' || element === null || !('Plan' in element)) {
      refuse('That statement has no query plan, so this connector cannot tell which tables it would touch. Only plain queries and INSERT/UPDATE/DELETE/MERGE are supported.')
    }

    const root = (element as { Plan: unknown }).Plan
    if (index === 0 && isNode(root) && root['Node Type'] === 'ModifyTable') {
      rootIsModify = true
    }

    walk(root, (node) => {
      const relation = node['Relation Name']
      if (typeof relation === 'string' && relation.length > 0) {
        const schema = node.Schema
        if (typeof schema !== 'string' || schema.length === 0) {
          // Only VERBOSE emits Schema. Without it an unqualified relation would
          // have to be assumed `public`, and assuming is exactly what a scope
          // check must not do.
          refuse(`The query plan named a relation (${relation}) without a schema, so it cannot be matched against this token's allowed tables.`)
        }
        relations.push({ schema, relation, qname: `${schema}.${relation}` })
      }

      if (node['Node Type'] === 'ModifyTable') {
        const operation = typeof node.Operation === 'string' ? node.Operation : 'Unknown'
        modifyOperations.push(operation)
        if ((operation === 'Update' || operation === 'Delete') && isUnfiltered(node)) {
          unfilteredWriteTarget = typeof node['Relation Name'] === 'string' ? node['Relation Name'] : 'the target table'
        }
      }

      // A Function Scan carries `Schema` and `Function Name` but no relation.
      // Collecting Schema opportunistically would fabricate relation pairs.
      // `Function Name` is the bare catalog name, exact case, never quoted.
      const fnName = node['Function Name']
      if (typeof fnName === 'string') refs.calls.push(fnName)

      for (const key of EXPRESSION_KEYS) {
        for (const text of expressionTexts(node[key])) sqlRefs(text, refs)
      }
    })
  })

  return {
    relations,
    refs,
    modifyOperations,
    rootIsModify,
    unfilteredWriteTarget,
  }
}

type PlanNode = Record<string, unknown>

function isNode(value: unknown): value is PlanNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Depth-first over every nested plan node, whatever key nests it. */
function walk(node: unknown, visit: (node: PlanNode) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!isNode(node)) return

  visit(node)

  // `Plans` covers children, CTEs, InitPlan and SubPlan alike; the others are
  // belt and braces against a shape a future major adds.
  for (const key of ['Plans', 'Plan', 'Subplan', 'CTE']) {
    if (key in node) walk(node[key], visit)
  }
}

/** The strings under one plan key: a single expression or a list of them. */
function expressionTexts(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(expressionTexts)
  return []
}

function isUnfiltered(node: PlanNode): boolean {
  const children = node.Plans
  if (!Array.isArray(children) || children.length === 0) return false

  let scans = 0
  let qualified = false

  // Recursive, and over every child rather than a single Seq Scan: a DELETE on a
  // partitioned table plans as a ModifyTable over an Append with one scan per
  // partition, which the single-child form read as "filtered" — silently
  // exempting the exact whole-table write this is here to catch.
  walk(children, (child) => {
    const type = child['Node Type']
    if (typeof type !== 'string' || !type.endsWith('Scan')) return
    scans += 1
    if ('Filter' in child || 'Index Cond' in child || 'Recheck Cond' in child || 'TID Cond' in child) {
      qualified = true
    }
  })

  return scans > 0 && !qualified
}

// ── the checks ─────────────────────────────────────────────────────────────

export function assertNoWrites(facts: PlanFacts): void {
  if (facts.modifyOperations.length === 0) return
  refuse(
    `That statement would ${facts.modifyOperations[0]!.toLowerCase()} data, and this is the read-only tool. `
    + 'Use run-statement for a write, if this connector token is allowed to.',
  )
}

export function assertIsModify(facts: PlanFacts, allowWholeTable = false): void {
  // `rootIsModify` is only set for a node `walk` also visits, and every
  // ModifyTable node it visits pushes an operation — so the root flag alone is
  // the whole test.
  if (!facts.rootIsModify) {
    refuse('run-statement takes exactly one INSERT, UPDATE, DELETE or MERGE. DDL, TRUNCATE, COPY, CREATE TABLE AS and plain queries are not accepted here — use run-query to read.')
  }
  const unsupported = facts.modifyOperations.filter(op => !MODIFY_OPERATIONS.has(op))
  if (unsupported.length > 0) {
    refuse(`That statement performs an unsupported operation (${unsupported[0]}).`)
  }
  if (facts.unfilteredWriteTarget && !allowWholeTable) {
    // Names the argument and not a SQL phrasing: `WHERE true` is folded away by
    // the planner, so the qualifier never reaches the plan and the advice the
    // message used to give could not be followed.
    refuse(
      `That statement would ${facts.modifyOperations[0]!.toLowerCase()} every row of ${facts.unfilteredWriteTarget} — it has no WHERE clause. `
      + 'Add one, or pass allowWholeTable: true if changing every row is genuinely what you mean.',
    )
  }
}

/**
 * Refuse any function the planner cannot see inside, however it is reached.
 *
 * A function body is opaque to the plan, so a call to one is a hole exactly the
 * size of whatever the role can read. Refused:
 *
 *   - **calls** to anything outside `pg_catalog`, anything `SECURITY DEFINER`,
 *     and the builtins that reach outside the query (`reachesOutside`). Names
 *     are matched with their exact case: `"Peek"` is a different function from
 *     `peek`, and folding it found nothing.
 *   - **operators** whose function is outside `pg_catalog` and can run SQL —
 *     any language but C/internal — or is `SECURITY DEFINER`. `1 === 2` calls
 *     that function with no `name(` anywhere. C operators from extensions
 *     (hstore `->`, pg_trgm `%`) cannot run queries and stay allowed.
 *   - **casts** backed by such a function, when the statement names the target
 *     type or the cast can apply implicitly (`castcontext` `i`/`a`), since then
 *     no type name need appear at all.
 *   - **`U&"…" UESCAPE`**: an escape this reader does not decode.
 *
 * The references come from `sql-refs.ts`'s tokenizer, over the statement text
 * and over the plan's expressions. Over-collecting is free: a name that
 * resolves to nothing is dropped.
 */
export async function assertFunctionsSafe(tx: TransactionSql, refs: SqlRefs, checked?: SqlRefs): Promise<void> {
  if (refs.opaque) {
    refuse('This connector will not run a statement with a U&"…" UESCAPE identifier: it cannot tell which function or table that names. Write the name plainly.')
  }

  // The plan pass hands the text pass's refs as `checked`: only what is new is
  // looked up, and the implicit-cast arm (which does not depend on the
  // statement) runs once.
  const fresh = (list: string[], seen?: string[]) => {
    const skip = new Set(seen)
    return [...new Set(list)].filter(item => !skip.has(item))
  }
  const names = fresh(refs.calls, checked?.calls)
  const operators = fresh(refs.operators, checked?.operators)
  const identifiers = fresh(refs.identifiers, checked?.identifiers)
  const implicitCasts = !checked

  const denied = names.find(name => reachesOutside(name.toLowerCase()))
  if (denied) {
    refuse(`This connector will not run a query that calls ${denied}(). It reaches outside the tables this token is scoped to.`)
  }
  if (!names.length && !operators.length && !identifiers.length && !implicitCasts) return

  // One round trip to the user's server, not three: each arm finds at most one
  // offender. Calls outside pg_catalog sort before SECURITY DEFINER builtins so
  // the refusal names the likelier cause.
  const [found] = await tx<Array<{ kind: 'call' | 'operator' | 'cast', nspname: string, proname: string, prosecdef: boolean, detail: string }>>`
    (SELECT 'call'::text AS kind, n.nspname, p.proname, p.prosecdef, ''::text AS detail
     FROM pg_catalog.pg_proc p
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = ANY (${names}::text[])
       AND (n.nspname <> 'pg_catalog' OR p.prosecdef)
     ORDER BY n.nspname = 'pg_catalog'
     LIMIT 1)
    UNION ALL
    (SELECT 'operator', n.nspname, p.proname, p.prosecdef, o.oprname::text
     FROM pg_catalog.pg_operator o
     JOIN pg_catalog.pg_proc p ON p.oid = o.oprcode
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     JOIN pg_catalog.pg_language l ON l.oid = p.prolang
     WHERE o.oprname = ANY (${operators}::text[])
       AND n.nspname <> 'pg_catalog'
       AND (l.lanname NOT IN ('c', 'internal') OR p.prosecdef)
     LIMIT 1)
    UNION ALL
    (SELECT 'cast', n.nspname, p.proname, p.prosecdef, t.typname::text
     FROM pg_catalog.pg_cast c
     JOIN pg_catalog.pg_proc p ON p.oid = c.castfunc
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     JOIN pg_catalog.pg_language l ON l.oid = p.prolang
     JOIN pg_catalog.pg_type t ON t.oid = c.casttarget
     WHERE n.nspname <> 'pg_catalog'
       AND (l.lanname NOT IN ('c', 'internal') OR p.prosecdef)
       AND ((${implicitCasts} AND c.castcontext IN ('i', 'a')) OR t.typname = ANY (${identifiers}::text[]))
     LIMIT 1)
    LIMIT 1`
  if (!found) return

  switch (found.kind) {
    case 'call':
      if (found.nspname !== 'pg_catalog') {
        refuse(
          `This connector will not run a query that calls ${found.nspname}.${found.proname}(). `
          + 'It cannot see which tables a user-defined function reads, so it cannot check it against this token\'s allowed tables. '
          + 'Rewrite the query against the tables directly.',
        )
      }
      refuse(`This connector will not run a query that calls ${found.proname}(): it is SECURITY DEFINER and runs with privileges this token was not granted.`)
    case 'operator':
      refuse(
        `This connector will not run a query that uses the operator ${found.detail}: it calls ${found.nspname}.${found.proname}(), `
        + 'a user-defined function this connector cannot check against this token\'s allowed tables.',
      )
    case 'cast':
      refuse(
        `This connector will not run this query: a cast to ${found.detail} calls ${found.nspname}.${found.proname}(), `
        + 'a user-defined function this connector cannot check against this token\'s allowed tables.',
      )
    default: {
      // Exhaustive without importing #shared (plain-Node tests load this file).
      const unknownKind: never = found.kind
      throw new Error(`unhandled refusal kind ${String(unknownKind)}`)
    }
  }
}

/**
 * Every relation the planner resolved must be inside the allowlist.
 *
 * Matching is case-sensitive on both halves. Postgres folds *unquoted*
 * identifiers to lower case when parsing but stores what was actually created —
 * Evolution's own tables are `public.Message` and `public.Chat`. Folding here
 * would refuse a legitimately allowlisted table; loosening the comparison would
 * let `public.orders` match a different table called `public.Orders`.
 *
 * The allowlist is expanded **downward** through `pg_inherits` first. A SELECT
 * on a partitioned table plans as an Append over the individual partitions and
 * the parent's name never appears in the plan at all, so an allowlist of
 * `public.events` would otherwise refuse a perfectly legal query. Expanding the
 * allowlist cannot admit a sibling; mapping the plan upward could.
 */
export async function assertRelationsInScope(
  tx: TransactionSql,
  facts: PlanFacts,
  scope: McpScope,
): Promise<void> {
  if (scope.allTables) return

  // Before the empty-relations shortcut: `pg_stat_activity` plans to a bare
  // Function Scan with no relation at all.
  const contentFunction = facts.refs.calls.find(n => SCOPED_CONTENT_FUNCTIONS.has(n.toLowerCase()))
  if (contentFunction) {
    refuse(
      `This connector token is scoped to specific tables, so it will not run a query that calls ${contentFunction}(): `
      + 'it returns the text of other sessions\' queries, which can quote values from any table.',
    )
  }

  if (facts.relations.length === 0) return

  const allowed = await expandAllowlist(tx, scope.tableNames)

  for (const relation of facts.relations) {
    if (CONTENT_CATALOGS.has(relation.qname)) {
      refuse(
        `This connector token is scoped to specific tables, so it cannot read ${relation.qname}: `
        + 'it holds data from beyond those tables (sampled column values behind pg_stats, large objects, or credentials). '
        + 'Query the allowed tables directly instead.',
      )
    }

    // The catalogs are how a query names its own columns and types; refusing
    // them would refuse almost every real query. What they expose is schema:
    // names, types, and object definitions (view and function bodies) — stated
    // in the docs rather than pretended away. The few that hold row values or
    // credentials are refused just above.
    if (relation.schema === 'pg_catalog' || relation.schema === 'information_schema') continue

    // `allowed` is `scope.tableNames` plus whatever inherits from it, so a name
    // that misses here also misses `isTableAllowed` — the refusal wording lives
    // in mcp-scope.ts with the rest of the scope vocabulary, not here.
    if (!allowed.has(relation.qname)) assertTableAllowed(scope, relation.qname)
  }
}

async function expandAllowlist(tx: TransactionSql, tableNames: string[]): Promise<Set<string>> {
  if (tableNames.length === 0) return new Set()

  const rows = await tx<Array<{ qname: string }>>`
    WITH RECURSIVE seed AS (
      SELECT c.oid
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE (n.nspname || '.' || c.relname) = ANY (${tableNames}::text[])
    ), tree AS (
      SELECT oid FROM seed
      UNION
      SELECT i.inhrelid FROM pg_catalog.pg_inherits i JOIN tree t ON t.oid = i.inhparent
    )
    SELECT n.nspname || '.' || c.relname AS qname
    FROM tree
    JOIN pg_catalog.pg_class c ON c.oid = tree.oid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace`

  const expanded = new Set(rows.map(r => r.qname))
  // Keep the names as written too: a table that does not exist yet should be
  // refused by Postgres with "relation does not exist", not by us with a
  // confusing scope error.
  for (const name of tableNames) expanded.add(name)
  return expanded
}

/**
 * The `search_path` for a scoped session: the allowlist's own schemas, then
 * `pg_catalog`.
 *
 * This is *not* the security control — the plan reports every schema fully
 * resolved by the planner, whatever the path was. It buys two other things: the
 * check and the execution run under one `SET LOCAL` so the same text resolves
 * to the same objects in both, and an unqualified name lands inside the
 * allowlist rather than resolving elsewhere and being refused confusingly.
 */
export function searchPathFor(scope: McpScope): string {
  if (scope.allTables) return 'public, pg_catalog'
  const schemas = [...new Set(scope.tableNames.map(t => t.split('.')[0]!).filter(Boolean))]
  return [...schemas.map(quoteIdent), 'pg_catalog'].join(', ')
}

const SAFE_IDENT = /^[a-z_][a-z0-9_$]*$/

export function quoteIdent(value: string): string {
  return SAFE_IDENT.test(value) ? value : `"${value.replace(/"/g, '""')}"`
}

/**
 * The only way caller-supplied SQL may be sent.
 *
 * `sql.unsafe(text)` with no arguments defaults to `simple: true`
 * (`postgres/src/index.js:119-126`), the *simple* query protocol, which runs
 * every statement in the string — `SELECT 1; DROP TABLE t` executes both. The
 * extended protocol permits exactly one statement and Postgres rejects a second
 * with 42601 itself, so this is the server's guarantee rather than a regex of
 * ours. Never call `unsafe` on caller input anywhere else.
 */
export function unsafeSingle(tx: TransactionSql | Sql, text: string) {
  // `simple` is honoured at runtime (src/index.js:124) but missing from
  // postgres.js's shipped `UnsafeQueryOptions`, which declares `prepare` alone.
  // The cast is the whole reason this function exists in one place: it is not a
  // convenience wrapper, it is the multi-statement gate, and a call site that
  // wrote the options inline would be one `simple` away from a silent bypass.
  const options = { simple: false, prepare: false } as { prepare?: boolean }
  return tx.unsafe(text, [], options)
}
