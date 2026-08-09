ALTER TABLE feed_tasks
  ADD COLUMN will_write_count INTEGER NOT NULL DEFAULT 0 CHECK (will_write_count >= 0);

ALTER TABLE feed_tasks
  ADD COLUMN already_exists_count INTEGER NOT NULL DEFAULT 0 CHECK (already_exists_count >= 0);

ALTER TABLE feed_tasks
  ADD COLUMN dedup_failed_count INTEGER NOT NULL DEFAULT 0 CHECK (dedup_failed_count >= 0);
