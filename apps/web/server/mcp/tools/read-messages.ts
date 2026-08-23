import { z } from 'zod'

/**
 * Read tool. Unlike list-chats this refuses loudly when the requested chat is out
 * of scope: returning an empty history would read as "this conversation is
 * empty", which is a different and wrong statement.
 */
export default defineMcpTool({
  name: 'read-messages',
  enabled: event => isToolAllowed(event, 'read-messages'),
  title: 'Read WhatsApp messages',
  description:
    'Read recent messages from one WhatsApp conversation, newest first. Takes the '
    + '`jid` returned by list-chats. Only messages recorded since the account was '
    + 'connected are available — existing WhatsApp history is not imported.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    jid: z.string().min(1).describe('Chat identifier from list-chats, e.g. 5511999999999@s.whatsapp.net'),
    limit: z.number().int().min(1).max(200).default(50).describe('How many messages to return'),
  },
  handler: async ({ jid, limit }) => {
    const { instance, scope } = useMcpAuth()

    assertChatAllowed(scope, jid)

    const messages = await listMessages(instance, jid, limit)
    return { jid, messages, count: messages.length }
  },
})
