import type { ZodRawShape } from 'zod'
import type { InstanceKind } from './mcp-scope'

/**
 * The toolkit's tool definition, taken from `defineMcpTool` itself rather than
 * imported: the type lives at a deep path that is not in the package's
 * `exports` map, and naming that path here would be a second fragile dependency
 * on the toolkit's internal layout (see `modules/mcp-token-route.ts`).
 */
type ToolDefinition<I extends ZodRawShape | undefined, O extends ZodRawShape>
  = Parameters<typeof defineMcpTool<I, O>>[0]

/**
 * Define an MCP tool that belongs to one kind of connection.
 *
 * **Why this exists rather than three separate declarations.** A tool's kind was
 * being asserted three times per file — by the directory it sits in, by an
 * explicit `group`, and by the third argument to `isToolAllowed` — kept in step
 * by a comment. Only the third one enforces anything, and forgetting it is not a
 * cosmetic slip: a Postgres token minted with `all_tools` would register
 * `send-text-message`, whose handler calls `useEvolutionClient()` on a row that
 * has no Evolution credentials. Declaring the kind once makes the mismatch
 * unrepresentable.
 *
 * `available` is the second half of the old `enabled` expression, kept for the
 * one tool that has a prerequisite beyond its kind. It takes no event because a
 * prerequisite is a property of the deployment, not of the caller.
 */
export function defineKindTool<
  const InputSchema extends ZodRawShape | undefined = ZodRawShape,
  const OutputSchema extends ZodRawShape = ZodRawShape,
>(
  definition: ToolDefinition<InputSchema, OutputSchema> & {
    name: string
    kind: InstanceKind
    available?: () => boolean
  },
): ToolDefinition<InputSchema, OutputSchema> {
  const { kind, available, ...rest } = definition

  return defineMcpTool<InputSchema, OutputSchema>({
    ...rest,
    // Inferred from the directory too; stated so a move cannot silently change
    // which connections the tool belongs to.
    group: kind,
    // Two gates, both fail closed — see `isToolAllowed`. Kept synchronous: the
    // toolkit evaluates `enabled` twice per request per tool.
    enabled: event => isToolAllowed(event, rest.name, kind) && (available?.() ?? true),
  })
}
