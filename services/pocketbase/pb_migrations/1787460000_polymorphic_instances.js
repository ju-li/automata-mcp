/// <reference path="../pb_data/types.d.ts" />

// Make an instance polymorphic, and give tokens a table axis.
//
// Until now an `instances` row *was* an Evolution instance: every field on it
// was Evolution's, and every MCP tool assumed WhatsApp. `kind` turns the row
// into a discriminated union so a second sort of connection — here Postgres,
// later Telegram and other databases — can live in the same table, carry the
// same connector tokens, and reuse the same ownership and scoping machinery.
//
// Two fields are new secrets, both `hidden`:
//
//   admin_key  a *global* key for a user-supplied Evolution server. It can
//              create and delete instances on that server, so it is wider than
//              `api_key` and must never reach credentialsForInstance().
//   dsn        a user-supplied Postgres connection string.
//
// `hidden` keeps a field out of the REST projection, including from the owning
// user. It is NOT encryption: these sit in clear in pb_data and in every backup.
//
// The token axis mirrors `all_chats` / `chat_jids` exactly, for the same reason
// and with the same escape hatch: `all_tables=true` ignores `table_names`.

migrate((app) => {
  const instances = app.findCollectionByNameOrId('instances')

  instances.fields.add(new SelectField({
    name: 'kind',
    // Not `required` — see the backfill below.
    required: false,
    maxSelect: 1,
    values: ['whatsapp', 'postgres'],
  }))

  instances.fields.add(new TextField({
    // Global key for a BYO Evolution server. Empty means "use the deployment
    // default from NUXT_EVOLUTION_URL / NUXT_EVOLUTION_ADMIN_KEY".
    name: 'admin_key',
    required: false,
    max: 255,
    hidden: true,
  }))

  instances.fields.add(new TextField({
    name: 'dsn',
    required: false,
    max: 2000,
    hidden: true,
  }))

  // Display-only mirrors of what the DSN points at, so the dashboard and the
  // instance list can say where a connection goes without reading the secret.
  instances.fields.add(new TextField({ name: 'pg_host', required: false, max: 255 }))
  instances.fields.add(new NumberField({ name: 'pg_port', required: false }))
  instances.fields.add(new TextField({ name: 'pg_database', required: false, max: 128 }))

  app.save(instances)

  // ── backfill kind ────────────────────────────────────────────────────────
  // PocketBase materialises an unset SelectField as '', which matches no kind
  // and would leave every existing account with no tools at all. Backfill
  // BEFORE marking the field required, or saving the collection fails against
  // rows that do not satisfy it yet.
  for (const instance of app.findAllRecords('instances')) {
    if (!instance.get('kind')) {
      instance.set('kind', 'whatsapp')
      app.save(instance)
    }
  }

  const withKind = app.findCollectionByNameOrId('instances')
  const kind = withKind.fields.getByName('kind')
  kind.required = true
  app.save(withKind)

  // ── mcp_tokens: the table axis ───────────────────────────────────────────
  const tokens = app.findCollectionByNameOrId('mcp_tokens')

  tokens.fields.add(new BoolField({
    name: 'all_tables',
    required: false,
  }))
  tokens.fields.add(new JSONField({
    // Exact `schema.table` strings as pg_namespace.nspname and pg_class.relname
    // report them. Case-sensitive: Evolution's own tables are "Message" and
    // "Chat", and folding case here would refuse them.
    name: 'table_names',
    required: false,
    maxSize: 100000,
  }))

  app.save(tokens)

  // Same backfill, same reason as 1787449074: an unset bool reads as false, and
  // a token scoped to zero tables is a silent total loss of access rather than
  // a loud one.
  for (const token of app.findAllRecords('mcp_tokens')) {
    token.set('all_tables', true)
    token.set('table_names', [])
    app.save(token)
  }
}, (app) => {
  // ── down ─────────────────────────────────────────────────────────────────
  const tokens = app.findCollectionByNameOrId('mcp_tokens')
  tokens.fields.removeByName('all_tables')
  tokens.fields.removeByName('table_names')
  app.save(tokens)

  const instances = app.findCollectionByNameOrId('instances')
  // Anything that is not a WhatsApp account cannot be represented by the old
  // schema at all — its credentials live in fields that are about to be
  // removed. Drop those rows (and, by cascade, their tokens) rather than leave
  // records that look connected and can never authenticate.
  for (const instance of app.findAllRecords('instances')) {
    if (instance.get('kind') === 'postgres') app.delete(instance)
  }
  instances.fields.removeByName('kind')
  instances.fields.removeByName('admin_key')
  instances.fields.removeByName('dsn')
  instances.fields.removeByName('pg_host')
  instances.fields.removeByName('pg_port')
  instances.fields.removeByName('pg_database')
  app.save(instances)
})
