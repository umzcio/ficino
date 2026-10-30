CREATE TABLE rate_limits (
  key text PRIMARY KEY,
  count int NOT NULL,
  window_ends_at timestamptz NOT NULL
);
