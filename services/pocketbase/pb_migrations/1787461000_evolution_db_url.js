/// <reference path="../pb_data/types.d.ts" />

// Let a bring-your-own Evolution server carry its own database URL.
//
// Both WhatsApp read tools read Evolution's Postgres directly — its API cannot
// search message content and cannot collapse the duplicate rows a re-pair
// leaves behind. `NUXT_EVOLUTION_DATABASE_URL` names exactly one database,
// though: the one belonging to the Evolution server this deployment is
// configured with. An account on the user's own server keeps its messages in
// *that* server's database, so without a per-connection URL every read matched
// nothing and reported an empty conversation.
//
// Optional. Empty means "use the deployment default, if this connection is on
// the deployment's server" — and if it is not, reads answer 501 naming this
// field rather than answering zero rows. Pairing, chat listing and sending
// never needed it.
//
// `hidden`, like `api_key`, `admin_key` and `dsn`. Same caveat as those: hidden
// keeps a field out of the REST projection, including from the owning user, and
// is NOT encryption — it sits in clear in pb_data and in every backup. This one
// reaches every account on the user's Evolution server, not only this one, so it
// is the widest read credential a row can carry.
//
// No backfill: empty is already the correct value for every existing row.

migrate((app) => {
  const instances = app.findCollectionByNameOrId('instances')

  instances.fields.add(new TextField({
    name: 'evolution_db_url',
    required: false,
    max: 2000,
    hidden: true,
  }))

  app.save(instances)
}, (app) => {
  const instances = app.findCollectionByNameOrId('instances')
  instances.fields.removeByName('evolution_db_url')
  app.save(instances)
})
