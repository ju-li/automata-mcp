import { z } from 'zod'
import type { AppInstance } from '~~/server/utils/pocketbase'
import type { MessageSearchHit } from '~~/server/utils/evolution-db'

/**
 * Search tool. Unlike `read-messages` it defaults to every chat the token can
 * see, so the scope check has two halves: a named chat is asserted (and refused
 * loudly, as there), while an unscoped search is narrowed to the token's chats
 * *in the SQL* rather than by filtering what comes back.
 *
 * Not registered at all when search is unconfigured — see `evolution-db.ts` for
 * why this reaches Evolution's database instead of its API.
 */
export default defineMcpTool({
  name: 'search-messages',
  enabled: event => isToolAllowed(event, 'search-messages') && messageSearchConfigured(),
  title: 'Search WhatsApp messages',
  description:
    'Find WhatsApp messages containing given words, newest first, across every '
    + 'chat unless a `jid` narrows it to one. Matching is case-insensitive and '
    + 'every word must appear in the same message. Only messages recorded since '
    + 'the account was connected are searchable — existing WhatsApp history is '
    + 'not imported.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    query: z.string().min(2).describe('Words to look for. All of them must appear in the message.'),
    jid: z.string().optional().describe('Restrict to one chat, using a `jid` from list-chats. Omit to search every chat.'),
    after: z.string().optional().describe('ISO-8601 date; only messages sent at or after it, e.g. 2026-08-01'),
    before: z.string().optional().describe('ISO-8601 date; only messages sent at or before it'),
    fromMe: z.boolean().optional().describe('true for only messages you sent, false for only messages you received'),
    limit: z.number().int().min(1).max(100).default(20).describe('How many matches to return'),
  },
  handler: async ({ query, jid, after, before, fromMe, limit }) => {
    const { instance, scope } = useMcpAuth()

    const terms = query.split(/\s+/).filter(Boolean)
    if (!terms.length) {
      throw createError({ statusCode: 400, message: '`query` needs at least one word to search for.' })
    }

    if (jid) assertChatAllowed(scope, jid)

    const { hits, truncated } = await searchMessages(instance, {
      terms,
      jid,
      // A named chat is already checked above. Otherwise a scoped token gets its
      // allowlist pushed into the query, so out-of-scope messages are never read.
      allowedJids: jid || scope.allChats ? undefined : scope.chatJids,
      after,
      before,
      fromMe,
      limit,
    })

    const names = await chatNames(instance, hits)

    return {
      query,
      matches: hits.map(hit => ({ ...hit, chatName: names.get(hit.jid) })),
      count: hits.length,
      // Say so rather than presenting a capped page as the whole answer.
      truncated,
    }
  },
})

/**
 * Label the chats a search landed in.
 *
 * Reuses `listChats` rather than deriving names in SQL: naming is not obvious
 * here (see the `EvolutionChatRow` note in `chats.ts` — 2.3.7 aliases two
 * different columns as `pushName`, so names come from the contact table and the
 * group listing instead), and one source of naming rules is worth the round trip.
 *
 * Best effort. The group listing behind it can time out on a disconnected
 * account, and a result labelled with bare JIDs beats no result at all.
 */
async function chatNames(instance: AppInstance, hits: MessageSearchHit[]): Promise<Map<string, string>> {
  const wanted = new Set(hits.map(hit => hit.jid))
  if (!wanted.size) return new Map()

  try {
    const chats = await listChats(instance)
    return new Map(chats.filter(chat => wanted.has(chat.jid)).map(chat => [chat.jid, chat.name]))
  }
  catch (error) {
    console.error('[search] could not label chats:', error)
    return new Map()
  }
}
