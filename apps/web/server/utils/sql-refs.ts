/**
 * Which functions, operators and type names a piece of SQL mentions, read by a
 * tokenizer that follows PostgreSQL's lexical rules — not by regex over raw
 * text. No imports, so test/pg-guard.test.mjs loads it in plain Node.
 * pg-guard.ts resolves what this returns against the catalog.
 *
 * Why a tokenizer: the function gate is the only thing between a scoped token
 * and a user-defined function that reads any table (the plan names no relation
 * for a call, and folds an IMMUTABLE one away entirely). Regexes missed every
 * spelling PostgreSQL accepts beyond `name(`: a quoted name (`"peek"(`,
 * `zz."peek"(`), a mixed-case one (`"Peek"(` — folding it found no function), a
 * comment before the parenthesis (`peek/**\/(`), an operator backed by a
 * function (`1 === 2`), a cast backed by one (`1::mytype`).
 *
 * Rules easy to undo:
 *
 * - **Names keep their exact case when quoted, fold to lower case when not** —
 *   PostgreSQL's own rule, and `pg_proc` stores the exact name.
 * - **Strings, dollar quotes and comments are skipped, never scanned.** A
 *   function name inside a string literal is not a call (a function that runs
 *   its text, like `query_to_xml`, is refused by name instead).
 * - **Over-collecting is free; missing is the bug.** Everything an identifier
 *   could be goes back; a name resolving to nothing in the catalog is dropped.
 * - **`U&"…" UESCAPE` is opaque** (`opaque: true`): the escape character is the
 *   statement's choice, and guessing it wrong would hide the name. The caller
 *   refuses such a statement rather than decode it.
 */

export interface SqlRefs {
  /** Called function names (`name(`, `schema.name(`), `OPERATOR(…)` excluded. */
  calls: string[]
  /** Operator symbols, including the one inside `OPERATOR(schema.op)`. */
  operators: string[]
  /** Every identifier, for matching type names a cast may name. */
  identifiers: string[]
  /** A construct this reader will not interpret; refuse the statement. */
  opaque: boolean
}

type Token =
  | { kind: 'ident', value: string, quoted: boolean }
  | { kind: 'op', value: string }
  | { kind: 'punct', value: string }

const OP_CHARS = '+-*/<>=~!@#%^&|`?'
/** Characters that let a multi-character operator end in `+` or `-` (PostgreSQL's lexer rule). */
const OP_TAIL_OK = '~!@#%^&|`?'

/** SQL keywords that read as calls because of a following parenthesis. Unquoted only. */
const NOT_CALLS = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'in', 'exists', 'case', 'when',
  'then', 'else', 'end', 'cast', 'values', 'array', 'row', 'any', 'all', 'some',
  'between', 'like', 'ilike', 'is', 'null', 'true', 'false', 'on', 'using',
  'distinct', 'order', 'group', 'by', 'having', 'limit', 'offset', 'as', 'union',
  'operator', 'over', 'filter', 'within', 'lateral', 'join', 'with', 'returning',
])

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch) || ch.charCodeAt(0) >= 0x80
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) >= 0x80
}

/** PostgreSQL folds unquoted identifiers to lower case, ASCII letters only. */
function fold(name: string): string {
  return name.replace(/[A-Z]/g, c => c.toLowerCase())
}

/** `U&"…"` body with the default `\` escape: `\XXXX`, `\+XXXXXX`, `\\`. */
function decodeUnicodeIdent(body: string): string | undefined {
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (ch !== '\\') {
      out += ch
      continue
    }
    if (body[i + 1] === '\\') {
      out += '\\'
      i++
    }
    else if (body[i + 1] === '+' && /^[0-9a-f]{6}$/i.test(body.slice(i + 2, i + 8))) {
      out += String.fromCodePoint(Number.parseInt(body.slice(i + 2, i + 8), 16))
      i += 7
    }
    else if (/^[0-9a-f]{4}$/i.test(body.slice(i + 1, i + 5))) {
      out += String.fromCodePoint(Number.parseInt(body.slice(i + 1, i + 5), 16))
      i += 4
    }
    else {
      return undefined
    }
  }
  return out
}

