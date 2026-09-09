import type { TransactionSql } from 'postgres'
import type { AppInstance } from './pocketbase'
import type { McpScope } from './mcp-scope'

/**
 * Running caller-supplied SQL.
 *
 * Everything a user's SQL touches goes through one of the two functions here,
 * and both compose the same checks in the same order. See `pg-guard.ts` for why
 * each check exists and what is still open.
 *
 * **One transaction, not two.** The plan check and the execution share a
 * transaction so that (a) the `AccessShareLock` EXPLAIN takes is held until the
 * statement has run, which stops a concurrent `CREATE OR REPLACE VIEW` from
 * repointing a view between the check and the execution, and (b) both run under
 * one `SET LOCAL search_path`, so the same text provably resolves to the same
 * objects in both.
 */

/** How much of one cell is ever returned. A bytea column would otherwise blow the response. */
const MAX_CELL_CHARS = 2000
const MAX_RETURNING_ROWS = 100

export interface ReadQueryOptions {
  maxRows: number
  timeoutMs: number
}

export interface ReadQueryResult {
  columns: string[]
  rows: Array<Record<string, unknown>>
  rowCount: number
  hasMore: boolean
  truncatedValues: number
  elapsedMs: number
}

/**
 * `SET LOCAL`, as bind parameters.
 *
 * `set_config(name, value, is_local := true)` is exactly `SET LOCAL`, and its
 * `value` is a plain `text` parameter — so nothing here is interpolated into
 * SQL text and there is no quoting for us to get wrong. A literal
 * `SET LOCAL search_path = <scope-derived string>` would be string-built DDL on
 * a path derived from user-chosen schema names.
 */
async function applySessionGuards(tx: TransactionSql, scope: McpScope, timeoutMs: number): Promise<void> {
  await tx`SELECT
    set_config('search_path',                         ${searchPathFor(scope)}, true),
    set_config('statement_timeout',                   ${String(timeoutMs)},    true),
    set_config('lock_timeout',                        ${'3000'},               true),
    set_config('idle_in_transaction_session_timeout', ${'15000'},              true),
    -- JIT compilation on a one-shot analytical query costs more than it saves,
    -- and its planning time counts against statement_timeout.
    set_config('jit',                                 ${'off'},                true)`
}

export async function runReadQuery(
  instance: Pick<AppInstance, 'id' | 'dsn'>,
  scope: McpScope,
  statement: string,
  options: ReadQueryOptions,
): Promise<ReadQueryResult> {
  const sql = await pgFor(instance)
  const startedAt = Date.now()

  return await sql.begin('read only', async (tx) => {
    await applySessionGuards(tx, scope, options.timeoutMs)

    const explained = await unsafeSingle(tx, `EXPLAIN (FORMAT JSON, VERBOSE) ${statement}`)
    const facts = readPlan((explained as Array<Record<string, unknown>>)[0]?.['QUERY PLAN'])

    assertNoWrites(facts)
    await assertFunctionsSafe(tx, facts)
    await assertRelationsInScope(tx, facts, scope)

    // The statement-kind gate, enforced by Postgres's own grammar rather than by
    // parsing: DECLARE CURSOR refuses INSERT/UPDATE/DELETE/CREATE TABLE AS
    // outright, refuses SELECT ... INTO by name, and answers 0A000 for a
    // data-modifying WITH. Two of those — CTAS and SELECT INTO — plan to a bare
    // Result node with no target relation, so the relation check above cannot
    // see them at all.
    await unsafeSingle(tx, `DECLARE _mcp NO SCROLL CURSOR FOR ${statement}`)

    // One row past the cap, so `hasMore` is "the page came back full" rather
    // than a count that could be wrong — the same rule as MessagePage.
    const fetched = await unsafeSingle(tx, `FETCH FORWARD ${options.maxRows + 1} FROM _mcp`)
    const raw = fetched as unknown as Array<Record<string, unknown>> & { columns?: Array<{ name: string }> }

    const hasMore = raw.length > options.maxRows
    const kept = raw.slice(0, options.maxRows)

    let truncatedValues = 0
    const rows = kept.map((row) => {
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(row)) {
        const { value: serialised, truncated } = serialiseCell(value)
        if (truncated) truncatedValues += 1
        out[key] = serialised
      }
      return out
    })

    return {
      columns: raw.columns?.map(c => c.name) ?? Object.keys(kept[0] ?? {}),
      rows,
      rowCount: rows.length,
      hasMore,
      truncatedValues,
      elapsedMs: Date.now() - startedAt,
    }
  })
}

