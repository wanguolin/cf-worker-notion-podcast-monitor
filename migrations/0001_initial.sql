PRAGMA foreign_keys = ON;

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  cron TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (
    status IN (
      'creating',
      'queued',
      'running',
      'succeeded',
      'partial',
      'failed',
      'skipped_previous_run_active'
    )
  ),
  catalog_row_count INTEGER NOT NULL DEFAULT 0 CHECK (catalog_row_count >= 0),
  unique_feed_count INTEGER NOT NULL DEFAULT 0 CHECK (unique_feed_count >= 0),
  succeeded_feed_count INTEGER NOT NULL DEFAULT 0 CHECK (succeeded_feed_count >= 0),
  failed_feed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_feed_count >= 0),
  new_episode_count INTEGER NOT NULL DEFAULT 0 CHECK (new_episode_count >= 0),
  parent_update_count INTEGER NOT NULL DEFAULT 0 CHECK (parent_update_count >= 0),
  heartbeat_at TEXT NOT NULL,
  error_summary TEXT
);

CREATE INDEX runs_status_scheduled_at_idx ON runs (status, scheduled_at);

CREATE TABLE feed_tasks (
  task_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  feed_url_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'pending_enqueue',
      'queued',
      'processing',
      'retrying',
      'succeeded',
      'failed',
      'dead_lettered'
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  queued_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  http_status INTEGER,
  downloaded_bytes INTEGER NOT NULL DEFAULT 0 CHECK (downloaded_bytes >= 0),
  parsed_item_count INTEGER NOT NULL DEFAULT 0 CHECK (parsed_item_count >= 0),
  window_item_count INTEGER NOT NULL DEFAULT 0 CHECK (window_item_count >= 0),
  new_episode_count INTEGER NOT NULL DEFAULT 0 CHECK (new_episode_count >= 0),
  notion_write_count INTEGER NOT NULL DEFAULT 0 CHECK (notion_write_count >= 0),
  parent_update_count INTEGER NOT NULL DEFAULT 0 CHECK (parent_update_count >= 0),
  error_code TEXT,
  error_summary TEXT,
  FOREIGN KEY (run_id) REFERENCES runs (run_id) ON DELETE CASCADE,
  UNIQUE (run_id, feed_url_hash)
);

CREATE INDEX feed_tasks_run_status_idx ON feed_tasks (run_id, status);

CREATE TABLE producer_locks (
  lock_name TEXT PRIMARY KEY,
  owner_run_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (owner_run_id) REFERENCES runs (run_id) ON DELETE CASCADE
);

CREATE INDEX producer_locks_expires_at_idx ON producer_locks (expires_at);

CREATE TABLE episode_writes (
  write_id INTEGER PRIMARY KEY AUTOINCREMENT,
  podcast_name TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  feed_url_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'written', 'uncertain', 'failed')),
  notion_page_id TEXT,
  first_seen_at TEXT NOT NULL,
  last_attempt_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  UNIQUE (podcast_name, dedup_key)
);

CREATE INDEX episode_writes_feed_url_hash_idx ON episode_writes (feed_url_hash);

CREATE TABLE parent_blocks (
  parent_page_id TEXT PRIMARY KEY,
  sync_time_block_id TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL
);
