/// <reference path="../pb_data/types.d.ts" />

// Auth schema for the MCP surface.
//
//   users        gains the per-user Evolution credentials (server-read only)
//   mcp_tokens   holds hashed, app-minted bearer tokens that resolve to a user
//
// The token stored here is NOT Evolution's `apikey`. Evolution's key lives on the
// user record and never leaves the server; the MCP token is minted by this app,
// shown to the user exactly once, and only ever persisted as a SHA-256 hash.

migrate((app) => {
  // ── users: per-user Evolution credentials ────────────────────────────────
  const users = app.findCollectionByNameOrId('users')

  users.fields.add(new URLField({
    name: 'evolution_url',
    required: false,
    // Local dev points at http://localhost:8080, so the loopback guard is off.
    exceptDomains: null,
    onlyDomains: null,
  }))

  users.fields.add(new TextField({
    name: 'evolution_api_key',
    required: false,
    max: 255,
    // Never serialised by the REST API, even to the owning user. Readable only
    // through a superuser-authenticated server-side client.
    hidden: true,
  }))

  // A user may read and update only their own record.
  users.listRule = 'id = @request.auth.id'
  users.viewRule = 'id = @request.auth.id'
  users.updateRule = 'id = @request.auth.id'

  app.save(users)

  // ── mcp_tokens ───────────────────────────────────────────────────────────
  const tokens = new Collection({
    type: 'base',
    name: 'mcp_tokens',

    // All rules null = superuser-only. Tokens are unreachable from the client
    // SDK by any path; the Nuxt server brokers every read and write.
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
  })

  // Fields must be attached via `fields.add()`. Passing them in the Collection
  // constructor silently produces a collection with no fields — the constructor
  // unmarshals a plain JSON object and drops Field instances on the floor.
  tokens.fields.add(new RelationField({
    name: 'user',
    required: true,
    collectionId: users.id,
    cascadeDelete: true,
    maxSelect: 1,
  }))
  tokens.fields.add(new TextField({
    name: 'token_hash',
    required: true,
    min: 64,
    max: 64, // SHA-256, lowercase hex
  }))
  tokens.fields.add(new TextField({
    name: 'label',
    required: false,
    max: 100,
  }))
  tokens.fields.add(new DateField({
    name: 'last_used_at',
    required: false,
  }))
  tokens.fields.add(new DateField({
    // Empty means the token never expires.
    name: 'expires_at',
    required: false,
  }))
  tokens.fields.add(new BoolField({
    name: 'revoked',
    required: false,
  }))
  tokens.fields.add(new AutodateField({
    name: 'created',
    onCreate: true,
    onUpdate: false,
  }))
  tokens.fields.add(new AutodateField({
    name: 'updated',
    onCreate: true,
    onUpdate: true,
  }))

  tokens.indexes = [
    // Unique: token lookup is an exact match on the hash, so no scan and no
    // timing-sensitive comparison in application code.
    'CREATE UNIQUE INDEX `idx_mcp_tokens_token_hash` ON `mcp_tokens` (`token_hash`)',
    'CREATE INDEX `idx_mcp_tokens_user` ON `mcp_tokens` (`user`)',
  ]

  app.save(tokens)
}, (app) => {
  // ── down ─────────────────────────────────────────────────────────────────
  try {
    app.delete(app.findCollectionByNameOrId('mcp_tokens'))
  } catch {
    // already gone
  }

  const users = app.findCollectionByNameOrId('users')
  users.fields.removeByName('evolution_url')
  users.fields.removeByName('evolution_api_key')
  users.listRule = null
  users.viewRule = null
  users.updateRule = null
  app.save(users)
})
