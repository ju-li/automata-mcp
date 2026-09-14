/// <reference path="../pb_data/types.d.ts" />

// Telegram as a third connection kind.
//
// A telegram row is a session on a Telegram bridge (apps/telegram-bridge). It
// reuses the fields an Evolution row already has, with the same meanings:
//
//   base_url     the bridge
//   api_key      the per-session bearer key the bridge issued (hidden)
//   instance_id  the bridge's session id
//   admin_key    a bring-your-own bridge's global key (hidden)
//
// One field is new, `telegram_db_url` (hidden): a read-only URL for a
// bring-your-own bridge's own database, where that connection's synced chats
// live. Empty means "use NUXT_TELEGRAM_DATABASE_URL, if this connection is on the
// deployment's bridge" — the same precedence `evolution_db_url` follows. A
// separate field rather than reusing `evolution_db_url`, because that one is
// read unconditionally as Evolution's database.
//
// `hidden` keeps a field out of the REST projection, including from the owning
// user. It is NOT encryption: it sits in clear in pb_data and in every backup.
//
// No backfill: nothing holds this kind yet.

migrate((app) => {
  const instances = app.findCollectionByNameOrId('instances')

  const kind = instances.fields.getByName('kind')
  const values = Array.from(kind.values)
  if (!values.includes('telegram')) {
    values.push('telegram')
    kind.values = values
  }

  instances.fields.add(new TextField({
    name: 'telegram_db_url',
    required: false,
    max: 2000,
    hidden: true,
  }))

  app.save(instances)
}, (app) => {
  // A select value cannot be removed while rows still hold it. Their connector
  // tokens cascade with them.
  for (const record of app.findRecordsByFilter('instances', "kind = 'telegram'", '', 0, 0)) {
    app.delete(record)
  }

  const instances = app.findCollectionByNameOrId('instances')
  const kind = instances.fields.getByName('kind')
  kind.values = Array.from(kind.values).filter(value => value !== 'telegram')
  instances.fields.removeByName('telegram_db_url')
  app.save(instances)
})
