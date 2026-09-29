/// <reference path="../pb_data/types.d.ts" />

// Rename the database display mirrors off their vendor prefix.
//
//   pg_host     -> db_host
//   pg_port     -> db_port
//   pg_database -> db_database
//
// These three are display-only: the dashboard and the connection list say where
// a connection points without reading the hidden `dsn`. They were named for the
// only engine that existed when they were added, and they will hold another
// engine's values shortly — at which point `pg_` on a MySQL row is not an
// awkward name, it is a wrong one.
//
// **Why these and not `chat_jids`.** `chat_jids` holds Telegram marked ids on a
// Telegram token and keeps its WhatsApp name, and that is right: the word is
// WhatsApp's but the concept — an identifier for a conversation — is shared, and
// renaming it would reach `scopeFields`'s six-column invariant, every minted
// token's semantics, the scope UI and a backfill. `pg_` is a vendor prefix on
// three display strings with four readers. Rename the cheap ones; leave the
// scope columns alone.
//
// A rename preserves data — PocketBase issues an ALTER TABLE RENAME COLUMN — so
// there is no copy step and no window where a row has neither name.
//
// `dsn` is deliberately NOT renamed. It is already engine-neutral ("data source
// name"), and it is safe to share across SQL kinds precisely because each
// engine's parser refuses the others' strings: `describeDsn` throws 422 on
// anything that is not postgres:// or postgresql://, so a DSN that reached the
// wrong reader fails at parse rather than attempting a connection.

const RENAMES = [
  ['pg_host', 'db_host'],
  ['pg_port', 'db_port'],
  ['pg_database', 'db_database'],
]

migrate((app) => {
  const instances = app.findCollectionByNameOrId('instances')

  for (const [from, to] of RENAMES) {
    const field = instances.fields.getByName(from)
    // Idempotent: a database already carrying the new names (a re-run, or a
    // fresh one built from a later snapshot) is left alone rather than throwing.
    if (!field) continue
    field.name = to
  }

  app.save(instances)
}, (app) => {
  const instances = app.findCollectionByNameOrId('instances')

  for (const [from, to] of RENAMES) {
    const field = instances.fields.getByName(to)
    if (!field) continue
    field.name = from
  }

  app.save(instances)
})