export interface WriteStatementResult {
  command: string
  rowCount: number
  returning: Array<Record<string, unknown>>
  returningTruncated: boolean
  elapsedMs: number
}

export async function runWriteStatement(
  instance: Pick<AppInstance, 'id' | 'dsn'>,
  scope: McpScope,
  statement: string,
  options: { maxRows: number, timeoutMs: number },
): Promise<WriteStatementResult> {
  const sql = await pgFor(instance)
  const startedAt = Date.now()

  return await sql.begin(async (tx) => {
    await applySessionGuards(tx, scope, options.timeoutMs)

    const explained = await unsafeSingle(tx, `EXPLAIN (FORMAT JSON, VERBOSE) ${statement}`)
    const facts = readPlan((explained as Array<Record<string, unknown>>)[0]?.['QUERY PLAN'])

    // The kind gate for writes. CTAS and SELECT INTO plan to a bare Result and
    // REFRESH answers "Utility Statement" — none of them has a ModifyTable root,
    // so requiring one refuses all three as well as a plain SELECT sent here by
    // mistake.
    assertIsModify(facts)
    await assertFunctionsSafe(tx, facts)
    await assertRelationsInScope(tx, facts, scope)

    const result = await unsafeSingle(tx, statement)
    const rows = result as unknown as Array<Record<string, unknown>> & { count: number, command: string }

    // A hard cap, not a report. Throwing here rolls the transaction back, so a
    // statement whose WHERE clause turned out to be wider than the caller
    // intended changes nothing at all — which is the only version of this cap
    // worth having.
    if (rows.count > options.maxRows) {
      throw createError({
        statusCode: 409,
        message: `That statement would have changed ${rows.count.toLocaleString('en-US')} rows but maxRows was ${options.maxRows}, so nothing was changed. `
          + 'Narrow the WHERE clause, or raise maxRows if that number is what you meant.',
      })
    }

    const returning = [...rows].slice(0, MAX_RETURNING_ROWS).map((row) => {
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(row)) out[key] = serialiseCell(value).value
      return out
    })

    return {
      command: rows.command,
      rowCount: rows.count,
      returning,
      returningTruncated: rows.length > MAX_RETURNING_ROWS,
      elapsedMs: Date.now() - startedAt,
    }
  })
}

/**
 * Make one cell safe to put in a JSON response.
 *
 * `bigint` becomes a string because JSON loses precision above 2^53 — silently,
 * which is the worst way to lose an id. A `Buffer` is described rather than
 * returned: a bytea column is not something a model can use and is very much
 * something that can exceed the response limit on its own.
 */
function serialiseCell(value: unknown): { value: unknown, truncated: boolean } {
  if (value === null || value === undefined) return { value: null, truncated: false }
  if (typeof value === 'bigint') return { value: value.toString(), truncated: false }
  if (value instanceof Date) return { value: value.toISOString(), truncated: false }
  if (Buffer.isBuffer(value)) return { value: { type: 'bytea', bytes: value.length }, truncated: false }

  if (typeof value === 'string') {
    if (value.length <= MAX_CELL_CHARS) return { value, truncated: false }
    return { value: `${value.slice(0, MAX_CELL_CHARS)}…`, truncated: true }
  }

  if (typeof value === 'object') {
    const json = JSON.stringify(value)
    if (json !== undefined && json.length > MAX_CELL_CHARS) {
      return { value: `${json.slice(0, MAX_CELL_CHARS)}…`, truncated: true }
    }
    return { value, truncated: false }
  }

  return { value, truncated: false }
}
