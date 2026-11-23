import { z } from 'zod'

/**
 * Write tool: one image, optional caption. Same recipient rules and checks as
 * `send-text-message` (LID guard first, then scope, then send; see there), and
 * its own tool rather than an option on that one, so a token scoped to text
 * sends does not silently gain images.
 *
 * The image reaches Evolution as base64 we fetched and checked
 * (`loadSendImage`, send-image.ts) — never as a URL Evolution would download
 * from inside our network. The fork converts every image to JPEG with sharp;
 * stock 2.3.7 sends the bytes as given, which is why only JPEG and PNG are
 * accepted.
 *
 * `expensive`: each call moves up to 5 MB through Evolution to WhatsApp, so it
 * shares the per-connection budget searches use.
 */
export default defineKindTool({
  name: 'send-whatsapp-image',
  kind: 'whatsapp',
  title: 'Send WhatsApp image',
  expensive: true,
  description:
    'Send one image (JPEG or PNG, at most 5 MB) from the connected WhatsApp account, with an '
    + 'optional caption. Pass the image as `imageUrl` (a public link this server downloads) or as '
    + '`imageBase64` — exactly one. Recipient rules are those of send-text-message: to reply in an '
    + 'existing conversation, pass its `jid` from list-chats or read-messages as `number`, exactly '
    + 'as returned; never strip an `@lid` suffix or send to its digits alone. The account must be '
    + 'in the `open` state — check with get-connection-status first. Messages cannot be unsent once '
    + 'delivered. The account owner may have set a disclaimer line that is appended to every caption '
    + 'automatically; when one was, the response names it in `disclaimerAppended`.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: {
    number: z.string().min(1).describe(
      'Recipient: a chat\'s full jid exactly as list-chats or read-messages return it, or, for '
      + 'someone with no existing chat, a phone number in international format — country code '
      + 'included, digits only, e.g. 5511999999999',
    ),
    ...sendImageInputSchema,
    caption: z.string().max(4096).optional().describe('Text shown under the image'),
  },
  handler: async ({ number, imageUrl, imageBase64, caption }) => {
    const { instance, scope, sendDisclaimer } = useMcpAuth()

    // Recipient checks before the download: a refused recipient costs no fetch.
    await assertNotBareLid(instance, number)
    await assertNumberAllowed(instance, scope, number)

    const image = await loadSendImage({ imageUrl, imageBase64 })
    const text = captionWithDisclaimer(caption, sendDisclaimer)

    const evolution = useEvolutionClient()
    let result: Record<string, unknown>
    try {
      result = await evolution<Record<string, unknown>>(`/message/sendMedia/${encodeURIComponent(instance.name)}`, {
        method: 'POST',
        body: {
          number,
          mediatype: 'image',
          mimetype: image.mimeType,
          media: image.bytes.toString('base64'),
          fileName: `image.${image.extension}`,
          ...(text && { caption: text }),
        },
        // Upload to WhatsApp included; the default 30 s is sized for text.
        timeout: 90_000,
      })
    }
    catch (error) {
      relayEvolutionSendError(error, number, instance.id)
    }
    // Same receipt read-back as text sends (#239): a 200 means queued.
    watchSendAck(instance, result)
    return sendDisclaimer ? { ...result, disclaimerAppended: sendDisclaimer } : result
  },
})
