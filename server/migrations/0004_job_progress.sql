CREATE TABLE IF NOT EXISTS job_progress (
  job_id uuid PRIMARY KEY,
  queue text NOT NULL,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_progress_created_at_idx ON job_progress (created_at);
