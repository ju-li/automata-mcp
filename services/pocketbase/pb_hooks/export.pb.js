/// <reference path="../pb_data/types.d.ts" />

// Everything the app keeps, as raw rows, for the one-time move to Postgres.
//
// Superuser-only. Raw SQL rather than the record API on purpose: the record API
// never returns `password`, and the import has to carry each user's bcrypt hash
// across or every account would need a password reset. Every column is cast to
// text so one DynamicModel shape fits every table; the importer
// (apps/web/server/utils/pocketbase-import.ts) converts them back.
//
// Handlers run in an isolated VM, so the table list lives inside the handler.
routerAdd('GET', '/api/app/export', (e) => {
  const tables = {
    users: ['id', 'email', 'password', 'name', 'created'],
    organizations: ['id', 'name', 'created'],
    memberships: ['id', 'org', 'user', 'role', 'created'],
    instances: [
      'id', 'org', 'created_by', 'kind', 'name', 'instance_id', 'api_key', 'admin_key', 'base_url',
      'evolution_db_url', 'telegram_db_url', 'dsn', 'db_host', 'db_port', 'db_database', 'label',
      'down_since', 'alerted_at', 'created',
    ],
    instance_assignments: ['id', 'instance', 'user', 'created'],
    invitations: [
      'id', 'org', 'email', 'role', 'code_hash', 'invited_by', 'accepted_by', 'expires_at',
      'accepted_at', 'revoked', 'created',
    ],
    mcp_tokens: [
      'id', 'assigned_to', 'created_by', 'instance', 'token_hash', 'label', 'last_used_at',
      'expires_at', 'revoked', 'all_chats', 'chat_jids', 'all_tables', 'table_names', 'all_tools',
      'tool_names', 'created',
    ],
  }

  const out = {}
  for (const table of Object.keys(tables)) {
    const columns = tables[table]
    const shape = {}
    for (const column of columns) shape[column] = ''

    const rows = arrayOf(new DynamicModel(shape))
    const select = columns.map(c => "COALESCE(CAST([[" + c + "]] AS TEXT), '') AS [[" + c + ']]').join(', ')
    $app.db().newQuery('SELECT ' + select + ' FROM {{' + table + '}}').all(rows)
    out[table] = rows
  }

  return e.json(200, out)
}, $apis.requireSuperuserAuth())
