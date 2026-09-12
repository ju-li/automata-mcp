/// <reference path="../pb_data/types.d.ts" />

// Connections belong to an organization, not to a person.
//
// Until now the whole app rested on one predicate — `instance.user === user.id`
// — and there was no second principal anywhere. This introduces organizations,
// two roles, invitations and per-connection assignment, so a team can share a
// deployment without sharing an account.
//
// Four new collections, all five API rules null: superuser-only, like
// `instances` and `mcp_tokens`. The Nuxt server brokers every read and write.
//
// ── Why `role` is not a field on `users` ─────────────────────────────────────
//
// `users` is the ONE collection a visitor's own credential can write to:
//
//   createRule ''                      (public create)
//   listRule / viewRule / updateRule   id = @request.auth.id
//   deleteRule                         id = @request.auth.id
//
// `pb_auth` is httpOnly, which hides it from `document.cookie` and not from the
// devtools Application panel, so a signed-in human can drive PocketBase's REST
// API directly as themselves. A `hidden: true` role field would *probably* hold
// — PocketBase's non-superuser record upsert refuses to load hidden fields from
// request data, which is what `instances.api_key` already relies on. A
// superuser-only collection needs no probably. `hidden` means "absent from the
// API projection" everywhere else in this schema, and making it load-bearing
// against privilege escalation would be a control nobody reviewing the schema
// would recognise as one.
//
// This migration also closes two of those rules: `createRule` and `deleteRule`
// become null. The app brokers signup through the admin client, and nothing in
// it deletes an account. Self-delete in particular was a live hazard — see the
// cascade note on `created_by` below. `listRule`/`viewRule`/`updateRule` stay
// as they are: `getSessionUser()`'s `authRefresh` goes through that path, and
// tightening it is a separate change that would need its own proof.
//
// ── Why UNIQUE(memberships.user) ────────────────────────────────────────────
//
// One organization per user, with no org switcher. That index IS the rule, and
// it is why accepting an invitation is an UPDATE of the existing membership row
// rather than a delete-then-create: the row is the user's single slot, so one
// write is atomic, trips no index, and leaves no window in which the user
// belongs to no organization at all.

