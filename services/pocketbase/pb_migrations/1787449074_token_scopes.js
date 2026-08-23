/// <reference path="../pb_data/types.d.ts" />

// Scope a connector token to specific chats and specific tools.
//
// Two independent axes, each with an "everything" escape hatch:
//
//   all_chats=true   -> chat_jids ignored, token reaches every conversation
//   all_tools=true   -> tool_names ignored, token may call every tool
//
// Both default to true, and existing rows are backfilled to true, so a token
// minted before this migration keeps behaving exactly as it did.
//
// A token scoped to specific tools does NOT gain tools added later — its
// tool_names simply will not contain them. Deny by default is the safe
// direction and means adding a tool needs no migration.

migrate((app) => {
  const tokens = app.findCollectionByNameOrId('mcp_tokens')

  tokens.fields.add(new BoolField({
    name: 'all_chats',
    required: false,
  }))
  tokens.fields.add(new JSONField({
    // Exact JIDs as Evolution reports them: 5511999999999@s.whatsapp.net or
    // 1234567890-1234567890@g.us. Never normalised by this app — see
    // server/utils/mcp-scope.ts for why.
    name: 'chat_jids',
    required: false,
    maxSize: 100000,
  }))
  tokens.fields.add(new BoolField({
    name: 'all_tools',
    required: false,
  }))
  tokens.fields.add(new JSONField({
    // Exact MCP tool names, e.g. "send-text-message".
    name: 'tool_names',
    required: false,
    maxSize: 100000,
  }))

  app.save(tokens)

  // Backfill. A bool field that is absent reads as false, which would silently
  // strip every existing token of all access.
  for (const token of app.findAllRecords('mcp_tokens')) {
    token.set('all_chats', true)
    token.set('all_tools', true)
    token.set('chat_jids', [])
    token.set('tool_names', [])
    app.save(token)
  }
}, (app) => {
  const tokens = app.findCollectionByNameOrId('mcp_tokens')
  tokens.fields.removeByName('all_chats')
  tokens.fields.removeByName('chat_jids')
  tokens.fields.removeByName('all_tools')
  tokens.fields.removeByName('tool_names')
  app.save(tokens)
})
