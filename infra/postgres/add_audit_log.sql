-- Append-only audit log for destructive / privileged actions.
-- Inserted by the API middleware whenever a qualifying endpoint runs.
-- Retention: no auto-prune — operator decides via manual DELETE or
-- a cron job. Partitioning can come later if the table grows.

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,           -- e.g. "paper.delete", "feed.post.delete", "workspace.create"
  resource_type TEXT NOT NULL,    -- "paper", "feed", "workspace", "reading_list", …
  resource_id TEXT,               -- the UUID (or null for bulk ops)
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,  -- any extra context (pre-delete snapshot, reason, etc.)
  ip TEXT,                        -- from X-Forwarded-For first hop, else request.client.host
  user_agent TEXT,
  status_code INTEGER,            -- HTTP status the request returned
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_user_id_created_at_idx
  ON audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_resource_idx
  ON audit_log (resource_type, resource_id);
