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
export type InstanceKind = 'whatsapp' | 'postgres'

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
