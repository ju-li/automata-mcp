/**
 * The app's schema, as an ordered list of migrations.
 *
 * TypeScript strings rather than `.sql` files so they are bundled into the Nitro
 * output with no copy step — a migration that is missing from the image is a
 * deployment with no tables. Applied at boot by `migrateAppDb()` in
 * `server/utils/app-db.ts`, under an advisory lock, in one transaction.
 *
 * Append only. A migration that has been deployed is never edited: its name is
 * recorded in `app.migrations` and it will not run again, so an edit reaches
 * fresh databases and silently skips every existing one.
 *
 * Every table lives in the `app` schema, never `public`: this is the same
 * Postgres database Evolution writes into (and the Telegram bridge, under
 * `telegram`), and Evolution owns `public`.
 */
export interface AppMigration {
  name: string
  sql: string
}

export const APP_MIGRATIONS: AppMigration[] = [
  {
    name: '0001_init',
    sql: /* sql */ `
      -- Ids are text so rows imported from PocketBase keep the ids they had —
      -- they are in URLs, in the browser's history, and in token labels people
      -- have written down. New rows get a uuid.

      CREATE TABLE app.users (
        id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        -- Stored lower-cased and trimmed (normaliseEmail), which is also what
        -- invitation acceptance compares against.
        email         text NOT NULL CHECK (email = lower(btrim(email)) AND email <> ''),
        name          text NOT NULL DEFAULT '',
        -- scrypt$..., or a bcrypt $2a$/$2b$ hash carried over from PocketBase and
        -- replaced by scrypt on that user's next successful sign-in.
        password_hash text NOT NULL,
        created       timestamptz NOT NULL DEFAULT now(),
        updated       timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX users_email_key ON app.users (email);

      -- A browser session. Only the SHA-256 of the cookie value is stored, the
      -- same handling an MCP token gets.
      CREATE TABLE app.sessions (
        id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id      text NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
        token_hash   text NOT NULL CHECK (length(token_hash) = 64),
        expires_at   timestamptz NOT NULL,
        created      timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX sessions_token_hash_key ON app.sessions (token_hash);
      CREATE INDEX sessions_user_idx ON app.sessions (user_id);

      CREATE TABLE app.organizations (
        id      text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        name    text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
        created timestamptz NOT NULL DEFAULT now(),
        updated timestamptz NOT NULL DEFAULT now()
      );

      -- One organization per user: the unique index on user_id is that rule,
      -- and why accepting an invitation is an UPDATE of this row.
      CREATE TABLE app.memberships (
        id      text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        org     text NOT NULL REFERENCES app.organizations (id) ON DELETE CASCADE,
        user_id text NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
        role    text NOT NULL CHECK (role IN ('admin', 'member')),
        created timestamptz NOT NULL DEFAULT now(),
        updated timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX memberships_user_key ON app.memberships (user_id);
      CREATE INDEX memberships_org_idx ON app.memberships (org);

      CREATE TABLE app.instances (
        id               text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        -- RESTRICT, not CASCADE: deleting an organization that still owns
        -- connections must fail loudly rather than drop rows that point at live
        -- sockets on real phone numbers. deleteInstance() is the only way out.
        org              text NOT NULL REFERENCES app.organizations (id) ON DELETE RESTRICT,
        -- Provenance only. SET NULL for the same reason: a creator's account
        -- going must never take a connection with it.
        created_by       text REFERENCES app.users (id) ON DELETE SET NULL,
        kind             text NOT NULL CHECK (kind IN ('whatsapp', 'postgres', 'telegram')),
        name             text NOT NULL,
        instance_id      text NOT NULL DEFAULT '',
        api_key          text NOT NULL DEFAULT '',
        admin_key        text NOT NULL DEFAULT '',
        base_url         text NOT NULL DEFAULT '',
        evolution_db_url text NOT NULL DEFAULT '',
        telegram_db_url  text NOT NULL DEFAULT '',
        dsn              text NOT NULL DEFAULT '',
        db_host          text NOT NULL DEFAULT '',
        db_port          integer,
        db_database      text NOT NULL DEFAULT '',
        label            text NOT NULL DEFAULT '',
        down_since       timestamptz,
        alerted_at       timestamptz,
        created          timestamptz NOT NULL DEFAULT now(),
        updated          timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX instances_name_key ON app.instances (name);
      CREATE INDEX instances_org_idx ON app.instances (org);

      -- "May use, not manage." Admins hold no rows here.
      CREATE TABLE app.instance_assignments (
        id       text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        instance text NOT NULL REFERENCES app.instances (id) ON DELETE CASCADE,
        user_id  text NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
        created  timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX instance_assignments_key ON app.instance_assignments (instance, user_id);
      CREATE INDEX instance_assignments_user_idx ON app.instance_assignments (user_id);

      CREATE TABLE app.invitations (
        id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        org         text NOT NULL REFERENCES app.organizations (id) ON DELETE CASCADE,
        email       text NOT NULL,
        role        text NOT NULL CHECK (role IN ('admin', 'member')),
        code_hash   text NOT NULL CHECK (length(code_hash) = 64),
        invited_by  text REFERENCES app.users (id) ON DELETE SET NULL,
        accepted_by text REFERENCES app.users (id) ON DELETE SET NULL,
        expires_at  timestamptz,
        accepted_at timestamptz,
        revoked     boolean NOT NULL DEFAULT false,
        created     timestamptz NOT NULL DEFAULT now(),
        updated     timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX invitations_code_hash_key ON app.invitations (code_hash);
      CREATE INDEX invitations_org_idx ON app.invitations (org);

      CREATE TABLE app.mcp_tokens (
        id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        -- CASCADE: a deleted account's tokens must stop working.
        assigned_to  text NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
        created_by   text REFERENCES app.users (id) ON DELETE SET NULL,
        instance     text NOT NULL REFERENCES app.instances (id) ON DELETE CASCADE,
        token_hash   text NOT NULL CHECK (length(token_hash) = 64),
        label        text NOT NULL DEFAULT '',
        last_used_at timestamptz,
        expires_at   timestamptz,
        revoked      boolean NOT NULL DEFAULT false,
        -- Scope. NOT NULL with a default, so no write path can mint a token
        -- whose scope is an accident of what it forgot to set.
        all_chats    boolean NOT NULL DEFAULT true,
        chat_jids    jsonb NOT NULL DEFAULT '[]'::jsonb,
        all_tables   boolean NOT NULL DEFAULT true,
        table_names  jsonb NOT NULL DEFAULT '[]'::jsonb,
        all_tools    boolean NOT NULL DEFAULT true,
        tool_names   jsonb NOT NULL DEFAULT '[]'::jsonb,
        created      timestamptz NOT NULL DEFAULT now(),
        updated      timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX mcp_tokens_token_hash_key ON app.mcp_tokens (token_hash);
      CREATE INDEX mcp_tokens_assigned_to_idx ON app.mcp_tokens (assigned_to);
      CREATE INDEX mcp_tokens_instance_idx ON app.mcp_tokens (instance);
    `,
  },
]
