/// <reference path="../pb_data/types.d.ts" />

// Move Evolution credentials off the user record.
//
// A user can connect several WhatsApp accounts, so the per-instance Evolution
// token cannot live on `users`. It moves to an `instances` collection, and an
// MCP token now binds to one instance rather than to a user — which mirrors
// Evolution's own model, where a token scopes to exactly one instance.

migrate((app) => {
  const users = app.findCollectionByNameOrId('users')

  // ── instances ────────────────────────────────────────────────────────────
  const instances = new Collection({
    type: 'base',
    name: 'instances',

    // Superuser-only, like mcp_tokens. The browser never talks to PocketBase;
    // the Nuxt server brokers every read and write.
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
  })

  // Fields go on with fields.add(). Passing them to the Collection constructor
  // silently yields a collection with no fields — the constructor unmarshals a
  // plain JSON object and drops Field instances.
  instances.fields.add(new RelationField({
    name: 'user',
    required: true,
    collectionId: users.id,
    cascadeDelete: true,
    maxSelect: 1,
  }))
  instances.fields.add(new TextField({
    // Evolution instance name. Server-generated, never user-supplied.
    name: 'name',
    required: true,
    max: 64,
  }))
  instances.fields.add(new TextField({
    // Evolution's own instanceId UUID. Kept for support and debugging.
    name: 'instance_id',
    required: false,
    max: 64,
  }))
  instances.fields.add(new TextField({
    // Per-instance Evolution token, returned by POST /instance/create as `hash`.
    // NOT the global admin key — that never reaches a user-facing record.
    name: 'api_key',
    required: false,
    max: 255,
    hidden: true,
  }))
  instances.fields.add(new URLField({
    name: 'base_url',
    required: false,
    exceptDomains: null,
    onlyDomains: null,
  }))
  instances.fields.add(new TextField({
    // User-facing nickname: "Work", "Personal".
    name: 'label',
    required: false,
    max: 100,
  }))
  instances.fields.add(new AutodateField({
    name: 'created',
    onCreate: true,
    onUpdate: false,
  }))
  instances.fields.add(new AutodateField({
    name: 'updated',
    onCreate: true,
    onUpdate: true,
  }))

  instances.indexes = [
    'CREATE UNIQUE INDEX `idx_instances_name` ON `instances` (`name`)',
    'CREATE INDEX `idx_instances_user` ON `instances` (`user`)',
  ]

  app.save(instances)

  // ── mcp_tokens.instance ──────────────────────────────────────────────────
  const tokens = app.findCollectionByNameOrId('mcp_tokens')

  tokens.fields.add(new RelationField({
    name: 'instance',
    required: true,
    collectionId: instances.id,
    cascadeDelete: true,
    maxSelect: 1,
  }))

  app.save(tokens)

  // ── carry existing credentials across ────────────────────────────────────
  // There are no rows today, but a migration that only works on an empty
  // database is a migration that fails the one time it matters.
  const existing = app.findAllRecords('users')

  for (const user of existing) {
    const key = user.get('evolution_api_key')
    if (!key) continue

    const instance = new Record(instances)
    instance.set('user', user.id)
    instance.set('name', `i-${user.id}`)
    instance.set('api_key', key)
    instance.set('base_url', user.get('evolution_url') || '')
    instance.set('label', 'Imported')
    app.save(instance)

    for (const token of app.findAllRecords('mcp_tokens', $dbx.exp('user = {:u}', { u: user.id }))) {
      token.set('instance', instance.id)
      app.save(token)
    }
  }

  // Any token that could not be attached to an instance can never authenticate
  // — resolveMcpAuth has no instance to read credentials from. Drop them rather
  // than leave rows that look valid in the UI.
  for (const token of app.findAllRecords('mcp_tokens')) {
    if (!token.get('instance')) app.delete(token)
  }

  // ── drop the moved fields ────────────────────────────────────────────────
  const usersAgain = app.findCollectionByNameOrId('users')
  usersAgain.fields.removeByName('evolution_url')
  usersAgain.fields.removeByName('evolution_api_key')
  app.save(usersAgain)
}, (app) => {
  // ── down ─────────────────────────────────────────────────────────────────
  const users = app.findCollectionByNameOrId('users')

  users.fields.add(new URLField({
    name: 'evolution_url',
    required: false,
    exceptDomains: null,
    onlyDomains: null,
  }))
  users.fields.add(new TextField({
    name: 'evolution_api_key',
    required: false,
    max: 255,
    hidden: true,
  }))
  app.save(users)

  // Fold the first instance of each user back onto the user record.
  for (const instance of app.findAllRecords('instances')) {
    const user = app.findRecordById('users', instance.get('user'))
    if (user && !user.get('evolution_api_key')) {
      user.set('evolution_api_key', instance.get('api_key'))
      user.set('evolution_url', instance.get('base_url'))
      app.save(user)
    }
  }

  const tokens = app.findCollectionByNameOrId('mcp_tokens')
  tokens.fields.removeByName('instance')
  app.save(tokens)

  app.delete(app.findCollectionByNameOrId('instances'))
})
