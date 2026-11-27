-- Drop messages.reactions: reactions are no longer stored (#355).
--
-- Since 1.7.0 the bridge neither writes nor names this column and the app never
-- reads it; new rows have left it NULL. It ships a release after that change on
-- purpose: a 1.6.x bridge still writes the column and a 1.6.x web app still
-- selects it, so dropping it in the same release would fail their statements for
-- as long as an old process overlapped the new one (a rolling deploy, or one
-- service redeployed before the other).
--
-- DROP COLUMN only marks the column dropped in the catalog: no table rewrite,
-- no space returned now. The bytes go as rows are rewritten. Never rewrite the
-- table to reclaim them.
--
-- It does need an ACCESS EXCLUSIVE lock on messages, and migrate() runs with
-- statement_timeout = 0. While a waiting ACCESS EXCLUSIVE request sits in the
-- lock queue, every later reader and writer of the table queues behind it, so
-- the wait is capped: past 5 s this migration fails, boot exits, and the
-- platform restarts the bridge to try again. Postgres cancels an ordinary
-- autovacuum that blocks it; an anti-wraparound run is never cancelled, so then
-- it retries until that run ends.
--
-- Every pending migration runs in one transaction, so the cap is put back to
-- the default straight after, or it would also bind any migration after this one
-- in the same boot.
SET LOCAL lock_timeout = '5s';
ALTER TABLE messages DROP COLUMN IF EXISTS reactions;
SET LOCAL lock_timeout = DEFAULT;
