import { z } from 'zod'

/**
 * Example WRITE tool.
 *
 * On the hints: `destructiveHint` is false because sending adds a message rather
 * than destroying existing state — that is the MCP definition, not a judgement
 * about how consequential the call is. A tool that ends a paired session
 * (`/instance/logout/{instance}`, which forces a fresh QR scan) is what
 * `destructiveHint: true` is for. `idempotentHint` is false: calling this twice
 * sends two messages.
 */
export default defineMcpTool({
  title: 'Send WhatsApp message',
  description:
    'Send a plain-text WhatsApp message from one of the user\'s instances. The '
    + 'instance must be in the `open` state — check with list-instances first. '
    + 'Messages cannot be unsent once delivered.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    instance: z.string().min(1).describe('Instance name, as returned by list-instances'),
    number: z.string().min(1).describe('Recipient in international format without "+", e.g. 5511999999999'),
    text: z.string().min(1).describe('Message body'),
  },
  handler: async ({ instance, number, text }) => {
    const evolution = useEvolutionClient()
    return await evolution(`/message/sendText/${encodeURIComponent(instance)}`, {
      method: 'POST',
      body: { number, text },
    })
  },
})
