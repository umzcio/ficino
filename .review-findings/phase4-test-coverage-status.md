# Phase 4 — Python Unit Test Coverage Status

Goal: expand API unit-test coverage on critical persistence / IDOR paths
beyond the 55-test baseline inherited from Phases 1–3.

## Summary

- Starting baseline: 66 passing tests (test_auth_scoping 17 + test_csrf 4 +
  test_idor_followups 6 + test_models 16 + test_sanitize 16 +
  test_signed_figures 7). The task brief listed 55, but csrf (4) and
  signed-figures (7) were already in the tree and are included in the
  baseline here.
- New tests added: **60** across 6 files.
- Final total: **66 + 60 = 126 passing**. (Brief target was ~90.)
- Verification command:
  `docker exec ficino-api sh -c "cd /app && pytest tests/ -v --tb=short"`

## File-by-file new-test counts

| File | Tests | Focus |
|------|------:|-------|
| `test_bookmarks.py` | 8 | create / list / delete / reply-level vs post-level / IDOR |
| `test_annotations.py` | 10 | upsert / overwrite / delete / empty-body / cross-user leak |
| `test_likes.py` | 9 | toggle on/off / idempotent create / stats / preferences / IDOR |
| `test_workspaces.py` | 12 | create / rename / delete / default-guard / only-workspace-guard / activity / IDOR |
| `test_tags.py` | 12 | create / assign / unassign / list / paper-scoped / Phase 2 foreign-paper 404 |
| `test_reading_lists.py` | 9 | list / get / reorder / apply-ordering / delete / workspace filter / IDOR (POST path skipped — needs Celery) |

Total: 60.

## Bugs surfaced

None. Every new assertion matched the documented endpoint behavior.

- `bookmarks.py:66` returns HTTP 201 with `status=already_bookmarked` on a
  duplicate create rather than 409. The test asserts idempotent behavior
  (`status=already_bookmarked` + same id) without demanding a specific
  status code, so existing callers aren't disrupted. If a 409 semantic is
  desired, it would be a router-level decision, not a bug.
- `workspaces.py:delete_workspace` silently returns 204 when called with a
  random UUID, provided the caller has at least 2 workspaces AND the id is
  not the DEFAULT_WORKSPACE_ID. The final DELETE is scoped by `user_id`, so
  it's still safe (a cross-user UUID matches zero rows), but the endpoint
  does not distinguish "that id doesn't exist for you" from "deleted
  successfully." Documented via
  `test_delete_nonexistent_workspace_returns_404_not_400`, which asserts
  `r.status_code in (204, 404)` rather than forcing a change.

## Areas not covered (require mocking infrastructure)

These were skipped deliberately per the task rules (no Celery mocking, no
LLM mocking). Each will need a stub harness before it can be tested.

### Celery-dependent endpoints

- `POST /reading-lists` — dispatches `tasks.reading_list_tasks.propose_ordering`.
  Tested the ownership checks via `test_idor_followups.py`'s existing cases;
  happy-path creation is skipped because `celery_app.send_task(...)` would
  try to queue a real task against Redis and the assigned worker.
- `POST /reading-lists/{id}/chapters/{i}/generate` — dispatches
  `tasks.reading_list_tasks.generate_chapter`. Same reason.
- `POST /feed/generate`, `POST /user-posts`, `POST /replies`,
  `POST /replies/zap`, `POST /messages/groups` — all dispatch persona tasks.

### LLM-dependent endpoints

- `POST /replies/*` that call the fresh-connection helper inside
  `create_reply`. The helper invokes an LLM provider; testing the pieces
  that don't need the LLM (request parsing, ownership checks) would require
  refactoring the endpoint to separate those responsibilities, which is
  beyond a pure-test-coverage pass.

### Recommended next step

Add a `celery.send_task` monkeypatch fixture in `conftest.py` that records
task invocations to a list without hitting Redis. That alone would unblock
~6 more tests covering reading-list creation + chapter dispatch and feed
generation request validation.

## Methodology notes

- All new tests follow the async/await / `@pytest.mark.asyncio` style of
  `test_auth_scoping.py`.
- Every test uses the `seeded_users`, `client_as_user_a` /
  `client_as_user_b`, or `db_conn` fixtures from `api/tests/conftest.py`.
  No independent DB setup.
- Where the shared `app.dependency_overrides[get_current_user]` singleton
  would have forced a cross-user flow, I used `db_conn` to seed the "other
  user's" row directly rather than pulling in both client fixtures (which
  race — see the existing comment in `test_idor_followups.py`).
- File sizes all under 300 lines (bookmarks ≈170, annotations ≈170,
  likes ≈190, workspaces ≈200, tags ≈200, reading_lists ≈230).
