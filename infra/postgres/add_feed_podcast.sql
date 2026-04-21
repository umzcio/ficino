-- NotebookLM-style podcast mode for feeds: two-host dialogue rendered as
-- ordered ElevenLabs segments. Sibling to add_feed_audio_status.sql, but
-- segment text+voice+audio_key lives in a dedicated JSONB column rather
-- than on posts[*] — podcast segments are hosts, not personas, and aren't
-- keyed by post_index.
ALTER TABLE feeds
  ADD COLUMN IF NOT EXISTS podcast_status TEXT,
  ADD COLUMN IF NOT EXISTS podcast_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS podcast_segments JSONB;
-- podcast_status: NULL | 'generating' | 'ready' | 'failed'
-- podcast_segments: [{index, speaker, text, voice_id, audio_key, audio_error?}, ...]
