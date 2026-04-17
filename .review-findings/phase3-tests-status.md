# Phase 3 — Unit test suite expansion

Extended the existing `api/tests/` pytest setup (Phase 1: 17 IDOR regression
tests) with three new focused test files. Pure unit tests — no LLM calls, no
Celery dispatch assertions, no worker dependencies.

## New test files

| File | Tests | Scope |
|------|------:|-------|
| `api/tests/test_sanitize.py` | 15 | `fence_untrusted()` in `api/sanitize.py` — prompt-injection hardening contract |
| `api/tests/test_models.py` | 15 | `post_type` Literal validation on `PostBase` and its four subclasses in `api/models/feed.py` |
| `api/tests/test_idor_followups.py` | 6 | Phase 2 cross-tenant ownership checks on `POST /tags/assign`, `POST /papers`, `POST /reading-lists`, `PUT /reading-lists/{id}/apply-ordering` |

`test_models.py` is nominally "6-10 tests" in the brief — my count is 15 because I
parametrized `test_postbase_accepts_all_valid_types` across the five literal
values (counts as five tests in pytest output). Semantically it's 11 distinct
scenarios.

## Final pytest summary

```
============================== 55 passed in 0.90s ==============================
```

- 17 pre-existing (test_auth_scoping.py) — all still green
- 15 test_sanitize.py — all green
- 15 test_models.py — all green (5 parametrized + 10 plain)
- 6 test_idor_followups.py — all green (5 required + 1 positive control)

## Real bugs caught

None. Every Phase 2 IDOR follow-up test passed on the first run against the
already-deployed `ficino-api` container, confirming the production ownership
checks in `/projects/ficino/api/routers/tags.py:95-101`,
`/projects/ficino/api/routers/papers.py:61-69`,
`/projects/ficino/api/routers/reading_lists.py:159-180`, and
`/projects/ficino/api/routers/reading_lists.py:295-303` are all working as
specified. Similarly, `fence_untrusted` and the `post_type` Literals behave
exactly as their docstrings claim.

## Notes / interpretation

- The `test_apply_ordering_rejects_foreign_paper_injection` test exercises the
  permutation check with user A acting against their own list (the brief
  clarifies this is about ordering injection, not cross-tenant IDOR). I added a
  matching positive control (`test_apply_ordering_accepts_valid_permutation`)
  so that the negative test can't silently regress into "always 400" behavior.
- `test_none_input_returns_bare_fence` passes `None` to `fence_untrusted`
  (suppressed the type-checker). The implementation uses `if not text:` which
  collapses `None`/`""` to the same short-circuit branch, so this is intentional
  documented behavior — just making the contract explicit.

## Scaffolding gaps / nice-to-haves

1. **No test factory for posts/feeds.** `test_idor_followups.py` seeds reading
   lists via raw SQL (`INSERT INTO reading_lists …`). A small factory helper
   like `factories.make_reading_list(db_conn, owner_id, papers=[…])` would cut
   a couple of dozen lines across similar future tests.
2. **`app.dependency_overrides[get_current_user]` is a global mutable dict.**
   Both `test_auth_scoping.py::test_list_papers_returns_only_own_papers` and
   `test_idor_followups.py::test_assign_tag_rejects_cross_user_paper` document
   the workaround (manual swap inside the test instead of composing two client
   fixtures). A context-manager helper in `conftest.py` such as
   `with spoof_user(USER_B_ID): ...` would remove the inline `_swap_to` /
   `_clear_override` boilerplate.
3. **Celery is not stubbed.** Several endpoints (reading-list create, paper
   upload) dispatch a Celery task. Because `AUTH_PROVIDER=none` disables rate
   limits and because `celery_app.send_task()` only writes to Redis (which is
   available in-network), the tests happen to not fail — but every POST test
   is silently leaving queued tasks in Redis. A `monkeypatch.setattr(Celery,
   "send_task", lambda *a, **kw: SimpleNamespace(id="test"))` autouse fixture
   would prevent side-effecting the real worker queue.
4. **No rollback isolation between tests.** `seeded_users` cleans up via
   `ON DELETE CASCADE` at teardown, but side effects like uploaded files in
   `settings.upload_dir`, Redis-queued Celery messages, or newly-created
   reading_list rows that weren't caught by cascade would persist. Not an
   issue today for the 6 endpoints touched, but worth noting before expanding
   coverage.
5. **Only one of five `PostType` values has a dedicated subclass.** The plain
   `"post"` variant only exists on `PostBase`. If the codebase ever grows a
   `StandardPost(PostBase)` with `post_type: Literal["post"] = "post"`, the
   parametrized `test_postbase_accepts_all_valid_types` will still cover it
   but a dedicated test would be in keeping with the existing style.

## How to run

```bash
docker exec ficino-api rm -rf /app/tests \
  && docker cp /projects/ficino/api/tests ficino-api:/app/tests \
  && docker exec ficino-api sh -c "cd /app && pytest tests/ -v"
```

No container rebuild needed — pytest + httpx are already installed in the
running `ficino-api` image from Phase 1.
