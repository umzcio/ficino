"""R10 API-1 / Round 9 H13: a paper_summaries row with status='error'
(worker retries exhausted, task_id NULL) was returned verbatim forever —
the re-dispatch guard only reset 'generating' rows with a live task_id."""
from __future__ import annotations

import pytest


class _FakeTask:
    id = "fake-task-id"


class _FakeCelery:
    def send_task(self, *args, **kwargs):
        return _FakeTask()


@pytest.mark.asyncio
async def test_error_summary_row_is_redispatched(
    client_as_user_a, seeded_users, db_conn, monkeypatch
):
    from routers import messages

    # R10 API-5/DUP-13: messages.py now dispatches via the shared
    # `celery_client.get_celery`, imported into this module's namespace as
    # `get_celery` — patch that name (not `celery_client.get_celery`) since
    # `messages.py` calls the bare name, which resolves against its own
    # module globals at call time.
    monkeypatch.setattr(messages, "get_celery", lambda: _FakeCelery())

    paper_id = seeded_users["paper_a"]
    await db_conn.execute(
        """INSERT INTO paper_summaries (paper_id, messages, status, task_id)
           VALUES ($1, '[]', 'error', NULL)
           ON CONFLICT (paper_id) DO UPDATE SET messages = '[]', status = 'error', task_id = NULL""",
        paper_id,
    )

    resp = await client_as_user_a.get(f"/messages/papers/{paper_id}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "generating", (
        "an error row must fall through to the dispatch branch, not be "
        "returned as a permanent error (R10 API-1 / R9 H13)"
    )
    assert body["task_id"] == "fake-task-id"

    row = await db_conn.fetchrow(
        "SELECT status, task_id FROM paper_summaries WHERE paper_id = $1", paper_id
    )
    assert row["status"] == "generating"
