-- Sync bookkeeping: backfill progress per chat, and whose chats a session holds.

ALTER TABLE chats
  ADD COLUMN archived boolean NOT NULL DEFAULT false,
  -- Lowest message id backfilled so far; the next page starts below it.
  -- NULL = backfill has not started for this chat.
  ADD COLUMN backfill_cursor bigint,
  ADD COLUMN backfill_count integer NOT NULL DEFAULT 0,
  -- Why backfill stopped; NULL while it still has work. start = reached the
  -- chat's first message (and backfill_complete is true); days / count = hit a
  -- configured cap; skipped = a broadcast channel while broadcast backfill is
  -- off; inaccessible = Telegram refused the history.
  ADD COLUMN backfill_stopped text
    CHECK (backfill_stopped IN ('start', 'days', 'count', 'skipped', 'inaccessible'));

CREATE INDEX chats_backfill_queue ON chats (session_id, last_message_at DESC NULLS LAST)
  WHERE backfill_stopped IS NULL;

ALTER TABLE sessions
  ADD COLUMN dialogs_synced_at timestamptz,
  -- The Telegram user the synced chats belong to. Linking a different account
  -- discards them rather than mixing two people's chats under one session.
  ADD COLUMN data_user_id bigint;
