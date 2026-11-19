-- A per-chat ceiling on how many older messages backfill fetches, raised when
-- the app asks for more history in one chat (POST /sessions/:id/backfill).
-- NULL = the deployment's TELEGRAM_BACKFILL_MAX_PER_CHAT. The higher of the two
-- applies, so a raise is never undone by a later change of the setting. The day
-- limit still applies on top: this only moves the count, never the window.
ALTER TABLE chats
  ADD COLUMN backfill_limit integer CHECK (backfill_limit >= 0);
