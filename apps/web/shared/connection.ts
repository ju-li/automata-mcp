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
