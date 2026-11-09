/**
 * Daily: delete recorded tool calls older than their retention (30 days). The
 * reasons in them are model-written and can quote what users asked about, so
 * they are not kept longer than the activity view needs. See
 * server/utils/tool-calls.ts.
 *
 * Safe on several replicas: a second run finds nothing left to delete.
 */
export default defineTask({
  meta: {
    name: 'mcp:prune-tool-calls',
    description: 'Delete recorded MCP tool calls past their retention',
  },
  async run() {
    const deleted = await pruneToolCalls()
    if (deleted) console.info(`[tool-calls] deleted ${deleted} call(s) past retention`)
    return { result: { deleted } }
  },
})
