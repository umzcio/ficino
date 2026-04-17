# API tests

Regression tests for Phase 1 auth scoping. Run inside the api container.

## Setup

```
docker exec -it ficino-api sh -c "pip install -q -r requirements-dev.txt"
```

(Needs rebuild of `ficino-api` to bake dev deps in, OR install at runtime — the
install-at-runtime path works but is lost on container recreate.)

## Run

```
docker exec -it ficino-api pytest tests/ -v
```

Expected: every test should pass against the current stack. A failure on any
`test_*_rejects_cross_user_*` test means an IDOR regression.

## What's covered

- Phase 1 IDOR fixes across feed.py, papers.py, messages.py, replies.py,
  tags.py, user_posts.py, workspaces.py, search.py.
- Both "list endpoints scope to own user" and "single-resource GETs 404 across
  tenants".
- Two mutation endpoints (delete / regenerate feed post).

## What's not covered yet

- POST /replies, POST /replies/zap — need Celery stubs or mock for
  `services.llm.generate_response`.
- POST /feed/generate — dispatches a Celery task; test would need to mock
  `celery_app.send_task`.
- POST /messages/groups — same.
- Full mutation matrix on tags / bookmarks / annotations / likes.
- The four "authed but no resource-ownership check" follow-ups flagged in
  `phase1-idor-status.md` — these are NOT regressions of Phase 1 work, they're
  new Phase 2 findings.

## Teardown

Fixtures roll back all inserted rows at the end of the session. If a test
crashes hard, run this to clean up:

```sql
DELETE FROM users WHERE email LIKE 'auth-test-%@ficino.dev';
```
