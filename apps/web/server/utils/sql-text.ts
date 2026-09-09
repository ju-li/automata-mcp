/**
 * Text handling shared by every module that builds SQL, so the two databases
 * this app talks to cannot disagree about it.
 */

/**
 * `%` and `_` are wildcards to LIKE/ILIKE, so a search for "50%" would otherwise
 * match anything starting "50". Backslash is the default escape character, and
 * has to be escaped first or it would escape the escapes.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&')
}
