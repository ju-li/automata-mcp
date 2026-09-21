import type { TransactionSql } from 'postgres'
import type { AppInstance } from './pocketbase'
import type { McpScope } from './mcp-scope'

/**
 * Running caller-supplied SQL.
 *
 * Everything a user's SQL touches goes through one of the two exported
 * functions here, and both compose the same checks in the same order because
 * both delegate to `withGuardedStatement` — which is where that order, and the
 * reasoning for it, lives. See `pg-guard.ts` for why each individual check
 * exists and what is still open.
 */

/**
 * What Postgres calls a binary column. The only per-engine part of
 * `db-rows.ts`; everything else about serialising a cell is shared, so the two
 * SQL tool sets cannot clip or lose precision differently.
 */
const PG_SERIALISE = { binaryLabel: 'bytea' } as const

/**
 * EXPLAIN the statement and read the facts the guards need.
 *
 * One place, so the awkward cast around the toolkit-shaped response exists once
 * — both run paths were carrying their own copy of it.
 */
async function planFacts(tx: TransactionSql, statement: string): Promise<PlanFacts> {
  const explained = await unsafeSingle(tx, `EXPLAIN (FORMAT JSON, VERBOSE) ${statement}`)
  return readPlan((explained as unknown as Array<Record<string, unknown>>)[0]?.['QUERY PLAN'])
}

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

/**
 * Open a transaction, apply every guard, then run the statement inside it.
 *
 * **The order below is the whole security argument, and it is here exactly once.**
 * Both entry points used to carry their own copy of it, kept in step by hand
 * while this module's header claimed they "compose the same checks in the same
 * order" — a claim a reader had to verify by diffing two functions. Now the only
 * thing either one chooses is the transaction mode and the statement-kind gate.
 *
 * **One transaction, not two.** The plan check and the execution share it, so
 * the `AccessShareLock` that EXPLAIN takes is still held while the statement
 * runs — which is what stops a concurrent `CREATE OR REPLACE VIEW` repointing a
 * view between the check and the execution — and both run under one
 * `SET LOCAL`, so the same text provably resolves to the same objects in both.
 */
async function withGuardedStatement<T>(
  instance: Pick<AppInstance, 'id' | 'dsn'>,
  scope: McpScope,
  statement: string,
  options: {
    /** `sql.begin('read only')`. A `CREATE TEMP TABLE` inside it fails 25006. */
    readOnly: boolean
    timeoutMs: number
    /** `assertNoWrites` or `assertIsModify` — the only difference between the two callers. */
    assertKind: (facts: PlanFacts) => void
  },
  body: (tx: TransactionSql, startedAt: number) => Promise<T>,
): Promise<T> {
  const sql = await pgFor(instance)
  const startedAt = Date.now()

  const guarded = async (tx: TransactionSql): Promise<T> => {
    await applySessionGuards(tx, scope, options.timeoutMs)

    // Before the EXPLAIN, not after: Postgres folds an IMMUTABLE function with
    // constant arguments *during* planning, so a plan that came back has already
    // run it and no longer names it. See `functionNamesInText`.
    await assertFunctionsSafe(tx, functionNamesInText(statement))

    const facts = await planFacts(tx, statement)

    options.assertKind(facts)
    // Again from the plan, which catches what the text cannot — a function
    // reached through a view.
    await assertFunctionsSafe(tx, facts.functions)
    await assertRelationsInScope(tx, facts, scope)

    return await body(tx, startedAt)
  }

  return options.readOnly
    ? await sql.begin('read only', guarded) as T
    : await sql.begin(guarded) as T
}

export async function runReadQuery(
  instance: Pick<AppInstance, 'id' | 'dsn'>,
  scope: McpScope,
  statement: string,
  options: ReadQueryOptions,
): Promise<ReadQueryResult> {
  return await withGuardedStatement(instance, scope, statement, {
    readOnly: true,
    timeoutMs: options.timeoutMs,
    assertKind: assertNoWrites,
  }, async (tx, startedAt) => {
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

    const { rows, truncatedValues } = serialiseRows(kept, PG_SERIALISE)

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
  /** Cells clipped at the length cap, so a shortened value is never silent. */
  truncatedValues: number
  elapsedMs: number
}

export async function runWriteStatement(
  instance: Pick<AppInstance, 'id' | 'dsn'>,
  scope: McpScope,
  statement: string,
  options: { maxRows: number, timeoutMs: number, allowWholeTable?: boolean },
): Promise<WriteStatementResult> {
  return await withGuardedStatement(instance, scope, statement, {
    readOnly: false,
    timeoutMs: options.timeoutMs,
    // The kind gate for writes. CTAS and SELECT INTO plan to a bare Result and
    // REFRESH answers "Utility Statement" — none of them has a ModifyTable root,
    // so requiring one refuses all three as well as a plain SELECT sent here by
    // mistake.
    assertKind: facts => assertIsModify(facts, options.allowWholeTable),
  }, async (tx, startedAt) => {
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

    const serialised = serialiseRows([...rows].slice(0, MAX_RETURNING_ROWS), PG_SERIALISE)

    return {
      command: rows.command,
      rowCount: rows.count,
      returning: serialised.rows,
      truncatedValues: serialised.truncatedValues,
      returningTruncated: rows.length > MAX_RETURNING_ROWS,
      elapsedMs: Date.now() - startedAt,
    }
  })
}

