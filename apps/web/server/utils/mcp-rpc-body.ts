/**
 * What a `/mcp` POST body asks for, as the rate limit counts it. No imports,
 * so it can be exercised in plain Node (test/mcp-rate-limit.test.mjs).
 *
 * Rules easy to undo:
 *
 * - **Always parsed, never decided by substring.** The body is already capped
 *   (2 MiB) and the SDK parses it anyway. A `raw.includes('tools/call')` gate
 *   was skipped by writing the method as `"tools\/call"` — valid JSON the SDK
 *   decodes and runs — so the call cost nothing.
 * - **Every JSON-RPC message counts**, not only `tools/call`: the SDK handles
 *   each element of an array (2025-03-26 batching), so a batch of a thousand
 *   `tools/list` is a thousand requests.
 * - Unparseable or empty = one message. The SDK answers it with its own error.
 */

/** One `tools/call` in a request body. */
export interface ToolCallInBody {
  name: string
  args: Record<string, unknown>
}

export interface RpcBody {
  /** JSON-RPC messages in the body: 1 for an object, the length of a batch, never 0. */
  messages: number
  /** The `tools/call` messages among them. */
  calls: ToolCallInBody[]
}

export function rpcBodyOf(raw: string | undefined): RpcBody {
  if (!raw) return { messages: 1, calls: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return { messages: 1, calls: [] }
  }
  const items = Array.isArray(parsed) ? parsed : [parsed]
  const calls: ToolCallInBody[] = []
  for (const message of items) {
    if (!message || typeof message !== 'object') continue
    const { method, params } = message as { method?: unknown, params?: unknown }
    if (method !== 'tools/call' || !params || typeof params !== 'object') continue
    const { name, arguments: args } = params as { name?: unknown, arguments?: unknown }
    if (typeof name !== 'string') continue
    calls.push({
      name,
      args: args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {},
    })
  }
  return { messages: Math.max(1, items.length), calls }
}
