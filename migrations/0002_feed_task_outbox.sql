ALTER TABLE feed_tasks ADD COLUMN message_body_json TEXT;

CREATE INDEX feed_tasks_run_outbox_idx
  ON feed_tasks (run_id, status)
  WHERE status IN ('pending_enqueue', 'queued');
