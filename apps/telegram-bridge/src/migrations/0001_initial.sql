-- Initial schema. Owned by the bridge; the app reads messages, chats and users
-- through a separate SELECT-only role (grantReader in db.ts), never sessions.

-- Trusted since Postgres 13, so the database owner can create it without a
-- superuser. Backs trigram search over message text.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 64),
  -- sha256 of the per-session bearer key; the key itself is shown once.
  api_key_hash text NOT NULL UNIQUE,
  -- The Telegram session string, sealed (crypto.ts). NULL = not linked.
  session_enc text,
  me_id bigint,
  me_username text,
  me_name text,
  me_phone text,
  authorized_at timestamptz,
  -- Set when Telegram stopped accepting the session (terminated from Devices,
  -- account deleted, auth key duplicated). Cleared by a successful pairing.
  revoked_at timestamptz,
  webhook_url text,
  webhook_headers_enc text,
  update_pts integer,
  update_qts integer,
  update_date integer,
  update_seq integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- chat_id is the Bot API marked id: a user is positive, a basic group is
-- -chat_id, a channel or supergroup is -(1000000000000 + channel_id).
CREATE TABLE chats (
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  chat_id bigint NOT NULL,
  type text NOT NULL CHECK (type IN ('private', 'bot', 'group', 'supergroup', 'channel')),
  title text,
  username text,
  -- Per session, required to address the peer. Never granted to the reader.
  access_hash bigint,
  is_forum boolean NOT NULL DEFAULT false,
  participant_count integer,
  top_message_id bigint,
  last_message_at timestamptz,
  unread_count integer NOT NULL DEFAULT 0,
  channel_pts integer,
  -- A basic group upgraded to a supergroup changes id; the old row points here.
  migrated_to bigint,
  backfill_complete boolean NOT NULL DEFAULT false,
  oldest_synced_at timestamptz,
  gap_since timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, chat_id)
);

CREATE INDEX chats_by_activity ON chats (session_id, last_message_at DESC NULLS LAST);

CREATE TABLE users (
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  user_id bigint NOT NULL,
  first_name text,
  last_name text,
  username text,
  -- Never granted to the reader.
  phone text,
  access_hash bigint,
  is_bot boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, user_id)
);

CREATE TABLE messages (
  session_id uuid NOT NULL,
  chat_id bigint NOT NULL,
  message_id bigint NOT NULL,
  -- Denormalised from chat_id and enforced below. Private chats and basic
  -- groups share one message id counter per account, so a deletion that
  -- arrives with ids and no chat resolves against NOT in_channel rows.
  in_channel boolean NOT NULL,
  sender_id bigint,
  from_me boolean NOT NULL DEFAULT false,
  date timestamptz NOT NULL,
  edit_date timestamptz,
  -- Message text, or the caption for media. NULL once deleted.
  text text,
  media_type text,
  entities jsonb,
  mentioned_user_ids bigint[] NOT NULL DEFAULT '{}',
  reply_to_id bigint,
  topic_id bigint,
  fwd_from jsonb,
  -- NULL for an ordinary message; the action for a service message.
  service_action jsonb,
  grouped_id bigint,
  -- [{ "emoji": ..., "count": ... }], replaced wholesale on every update.
  reactions jsonb,
  -- A tombstone: text and entities are cleared when this is set.
  deleted_at timestamptz,
  PRIMARY KEY (session_id, chat_id, message_id),
  FOREIGN KEY (session_id, chat_id) REFERENCES chats (session_id, chat_id) ON DELETE CASCADE,
  CHECK (in_channel = (chat_id <= -1000000000000)),
  CHECK (deleted_at IS NULL OR (text IS NULL AND entities IS NULL))
);

CREATE INDEX messages_page ON messages (session_id, chat_id, date DESC, message_id DESC);
CREATE INDEX messages_text_trgm ON messages USING gin (text gin_trgm_ops);
-- The invariant the peerless-deletion lookup depends on. If Telegram ever
-- breaks it, inserts fail loudly instead of a deletion hitting the wrong chat.
CREATE UNIQUE INDEX messages_common_box_id ON messages (session_id, message_id) WHERE NOT in_channel;
