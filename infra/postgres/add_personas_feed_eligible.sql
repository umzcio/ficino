-- Distinguish feed-posting personas from reply-only personas.
--
-- Historical bug: `enabled_personas` in persona_tasks.generate_feed was
-- derived from user_settings["personas_enabled"], a dict seeded with only
-- the original 5 persona keys. The Amplifier persona was added later via
-- add_amplifier_persona.sql but never made it into the settings defaults,
-- so every feed generation silently dropped it. The Archivist is in the
-- DB as is_active=true because it responds to user posts via
-- archivist_tasks.respond_to_user_post, not because it should publish to
-- feeds.
--
-- Fix: treat persona eligibility as a property of the persona row, and
-- make feed generation opt-out (default on for every feed_eligible
-- persona, off only if the user explicitly toggles it off in
-- personas_enabled). This way a new persona added via migration
-- automatically ships to every user without a separate settings update.
--
-- Run with: docker exec -i ficino-postgres psql -U ficino -d ficino \
--   < infra/postgres/add_personas_feed_eligible.sql

ALTER TABLE personas
  ADD COLUMN IF NOT EXISTS feed_eligible BOOLEAN NOT NULL DEFAULT TRUE;

-- Archivist is reply-only. It never appears as a feed author.
UPDATE personas SET feed_eligible = FALSE WHERE key = 'archivist';
