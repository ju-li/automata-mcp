/**
 * The two vocabularies both surfaces have to agree on, letter for letter.
 *
 * Each of these was declared twice — once in `server/utils/`, once in an
 * `app/composables/` file — with identical members. Two copies of a string
 * union do not fail to compile when they drift; they just stop describing the
 * same set, and the mismatch surfaces as a badge that renders nothing or a
 * branch that is never taken. `shared/` is reachable from the app, the server
 * and the shared context alike, so there is no longer a reason for a second
 * copy to exist.
 *
 * Only the unions live here. The *record* shapes stay deliberately separate:
 * `PublicInstance` is what the server projects and `PublicInstanceRow` is what
 * the UI consumes, and they are allowed to differ.
 */

/**
 * What a connection is. One `instances` row is one of these, and a connector
 * token reaches exactly one row — so this also decides which tools exist for a
 * given token.
 *
 * Read a row's kind through `instanceKind()` in `server/utils/mcp-scope.ts`,
 * never off the record: PocketBase materialises an unset SelectField as `''`.
 */
export type InstanceKind = 'whatsapp' | 'postgres' | 'telegram'

/**
 * What sort of thing a kind is.
 *
 * Several branches in both surfaces are not really per-kind at all — they are
 * per-family. `describeKind()` answers "database" for every SQL engine;
 * `describeScope()` picks the table axis or the chat axis; `TokenScopeFields`
 * and `McpTokens` decide which axis to fetch. Written as a kind check, each of
 * those is a boolean that a new kind silently falls off the wrong side of
 * (`kind === 'postgres'` is `false` for MySQL, so the scope dialog would ask a
 * database for its chats). Written as a family check, they keep working.
 *
 * Deliberately a `switch` over the kind rather than a lookup table, for the
 * reason `assertNever` exists: a new kind must fail to compile here until
 * somebody has decided which family it joins. That decision is exactly the one
 * that then answers four call sites at once.
 */
export type ConnectionFamily = 'messaging' | 'database'

export function connectionFamily(kind: InstanceKind): ConnectionFamily {
  switch (kind) {
    case 'whatsapp':
    case 'telegram':
      return 'messaging'
    case 'postgres':
      return 'database'
    default:
      return assertNever(kind, 'connection kind')
  }
}

/**
 * How a connection is doing, in four values that mean the same thing for every
 * kind so a badge needs no branching: a database that answers is `open`, one
 * that does not is `close`, and a row with no credential at all is `unknown`.
 *
 * The *words shown to a person* are kind-specific and are not here — see
 * `describeState()` in `app/composables/useConnectionState.ts`, where "close"
 * becomes "not paired" for WhatsApp and "unreachable" for a database.
 */
export type ConnectionState = 'open' | 'connecting' | 'close' | 'unknown'

/**
 * The `default` arm of every switch over a union declared here.
 *
 * Every per-kind branch in both surfaces is a `switch` that ends in this, never
 * an `if (kind === 'postgres') … else …`. The `else` form compiles unchanged when
 * a kind is added and quietly sends the new kind down whichever branch was last —
 * which, for most of this codebase's history, was the Evolution one. With this,
 * adding a member to `InstanceKind` fails to compile at every branch that has
 * not decided what the new kind does.
 */
export function assertNever(value: never, what = 'value'): never {
  throw new Error(`Unhandled ${what}: ${JSON.stringify(value)}`)
}