function tokenize(sql: string): { tokens: Token[], opaque: boolean } {
  const tokens: Token[] = []
  let opaque = false
  let i = 0
  const n = sql.length

  /** Index just past a `'…'` literal starting at `start`; `backslash` = E-string rules. */
  const skipString = (start: number, backslash: boolean): number => {
    let j = start + 1
    while (j < n) {
      const ch = sql[j]!
      if (backslash && ch === '\\') {
        j += 2
        continue
      }
      if (ch === '\'') {
        if (sql[j + 1] === '\'') {
          j += 2
          continue
        }
        return j + 1
      }
      j++
    }
    return n
  }

  /** Index just past a `"…"` identifier starting at `start`, and its body. */
  const readQuoted = (start: number): { end: number, body: string } => {
    let j = start + 1
    let body = ''
    while (j < n) {
      const ch = sql[j]!
      if (ch === '"') {
        if (sql[j + 1] === '"') {
          body += '"'
          j += 2
          continue
        }
        return { end: j + 1, body }
      }
      body += ch
      j++
    }
    return { end: n, body }
  }

  while (i < n) {
    const ch = sql[i]!
    const next = sql[i + 1]

    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '-' && next === '-') {
      const eol = sql.indexOf('\n', i)
      i = eol === -1 ? n : eol + 1
      continue
    }
    if (ch === '/' && next === '*') {
      // Block comments nest in PostgreSQL.
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        }
        else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        }
        else {
          i++
        }
      }
      continue
    }
    if (ch === '\'') {
      i = skipString(i, false)
      continue
    }
    // E'…', B'…', X'…', N'…' and U&'…' are all string literals.
    if (/[EeBbXxNn]/.test(ch) && next === '\'') {
      i = skipString(i + 1, ch === 'E' || ch === 'e')
      continue
    }
    if ((ch === 'U' || ch === 'u') && next === '&' && sql[i + 2] === '\'') {
      i = skipString(i + 2, false)
      continue
    }
    if ((ch === 'U' || ch === 'u') && next === '&' && sql[i + 2] === '"') {
      const { end, body } = readQuoted(i + 2)
      const decoded = decodeUnicodeIdent(body)
      if (decoded === undefined) opaque = true
      tokens.push({ kind: 'ident', value: decoded ?? body, quoted: true })
      i = end
      continue
    }
    if (ch === '"') {
      const { end, body } = readQuoted(i)
      tokens.push({ kind: 'ident', value: body, quoted: true })
      i = end
      continue
    }
    if (ch === '$') {
      // `$tag$ … $tag$` (tag empty or an identifier); `$1` is a parameter.
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length)
        i = close === -1 ? n : close + tag[0].length
        continue
      }
      i++
      while (i < n && /[0-9]/.test(sql[i]!)) i++
      continue
    }
    if (isIdentStart(ch)) {
      let j = i + 1
      while (j < n && isIdentPart(sql[j]!)) j++
      const word = fold(sql.slice(i, j))
      // `U&"…" UESCAPE 'c'` picks its own escape character; never guess it.
      if (word === 'uescape') opaque = true
      tokens.push({ kind: 'ident', value: word, quoted: false })
      i = j
      continue
    }
    if (/[0-9]/.test(ch) || (ch === '.' && next !== undefined && /[0-9]/.test(next))) {
      let j = i + 1
      while (j < n && /[0-9A-Za-z_.]/.test(sql[j]!)) j++
      i = j
      continue
    }
    if (ch === ':' && next === ':') {
      tokens.push({ kind: 'punct', value: '::' })
      i += 2
      continue
    }
    if (OP_CHARS.includes(ch)) {
      let j = i
      while (j < n && OP_CHARS.includes(sql[j]!)) {
        // A comment start ends the operator.
        if ((sql[j] === '-' && sql[j + 1] === '-') || (sql[j] === '/' && sql[j + 1] === '*')) break
        j++
      }
      let op = sql.slice(i, j)
      if (op.length > 1 && ![...op].some(c => OP_TAIL_OK.includes(c))) {
        while (op.length > 1 && (op.endsWith('+') || op.endsWith('-'))) op = op.slice(0, -1)
      }
      if (!op.length) {
        i++
        continue
      }
      tokens.push({ kind: 'op', value: op })
      i += op.length
      continue
    }
    tokens.push({ kind: 'punct', value: ch })
    i++
  }
  return { tokens, opaque }
}

/**
 * Functions, operators and identifiers `sql` mentions, appended to `into` when
 * given (the plan pass collects every expression into one set, linearly).
 * See the file header.
 */
export function sqlRefs(sql: string, into?: SqlRefs): SqlRefs {
  const { tokens, opaque } = tokenize(sql)
  const refs = into ?? { calls: [], operators: [], identifiers: [], opaque: false }
  const { calls, operators, identifiers } = refs
  if (opaque) refs.opaque = true

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.kind === 'op') {
      operators.push(token.value)
      continue
    }
    if (token.kind !== 'ident') continue
    identifiers.push(token.value)

    const next = tokens[i + 1]
    if (!(next?.kind === 'punct' && next.value === '(')) continue

    // OPERATOR(op) / OPERATOR(schema.op): the operator is what is called.
    if (!token.quoted && token.value === 'operator') {
      const inner = tokens.slice(i + 2, i + 6).find(t => t.kind === 'op')
      if (inner) operators.push(inner.value)
      continue
    }
    if (!token.quoted && NOT_CALLS.has(token.value)) continue
    // A qualifier (`zz.` in `zz.peek(`) changes nothing: names are resolved in
    // every schema, so the call is refused wherever it lives.
    calls.push(token.value)
  }

  return refs
}
