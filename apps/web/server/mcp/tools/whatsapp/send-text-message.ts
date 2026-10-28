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
export default defineKindTool({
  name: 'send-text-message',
  kind: 'whatsapp',
  title: 'Send WhatsApp message',
  description:
    'Send a plain-text WhatsApp message from the connected account. The account '
    + 'must be in the `open` state — check with get-connection-status first. '
    + 'Messages cannot be unsent once delivered. The account owner may have set a '
    + 'disclaimer line that is appended to every message automatically; when one was, '
    + 'the response names it in `disclaimerAppended`. Do not add a sign-off of your own.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    number: z.string().min(1).describe('Recipient in international format without "+", e.g. 5511999999999'),
    text: z.string().min(1).describe('Message body'),
  },
  handler: async ({ number, text }) => {
    const { instance, scope, sendDisclaimer } = useMcpAuth()

    // Resolves the number through Evolution and compares exact JIDs. Fails
    // closed — an unverifiable recipient is refused, not sent to. No-op when
    // the token is not chat-scoped.
    await assertNumberAllowed(instance, scope, number)

    const evolution = useEvolutionClient()
    const result = await evolution<Record<string, unknown>>(`/message/sendText/${encodeURIComponent(instance.name)}`, {
      method: 'POST',
      body: { number, text: withSendDisclaimer(text, sendDisclaimer) },
    })
    return sendDisclaimer ? { ...result, disclaimerAppended: sendDisclaimer } : result
  },
})
