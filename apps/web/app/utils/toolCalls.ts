/**
 * One recorded MCP tool call, as the activity dialog receives it — mirrors
 * `PublicToolCall` in server/utils/tool-calls.ts.
 *
 * `reason` is written by the model and can be steered by whatever it read, so
 * render it as text (Vue's interpolation escapes it), never as HTML, and never
 * present it as the user's own words.
 */
export interface ToolCall {
  id: string
  tool: string
  ok: boolean
  reason?: string
  userAgent?: string
  at: string
}

export interface ToolCallPage {
  calls: ToolCall[]
  hasMore: boolean
  page: number
  toolCalls: { recording: boolean, required: boolean }
}
