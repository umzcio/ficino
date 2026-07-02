-- Feed media generation claims (R10 WORK-5). A worker SIGKILLed mid-render
-- leaves audio_status/podcast_status stuck at 'generating' forever — the
-- claim predicate refuses to re-claim and acks_late redelivery self-defeats.
-- Stamp the claim time so a sufficiently old 'generating' row is treated as
-- abandoned and reclaimable.
ALTER TABLE feeds
  ADD COLUMN IF NOT EXISTS audio_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS podcast_claimed_at TIMESTAMPTZ;
