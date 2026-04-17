# Phase 4 — Per-Persona Temperature Tuning

Status: applied to live DB, worker rebuilt and restarted clean.

## Schema migration

File: `/projects/ficino/infra/postgres/add_persona_temperature.sql`

```sql
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
```

Applied via:
```
docker exec -i ficino-postgres psql -U ficino -d ficino < /projects/ficino/infra/postgres/add_persona_temperature.sql
```

Output: `ALTER TABLE`, then 7 x `UPDATE 1` (one hit per persona key — all seven seeded personas are present).

Verification:

```
docker exec ficino-postgres psql -U ficino -d ficino -c "SELECT key, temperature FROM personas ORDER BY sort_order;"
```

```
      key      | temperature
---------------+-------------
 skeptic       |         0.6
 hype          |        0.85
 practitioner  |         0.8
 methodologist |        0.75
 gradstudent   |         0.9
 archivist     |         0.5
 amplifier     |         0.8
(7 rows)
```

All seven personas now carry a non-null `temperature`. Future rows (or ops wiping one back to null) will fall through to the user's `persona_temperature` setting.

## File diffs summary

- `worker/lib/persona.py`: +2 / −1
  - SELECT list now includes `temperature`.
  - Cache dict carries `temperature` per persona (may be None).
- `worker/tasks/persona_tasks.py`: +4 / −0
  - Two call sites (generate_feed inner loop, regenerate_post) each gained a 2-line per-persona override lookup before the `claude_client.generate_persona_post_sync(...)` call.
- `.env.example`: +3 / −0
  - Added a 2-line explanatory comment (plus blank separator) at the top of the file documenting that temperature is tunable per-persona via the DB column.

## Call sites that got the per-persona override

Both in `/projects/ficino/worker/tasks/persona_tasks.py`:

1. `generate_feed` — inner loop around line 387. Uses `persona_key` from the plan assignment.
2. `regenerate_post` — around line 576. Uses `persona_key` loaded from the existing post.

Pattern in both places:

```python
persona_temp = persona_lib.get_personas().get(persona_key, {}).get("temperature")
call_temp = persona_temp if persona_temp is not None else temperature
post_data = claude_client.generate_persona_post_sync(system_prompt, user_prompt, temperature=call_temp)
```

The `.get(persona_key, {}).get("temperature")` chain is tolerant of unknown persona keys — it returns `None` and cleanly falls back to the user setting.

## Surprises / notes

- There is a **third** `generate_persona_post_sync` call site in `worker/tasks/reading_list_tasks.py:272` that still passes the flat user-setting `temperature`. Scope for this task was persona_tasks.py only, so it was left alone — but when reading-list generation is tuned next, apply the same per-persona override there for consistency. Summary_tasks.py also calls `generate_persona_post_sync` but without any temperature argument (uses the library default); no change needed.
- `get_personas()` already has a 1-hour TTL cache from Phase 3, so ops-level `UPDATE personas SET temperature = ...` edits take up to an hour to propagate to a long-running worker. `invalidate_personas_cache()` can be called to force a refresh if needed. This matches the behavior documented in the task spec ("ops can tune live via UPDATE") with the understood hour-bounded staleness.

## Verification

- AST parse of both edited Python files: `OK`.
- Migration applied, 7 rows updated, SELECT shown above.
- `docker compose build worker` succeeded.
- `docker compose up -d --force-recreate worker` recreated the container.
- `docker logs ficino-worker --tail 20` shows clean boot: connected to redis, mingle complete, `celery@... ready`, all tasks registered including `tasks.persona_tasks.generate_feed` and `tasks.persona_tasks.regenerate_post`.