migrate((app) => {
  const users = app.findCollectionByNameOrId('users')

  // ── organizations ────────────────────────────────────────────────────────
  const orgs = new Collection({
    type: 'base',
    name: 'organizations',
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
  })

  // Fields must go on with `fields.add()`. Passing them to the Collection
  // constructor silently yields a collection with no fields — it unmarshals a
  // plain JSON object and drops Field instances on the floor.
  orgs.fields.add(new TextField({ name: 'name', required: true, max: 100 }))
  orgs.fields.add(new AutodateField({ name: 'created', onCreate: true, onUpdate: false }))
  orgs.fields.add(new AutodateField({ name: 'updated', onCreate: true, onUpdate: true }))

  app.save(orgs)

  // ── memberships ──────────────────────────────────────────────────────────
  const memberships = new Collection({
    type: 'base',
    name: 'memberships',
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
  })

  memberships.fields.add(new RelationField({
    name: 'org',
    required: true,
    collectionId: orgs.id,
    cascadeDelete: true,
    maxSelect: 1,
  }))
  memberships.fields.add(new RelationField({
    // Cascades: a deleted account holds no membership.
    name: 'user',
    required: true,
    collectionId: users.id,
    cascadeDelete: true,
    maxSelect: 1,
  }))
  memberships.fields.add(new SelectField({
    name: 'role',
    required: true,
    maxSelect: 1,
    values: ['admin', 'member'],
  }))
  memberships.fields.add(new AutodateField({ name: 'created', onCreate: true, onUpdate: false }))
  memberships.fields.add(new AutodateField({ name: 'updated', onCreate: true, onUpdate: true }))

  memberships.indexes = [
    // One organization per user. See the header.
    'CREATE UNIQUE INDEX `idx_memberships_user` ON `memberships` (`user`)',
    'CREATE INDEX `idx_memberships_org` ON `memberships` (`org`)',
  ]

  app.save(memberships)

  // ── invitations ──────────────────────────────────────────────────────────
  // Link/code based: this deployment has no SMTP. The plaintext code is returned
  // once, at creation, exactly like an MCP token, and only its SHA-256 hash is
  // stored — an invitation is a bearer credential for joining an organization
  // and deserves the same handling as one.
  const invitations = new Collection({
    type: 'base',
    name: 'invitations',
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
  })

  invitations.fields.add(new RelationField({
    name: 'org',
    required: true,
    collectionId: orgs.id,
    cascadeDelete: true,
    maxSelect: 1,
  }))
  invitations.fields.add(new TextField({
    // Lower-cased by the app before it is written; PocketBase has no transform.
    // Acceptance requires the accepting account's email to match, so a leaked
    // link alone is not enough to join.
    name: 'email',
    required: true,
    max: 255,
  }))
  invitations.fields.add(new SelectField({
    name: 'role',
    required: true,
    maxSelect: 1,
    values: ['admin', 'member'],
  }))
  invitations.fields.add(new TextField({
    name: 'code_hash',
    required: true,
    min: 64,
    max: 64, // SHA-256, lowercase hex
  }))
  invitations.fields.add(new RelationField({
    // Never cascades: an admin leaving must neither erase the audit trail nor
    // become undeletable because of it.
    name: 'invited_by',
    required: false,
    collectionId: users.id,
    cascadeDelete: false,
    maxSelect: 1,
  }))
  invitations.fields.add(new RelationField({
    name: 'accepted_by',
    required: false,
    collectionId: users.id,
    cascadeDelete: false,
    maxSelect: 1,
  }))
  invitations.fields.add(new DateField({ name: 'expires_at', required: false }))
  invitations.fields.add(new DateField({ name: 'accepted_at', required: false }))
  invitations.fields.add(new BoolField({ name: 'revoked', required: false }))
  invitations.fields.add(new AutodateField({ name: 'created', onCreate: true, onUpdate: false }))
  invitations.fields.add(new AutodateField({ name: 'updated', onCreate: true, onUpdate: true }))

  invitations.indexes = [
    'CREATE UNIQUE INDEX `idx_invitations_code_hash` ON `invitations` (`code_hash`)',
    'CREATE INDEX `idx_invitations_org` ON `invitations` (`org`)',
  ]
  // "One pending invitation per (org, email)" is enforced in app code, by
  // revoking the existing pending one before creating the next. A partial
  // unique index would have to encode PocketBase's empty-date ('') and bool (0)
  // representations in SQL, which is a sharp edge for no gain.

  app.save(invitations)

  // ── instance_assignments ─────────────────────────────────────────────────
  // Which connections a member may use. Admins reach every connection in their
  // organization and hold no rows here.
  const instances = app.findCollectionByNameOrId('instances')

  const assignments = new Collection({
    type: 'base',
    name: 'instance_assignments',
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
  })

  assignments.fields.add(new RelationField({
    name: 'instance',
    required: true,
    collectionId: instances.id,
    cascadeDelete: true,
    maxSelect: 1,
  }))
  assignments.fields.add(new RelationField({
    name: 'user',
    required: true,
    collectionId: users.id,
    cascadeDelete: true,
    maxSelect: 1,
  }))
  assignments.fields.add(new AutodateField({ name: 'created', onCreate: true, onUpdate: false }))

  assignments.indexes = [
    'CREATE UNIQUE INDEX `idx_assignments_instance_user` ON `instance_assignments` (`instance`, `user`)',
    'CREATE INDEX `idx_assignments_user` ON `instance_assignments` (`user`)',
  ]

  app.save(assignments)

  // ── instances.org ────────────────────────────────────────────────────────
  // Added NOT required, backfilled, then marked required — the same ordering
  // 1787460000 used for `kind`, and for the same reason: saving a collection
  // with a required field fails against rows that do not satisfy it yet.
  //
  // cascadeDelete is FALSE deliberately. Deleting an organization that still
  // owns connections must fail loudly. A cascade would delete `instances` rows
  // straight out of the database, bypassing `deleteInstance()` entirely: no
  // `/instance/delete` on Evolution, no pool closed, a live socket on a real
  // phone number left running with nothing left that records it exists.
  instances.fields.add(new RelationField({
    name: 'org',
    required: false,
    collectionId: orgs.id,
    cascadeDelete: false,
    maxSelect: 1,
  }))

  app.save(instances)

  // ── one organization per existing user ───────────────────────────────────
  const orgsCollection = app.findCollectionByNameOrId('organizations')
  const membershipsCollection = app.findCollectionByNameOrId('memberships')
  const orgByUser = {}

  for (const user of app.findAllRecords('users')) {
    if (!user) continue

    const label = String(user.get('name') || '').trim()
      || String(user.get('email') || '').split('@')[0]
      || 'Organization'

    const org = new Record(orgsCollection)
    org.set('name', label.slice(0, 100))
    app.save(org)

    const membership = new Record(membershipsCollection)
    membership.set('org', org.id)
    membership.set('user', user.id)
    membership.set('role', 'admin')
    app.save(membership)

    orgByUser[user.id] = org.id
  }

  // Reads the PRE-rename column. The rename below happens after this loop
  // precisely so `get('user')` still answers.
  for (const instance of app.findAllRecords('instances')) {
    if (!instance) continue

    const orgId = orgByUser[instance.get('user')]
    if (!orgId) {
      // An instance with no resolvable owner cannot be represented at all once
      // `org` is required, and nothing could ever reach it. Drop it — its
      // tokens cascade with it — rather than leave a row that looks connected
      // and can never be authorised.
      app.delete(instance)
      continue
    }

    instance.set('org', orgId)
    app.save(instance)
  }

  // ── required + rename, in one save ───────────────────────────────────────
  const withOrg = app.findCollectionByNameOrId('instances')
  withOrg.fields.getByName('org').required = true

  // Renaming mutates the existing field rather than add-then-remove: the field
  // id is stable and was generated once from the original name, so PocketBase
  // issues ALTER TABLE ... RENAME COLUMN and the data survives. Add-then-remove
  // would mint a new id and drop the column.
  const owner = withOrg.fields.getByName('user')
  owner.name = 'created_by'
  // Not required, and NOT cascading. `users.deleteRule` was
  // `id = @request.auth.id` until this migration — a member could delete their
  // own PocketBase record — and a cascade there would have taken the
  // organization's connections with them, bypassing every teardown path.
  // Closing the rule removes today's route to that; dropping the cascade means
  // a future one cannot reopen it.
  owner.required = false
  owner.cascadeDelete = false

  // Indexes name the column, and the rename does not rewrite this list for us.
  // Rewritten wholesale in the same save so the mismatch is impossible rather
  // than version-dependent.
  withOrg.indexes = [
    'CREATE UNIQUE INDEX `idx_instances_name` ON `instances` (`name`)',
    'CREATE INDEX `idx_instances_created_by` ON `instances` (`created_by`)',
    'CREATE INDEX `idx_instances_org` ON `instances` (`org`)',
  ]

  app.save(withOrg)

  // ── mcp_tokens: assigned_to + created_by ─────────────────────────────────
  // `user` meant "the owner, who is also the only person who can use it". It
  // now means "the member this token was issued to", and who minted it is a
  // separate, weaker fact. Renaming rather than reusing the name keeps a field
  // from asserting a security property that no longer holds.
  const tokens = app.findCollectionByNameOrId('mcp_tokens')

  const holder = tokens.fields.getByName('user')
  holder.name = 'assigned_to'
  // Stays required and cascading: a deleted account's tokens must stop working.

  tokens.fields.add(new RelationField({
    name: 'created_by',
    required: false,
    collectionId: users.id,
    cascadeDelete: false,
    maxSelect: 1,
  }))

  tokens.indexes = [
    'CREATE UNIQUE INDEX `idx_mcp_tokens_token_hash` ON `mcp_tokens` (`token_hash`)',
    'CREATE INDEX `idx_mcp_tokens_assigned_to` ON `mcp_tokens` (`assigned_to`)',
    'CREATE INDEX `idx_mcp_tokens_instance` ON `mcp_tokens` (`instance`)',
  ]

  app.save(tokens)

  // Every existing token was minted by the person holding it.
  for (const token of app.findAllRecords('mcp_tokens')) {
    if (!token || token.get('created_by')) continue
    token.set('created_by', token.get('assigned_to'))
    app.save(token)
  }

  // ── users: close create and delete ───────────────────────────────────────
  // Done last, so a failure earlier in this migration does not leave the rules
  // changed without the collections that justify them.
  const usersAgain = app.findCollectionByNameOrId('users')
  usersAgain.createRule = null
  usersAgain.deleteRule = null
  app.save(usersAgain)
}, (app) => {
  // ── down ─────────────────────────────────────────────────────────────────
  const users = app.findCollectionByNameOrId('users')
  users.createRule = ''
  users.deleteRule = 'id = @request.auth.id'
  app.save(users)

  const tokens = app.findCollectionByNameOrId('mcp_tokens')
  tokens.fields.getByName('assigned_to').name = 'user'
  tokens.fields.removeByName('created_by')
  tokens.indexes = [
    'CREATE UNIQUE INDEX `idx_mcp_tokens_token_hash` ON `mcp_tokens` (`token_hash`)',
    'CREATE INDEX `idx_mcp_tokens_user` ON `mcp_tokens` (`user`)',
  ]
  app.save(tokens)

  // The rename and the index list go in ONE save, here as in the up: an index
  // still naming `created_by` is validated against the post-rename column list
  // and fails with "no such column". `org` is still present at this point, so
  // its index stays in the list until the field itself goes.
  const instances = app.findCollectionByNameOrId('instances')
  instances.fields.getByName('created_by').name = 'user'
  instances.indexes = [
    'CREATE UNIQUE INDEX `idx_instances_name` ON `instances` (`name`)',
    'CREATE INDEX `idx_instances_user` ON `instances` (`user`)',
    'CREATE INDEX `idx_instances_org` ON `instances` (`org`)',
  ]
  app.save(instances)

  // A connection created by someone since removed has no owner the old schema
  // can express, and `user` is about to be required again. Drop those rows —
  // their tokens cascade — rather than leave records nothing can authenticate.
  // This runs BEFORE `required` is restored, for the same reason the up
  // backfills `org` before requiring it.
  for (const instance of app.findAllRecords('instances')) {
    if (instance && !instance.get('user')) app.delete(instance)
  }

  // `org` is removed BEFORE `organizations` is deleted: deleting a collection
  // that is still the target of a relation runs PocketBase's cascade machinery
  // over every instance row.
  const withoutOrg = app.findCollectionByNameOrId('instances')
  const owner = withoutOrg.fields.getByName('user')
  owner.required = true
  owner.cascadeDelete = true
  withoutOrg.fields.removeByName('org')
  withoutOrg.indexes = [
    'CREATE UNIQUE INDEX `idx_instances_name` ON `instances` (`name`)',
    'CREATE INDEX `idx_instances_user` ON `instances` (`user`)',
  ]
  app.save(withoutOrg)

  for (const name of ['instance_assignments', 'invitations', 'memberships', 'organizations']) {
    try {
      app.delete(app.findCollectionByNameOrId(name))
    } catch {
      // already gone
    }
  }
})
