-- Throttle autovacuum on messages so a run leaves the disk to live traffic.
--
-- Unthrottled, a run that needs the index pass reads every index on the table
-- (~16 GB, 2.5-3M pages) at whatever the volume gives — 20-30 MB/s in
-- production — for 10-20 minutes, writing ~3.5 GB of WAL. Every write the
-- bridge makes meanwhile waits on the same disk: single-row upserts and
-- tombstones across unrelated sessions hit the 15 s statement_timeout in bursts
-- lining up with each run, every 2-3 hours (Nov 2026).
--
-- The cost model (PG 14+): a page found in shared buffers costs 1, one read
-- from outside costs 2, one dirtied costs 20; after spending the limit the
-- worker sleeps for the delay. A run that needed the index pass cost ~18M units
-- (1.2-1.6M hits, 2.5-3M reads, ~0.55M dirtied). At 60 units per 10 ms
-- (6000/s) that is ~50 minutes, its reads ~1000 pages/s (~8 MB/s) and its
-- dirtying and WAL spread over the same time. Runs start every 2-3 hours, so
-- they still finish well before the next is due; one that skips the index pass
-- costs a fraction of that.
--
-- Per-table values take this table's worker out of autovacuum's cost balancing,
-- so other tables keep the defaults. The failsafe (vacuum_failsafe_age) still
-- lifts the throttle when wraparound gets close.
--
-- Storage parameters only: SHARE UPDATE EXCLUSIVE, which blocks neither reads
-- nor writes. It does conflict with a running autovacuum on the table, which
-- Postgres cancels after deadlock_timeout for an ordinary run; an
-- anti-wraparound run is not cancelled, and this waits for it to finish.
ALTER TABLE messages SET (
  autovacuum_vacuum_cost_delay = 10,
  autovacuum_vacuum_cost_limit = 60
);
