/**
 * Turning database rows into something safe to put in a JSON response.
 *
 * **Engine-independent on purpose.** Two tools with the same name — `run-query`
 * on Postgres and `run-query` on another SQL engine — must clip at the same
 * length, report truncation the same way, and lose precision in the same
 * places, or a caller reading one response cannot trust what it learned from
 * the other. That is the same argument `pg-catalog.ts`'s header makes about the
 * scope picker and the tool listing sharing one query: two things that could
 * disagree eventually will.
 *
 * Only the *label* for binary data is per-engine, because the honest name for
 * the type differs (`bytea`, `blob`). Everything else is shared.
 */

/** How much of one cell is ever returned. A bytea column would otherwise blow the response. */
export const MAX_CELL_CHARS = 2000

/** How many RETURNING rows a write reports. */
export const MAX_RETURNING_ROWS = 100

export interface SerialiseOptions {
  /** What this engine calls a binary column, for the placeholder object. */
  binaryLabel: string
}

/**
 * Serialise every cell of every row, counting what had to be clipped.
 *
 * Shared so the write path reports truncation too: it used to re-implement the
 * loop without the counter, so a clipped RETURNING value came back silently.
 */
export function serialiseRows(
  rows: Array<Record<string, unknown>>,
  options: SerialiseOptions,
): { rows: Array<Record<string, unknown>>, truncatedValues: number } {
  let truncatedValues = 0
  const out = rows.map((row) => {
    const serialised: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row)) {
      const cell = serialiseCell(value, options)
      if (cell.truncated) truncatedValues += 1
      serialised[key] = cell.value
    }
    return serialised
  })
  return { rows: out, truncatedValues }
}

/**
 * Make one cell safe to put in a JSON response.
 *
 * `bigint` becomes a string because JSON loses precision above 2^53 —
 * silently, which is the worst way to lose an id. A `Buffer` is described
 * rather than returned: a binary column is not something a model can use and is
 * very much something that can exceed the response limit on its own.
 *
 * **A driver that hands back a rounded number instead of a `bigint` defeats
 * this, and the fix belongs at the driver, not here.** postgres.js returns
 * `bigint`; a driver that does not must be configured to return a string before
 * its rows reach this function, because by the time a value arrives as a
 * `number` the precision is already gone and nothing here can tell.
 */
export function serialiseCell(
  value: unknown,
  options: SerialiseOptions,
): { value: unknown, truncated: boolean } {
  if (value === null || value === undefined) return { value: null, truncated: false }
  if (typeof value === 'bigint') return { value: value.toString(), truncated: false }
  if (value instanceof Date) return { value: value.toISOString(), truncated: false }
  if (Buffer.isBuffer(value)) {
    return { value: { type: options.binaryLabel, bytes: value.length }, truncated: false }
  }

  if (typeof value === 'string') {
    if (value.length <= MAX_CELL_CHARS) return { value, truncated: false }
    return { value: `${value.slice(0, MAX_CELL_CHARS)}…`, truncated: true }
  }

  if (typeof value === 'object') {
    // Stringified only to measure it. The object itself is returned so a jsonb
    // column reaches the caller as JSON rather than as an escaped string, which
    // does mean Nitro serialises it again on the way out — a deliberate trade,
    // since a model reading `"{\"a\":1}"` is worse off than one reading `{a:1}`.
    const json = JSON.stringify(value)
    if (json === undefined) return { value: null, truncated: false }
    return json.length > MAX_CELL_CHARS
      ? { value: `${json.slice(0, MAX_CELL_CHARS)}…`, truncated: true }
      : { value, truncated: false }
  }

  return { value, truncated: false }
}
