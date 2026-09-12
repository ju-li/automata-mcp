/// <reference path="../pb_data/types.d.ts" />

// Outage state for a connection, so the alert mailer can tell a new outage from
// one it has already reported.
//
// Two dates rather than one status field, on purpose. PocketBase materialises an
// unset SelectField as `''` and an unset BoolField as `false` — the traps that
// `instanceKind()` and `scopeFields()` exist for — so a status enum would need a
// backfill and a "what does empty mean" rule. An empty date already means
// exactly one thing.
//
//   down_since   first unhealthy reading of the current outage. Empty = healthy.
//   alerted_at   when the "connection is down" mail went out for the *current*
//                outage. Empty = nothing has been sent for it yet, which is what
//                stops a repeat mail on every sweep, and what decides whether a
//                recovery mail is owed when the connection comes back.
//
// Both are written by the server only — see apps/web/server/utils/alerts.ts.
// They are not `hidden`: neither is a secret, and the owning user seeing when
// their own connection dropped is the point of the feature.
//
// No backfill: empty is the correct value for every existing row. A connection
// that is already down gets its `down_since` from the first sweep after deploy,
// and so serves out the grace period once before it mails.

migrate((app) => {
  const instances = app.findCollectionByNameOrId('instances')

  instances.fields.add(new DateField({
    name: 'down_since',
    required: false,
  }))

  instances.fields.add(new DateField({
    name: 'alerted_at',
    required: false,
  }))

  app.save(instances)
}, (app) => {
  const instances = app.findCollectionByNameOrId('instances')
  instances.fields.removeByName('down_since')
  instances.fields.removeByName('alerted_at')
  app.save(instances)
})
