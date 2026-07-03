"""Wave-5 Task 4 (completing W4's ticket): create_group_chat now inserts a
placeholder corpus_syntheses row at dispatch time, mirroring
paper_summaries' status/task_id shape, so GET /messages/groups/{id} can
return generating/error/complete directly instead of 404ing for the whole
generation window. Before this a permanently-failed synthesis (worker
retries exhausted) was indistinguishable from a still-in-flight one — both
were "404 forever" from the frontend's point of view.
"""
from __future__ import annotations

import json
import uuid

import pytest


class _FakeTask:
    id = "fake-task-id"


class _FakeCelery:
    def send_task(self, *args, **kwargs):
        return _FakeTask()


@pytest.mark.asyncio
async def test_create_group_chat_inserts_generating_placeholder(
    client_as_user_a, seeded_users, db_conn, monkeypatch
):
    from routers import messages

    monkeypatch.setattr(messages, "get_celery", lambda: _FakeCelery())

    user_id = seeded_users["user_a"]
    workspace_a = seeded_users["workspace_a"]
    paper_x = str(uuid.uuid4())
    paper_y = str(uuid.uuid4())
    await db_conn.execute(
        "INSERT INTO papers (id, user_id, corpus_id, filename, file_path, status) "
        "VALUES ($1, $2, $3, 'x.pdf', '/tmp/x.pdf', 'complete'), "
        "      ($4, $5, $6, 'y.pdf', '/tmp/y.pdf', 'complete')",
        paper_x, user_id, workspace_a,
        paper_y, user_id, workspace_a,
    )

    resp = await client_as_user_a.post(
        "/messages/groups",
        json={"name": "Wave-5 T4 synth", "paper_ids": [paper_x, paper_y]},
    )
    assert resp.status_code == 202
    body = resp.json()
    synthesis_id = body["synthesis_id"]
    assert body["status"] == "generating"
    assert body["task_id"] == "fake-task-id"

    row = await db_conn.fetchrow(
        "SELECT status, task_id, messages FROM corpus_syntheses WHERE id = $1",
        synthesis_id,
    )
    assert row is not None, (
        "create_group_chat must insert a placeholder row at dispatch time, "
        "not wait for the worker's completion upsert (Wave-5 Task 4)"
    )
    assert row["status"] == "generating"
    assert row["task_id"] == "fake-task-id"
    messages = row["messages"]
    if isinstance(messages, str):
        messages = json.loads(messages)
    assert messages == []

    # The GET must return this placeholder's status instead of 404ing.
    get_resp = await client_as_user_a.get(f"/messages/groups/{synthesis_id}")
    assert get_resp.status_code == 200
    get_body = get_resp.json()
    assert get_body["status"] == "generating"
    assert get_body["task_id"] == "fake-task-id"
    assert get_body["messages"] == []

    await db_conn.execute("DELETE FROM corpus_syntheses WHERE id = $1", synthesis_id)


@pytest.mark.asyncio
async def test_get_group_chat_returns_generating_not_404(
    client_as_user_a, seeded_users, db_conn
):
    user_id = seeded_users["user_a"]
    paper_a = seeded_users["paper_a"]
    synthesis_id = str(uuid.uuid4())
    await db_conn.execute(
        """INSERT INTO corpus_syntheses (id, user_id, name, paper_ids, messages, status, task_id)
           VALUES ($1, $2, 'Pending synth', $3, '[]', 'generating', 'task-abc')""",
        synthesis_id, user_id, [paper_a],
    )

    resp = await client_as_user_a.get(f"/messages/groups/{synthesis_id}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "generating"
    assert body["task_id"] == "task-abc"
    assert body["messages"] == []

    await db_conn.execute("DELETE FROM corpus_syntheses WHERE id = $1", synthesis_id)


@pytest.mark.asyncio
async def test_get_group_chat_returns_error_not_404(
    client_as_user_a, seeded_users, db_conn
):
    """A worker that exhausted its retries marks the row status='error' —
    the GET must surface that as a real, distinguishable failure state
    instead of the pre-fix indefinite 404 (the whole point of this ticket)."""
    user_id = seeded_users["user_a"]
    paper_a = seeded_users["paper_a"]
    synthesis_id = str(uuid.uuid4())
    await db_conn.execute(
        """INSERT INTO corpus_syntheses (id, user_id, name, paper_ids, messages, status, task_id)
           VALUES ($1, $2, 'Failed synth', $3, '[]', 'error', NULL)""",
        synthesis_id, user_id, [paper_a],
    )

    resp = await client_as_user_a.get(f"/messages/groups/{synthesis_id}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "error"
    assert "task_id" not in body

    await db_conn.execute("DELETE FROM corpus_syntheses WHERE id = $1", synthesis_id)


@pytest.mark.asyncio
async def test_get_group_chat_complete_row_reports_complete_status(
    client_as_user_a, seeded_users, db_conn
):
    """Legacy rows (and freshly-completed ones) must still work — status
    defaults to 'complete' and the messages/papers shape is unchanged."""
    user_id = seeded_users["user_a"]
    paper_a = seeded_users["paper_a"]
    synthesis_id = str(uuid.uuid4())
    messages = json.dumps([{"role": "synthesis", "type": "summary", "content": "done"}])
    await db_conn.execute(
        """INSERT INTO corpus_syntheses (id, user_id, name, paper_ids, messages)
           VALUES ($1, $2, 'Done synth', $3, $4)""",
        synthesis_id, user_id, [paper_a], messages,
    )

    resp = await client_as_user_a.get(f"/messages/groups/{synthesis_id}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "complete"
    assert len(body["messages"]) == 1
    assert "task_id" not in body

    await db_conn.execute("DELETE FROM corpus_syntheses WHERE id = $1", synthesis_id)


@pytest.mark.asyncio
async def test_get_group_chat_missing_row_still_404s(client_as_user_a, seeded_users):
    """404 stays reserved for a synthesis_id with no row at all."""
    resp = await client_as_user_a.get(f"/messages/groups/{uuid.uuid4()}")
    assert resp.status_code == 404
