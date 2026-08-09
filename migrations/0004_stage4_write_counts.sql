ALTER TABLE feed_tasks
  ADD COLUMN description_truncated_count INTEGER NOT NULL DEFAULT 0
  CHECK (description_truncated_count >= 0);

ALTER TABLE episode_writes ADD COLUMN run_id TEXT;
ALTER TABLE episode_writes ADD COLUMN task_id TEXT;

CREATE INDEX episode_writes_task_status_idx
  ON episode_writes (task_id, status);
