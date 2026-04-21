-- Feed audio playback: track TTS generation state at the feed level.
-- Per-post audio_url is stored inline in posts[*].audio_url (JSONB).
ALTER TABLE feeds
  ADD COLUMN IF NOT EXISTS audio_status TEXT,
  ADD COLUMN IF NOT EXISTS audio_generated_at TIMESTAMPTZ;
-- audio_status: NULL | 'generating' | 'ready' | 'failed'
