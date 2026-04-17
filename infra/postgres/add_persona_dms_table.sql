-- Add missing persona_dms table.
-- The persona DM endpoints (api/routers/personas.py) reference this table
-- but it was never added to init.sql.

CREATE TABLE IF NOT EXISTS persona_dms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  persona_key TEXT NOT NULL REFERENCES personas(key) ON DELETE CASCADE,
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, persona_key)
);

CREATE INDEX IF NOT EXISTS persona_dms_user_persona_idx ON persona_dms(user_id, persona_key);

-- Verify
\d persona_dms
