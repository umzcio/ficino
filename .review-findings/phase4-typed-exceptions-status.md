# Phase 4 — Typed HTTP Exception Mapping Status

Replace opaque `except Exception` → `HTTPException(500)` blocks with a typed
ladder across all Ficino API routers.

## Per-file results

| File | Blocks transformed | Status |
|------|--------------------|--------|
| routers/alerts.py | 0 | skipped — no `except Exception` block |
| routers/annotations.py | 0 | skipped — no `except Exception` block |
| routers/bookmarks.py | 0 | skipped — no `except Exception` block |
| routers/citations.py | 0 | skipped — no `except Exception` block |
| routers/feed.py | 0 | skipped — no `except Exception` block |
| routers/likes.py | 0 | skipped — no `except Exception` block |
| routers/messages.py | 0 | skipped — no `except Exception` block |
| routers/papers.py | 0 | skipped — no `except Exception` block |
| routers/personas.py | 1 | verified (ast + pytest) |
| routers/reading_lists.py | 0 | skipped — no `except Exception` block |
| routers/replies.py | 1 | verified (ast + pytest) |
| routers/search.py | 0 | skipped — no `except Exception` block |
| routers/settings.py | 0 | skipped — see note below |
| routers/tags.py | 0 | skipped — no `except Exception` block |
| routers/user_posts.py | 0 | skipped — no `except Exception` block |
| routers/users.py | 0 | skipped — no `except Exception` block |
| routers/workspaces.py | 0 | skipped — no `except Exception` block |

## Blocks intentionally left alone

The task is specifically about blocks that end with
`raise HTTPException(status_code=500, detail=...)`. Two `except Exception`
blocks exist in the codebase that do **not** raise a 500 — they are graceful
fallbacks that return a default value. Per instructions these were left
untouched:

- `routers/replies.py:633` — `except Exception` in the interjection
  preparation helper. Returns `None` to signal "no interjection this time,
  carry on"; not an opaque 500.
- `routers/settings.py:157` — `except Exception` around the Ollama
  `/api/tags` probe. Returns an empty grouped-models dict so the Settings
  UI degrades gracefully when Ollama is offline; not an opaque 500.

These are deliberate soft failures, not error-hiding 500s, so the typed
ladder does not apply.

## Transformations applied

Both transformed blocks wrap `generate_response(...)` (the LLM call) and
follow the same template:

```
except asyncio.TimeoutError as e:        → 504
except (httpx.ConnectError,
        httpx.ReadTimeout,
        httpx.ConnectTimeout) as e:       → 503
except httpx.HTTPStatusError as e:        → 502 (upstream 4xx) / 503 (upstream 5xx)
except (ValueError, KeyError, TypeError): → 400
except Exception as e:                    → 500 (generic message + error_type in log)
```

The original structlog event keys (`zap_failed`, `persona_dm_failed`) are
preserved on every branch. Warn vs. error levels are chosen to match the
severity of the branch (client-/network-visible problems log at warn, true
unknowns log at error with `error_type`).

## Imports added

- `routers/replies.py`: `import httpx` (asyncio and asyncpg were already
  imported).
- `routers/personas.py`: `import asyncio` and `import httpx` (asyncpg was
  already imported).

No other imports were touched.

## Surprises / notes

- No `asyncpg.ForeignKeyViolationError` / `UniqueViolationError` branches
  were needed — neither of the transformed blocks wraps a DB write that
  could raise those. The DB writes in both affected endpoints happen
  **outside** the `try` block (after the LLM call succeeds).
- Only two files needed changes. The vast majority of router code either
  lets FastAPI/Pydantic surface typed errors naturally or uses `HTTPException`
  directly with the correct status code — so the opaque-500 anti-pattern was
  concentrated on LLM call sites.

## Verification

- Each modified file parsed with `ast.parse` — OK.
- Routers copied into the running container and the existing auth-scoping
  suite run:

  ```
  docker cp /projects/ficino/api/routers ficino-api:/app/routers
  docker exec ficino-api sh -c "cd /app && pytest tests/ -v --tb=line 2>&1 | tail -12"
  ```

  Result: **110 passed in 1.70s** (the double-nest case the instructions
  called out — 55 tests collected twice).

No regressions. Ready for container rebuild.
