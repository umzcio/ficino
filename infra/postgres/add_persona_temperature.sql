-- Adds a per-persona temperature column to the personas table. Null = use
-- the user's default persona_temperature setting (current behavior).
-- Populated at migration time with sensible defaults per persona based on
-- what each voice needs — ops can tune live via UPDATE.

ALTER TABLE personas ADD COLUMN IF NOT EXISTS temperature REAL;

-- Sensible defaults: skeptic cold, grad-student warm, archivist neutral-low.
UPDATE personas SET temperature = 0.6 WHERE key = 'skeptic';
UPDATE personas SET temperature = 0.75 WHERE key = 'methodologist';
UPDATE personas SET temperature = 0.8 WHERE key = 'practitioner';
UPDATE personas SET temperature = 0.85 WHERE key = 'hype';
UPDATE personas SET temperature = 0.9 WHERE key = 'gradstudent';
UPDATE personas SET temperature = 0.5 WHERE key = 'archivist';
-- amplifier persona (added in add_amplifier_persona.sql) — mid range
UPDATE personas SET temperature = 0.8 WHERE key = 'amplifier';
