"""Fresh-path generate_feed idempotency under Celery redelivery (plan 018).

acks_late redelivery reuses request.id, so the fresh path derives a
deterministic uuid5 feed id and short-circuits via an entry guard (with an
ON CONFLICT backstop on the INSERT). These tests stub the whole LLM /
persona pipeline at the tasks.persona_tasks namespace (same pattern as the
other worker unit tests) and back the feeds table with an in-memory fake.
"""
import json
import uuid

import lib.db
import lib.embedder
import pytest
from tasks import persona_tasks as pt


class _FakeFeedsTable:
    """In-memory stand-in for the feeds table, enforcing the PK on id."""

    def __init__(self):
        self.rows: dict[str, dict] = {}

    def fetchrow(self, query, *args):
        assert "FROM feeds" in query, f"unexpected fetchrow: {query[:80]}"
        feed_id, user_id = args
        row = self.rows.get(feed_id)
        if row is None or row["user_id"] != user_id:
            return None
        return {"post_count": row["post_count"]}

    def execute(self, query, *args):
        assert query.lstrip().startswith("INSERT INTO feeds"), (
            f"unexpected execute: {query[:80]}"
        )
        feed_id = args[0]
        # INSERT arg order: id, user_id, corpus_id, tag_filter, posts,
        # paper_count, post_count, generation_duration_ms
        row = {"user_id": args[1], "posts": args[4], "post_count": args[6]}
        if feed_id in self.rows:
            if "DO UPDATE" in query:
                self.rows[feed_id] = row  # upsert replaces the feed content
            elif "ON CONFLICT" in query:
                return  # DO NOTHING
            else:
                raise AssertionError("duplicate feed INSERT without ON CONFLICT")
        else:
            self.rows[feed_id] = row


@pytest.fixture
def stubbed_pipeline(monkeypatch):
    """Stub everything generate_feed touches except the fresh-path control
    flow under test. Returns (feeds_table, llm_call_count_list)."""
    table = _FakeFeedsTable()
    llm_calls = []

    chunks = [
        {"id": f"chunk-{i}", "paper_id": "paper-1", "paper_title": "T",
         "section": "results", "content": f"evidence {i}", "score": 0.5}
        for i in range(5)
    ]

    monkeypatch.setattr(pt, "fetchrow", table.fetchrow)
    monkeypatch.setattr(pt, "execute", table.execute)
    monkeypatch.setattr(pt, "fetch", lambda *a, **k: [])  # no figures
    monkeypatch.setattr(pt, "apply_provider_settings", lambda user_id: {})
    monkeypatch.setattr(pt, "_get_paper_ids_for_corpus",
                        lambda corpus_id, tag_filter, user_id: ["paper-1"])
    monkeypatch.setattr(pt.persona_lib, "resolve_enabled_personas",
                        lambda settings: {"skeptic"})
    monkeypatch.setattr(pt.persona_lib, "get_personas",
                        lambda: {"skeptic": {"temperature": None}})
    monkeypatch.setattr(pt.persona_lib, "get_active_persona_prompts",
                        lambda: {"skeptic": "system"})
    monkeypatch.setattr(pt.persona_lib, "plan_feed_posts",
                        lambda **k: [{"persona": "skeptic", "post_type": "post"},
                                     {"persona": "skeptic", "post_type": "post"}])
    monkeypatch.setattr(pt.persona_lib, "build_post_prompt", lambda **k: "prompt")
    monkeypatch.setattr(pt.persona_lib, "_build_short_cite", lambda c: "T (2024)")
    monkeypatch.setattr(pt.persona_lib, "build_post_sources", lambda *a, **k: [])
    monkeypatch.setattr(pt.persona_lib, "assign_post_category",
                        lambda persona, post_type: "for_you")
    monkeypatch.setattr(pt.retrieval, "_get_retrieval_queries", lambda: {})
    monkeypatch.setattr(pt.retrieval, "retrieve_for_persona",
                        lambda *a, **k: list(chunks))
    monkeypatch.setattr(lib.embedder, "embed_texts_sync",
                        lambda texts, **k: [[0.1] for _ in texts])
    monkeypatch.setattr(lib.db, "executemany", lambda *a, **k: None)
    monkeypatch.setattr(pt.app, "send_task", lambda *a, **k: None)
    monkeypatch.setattr(pt.generate_feed, "update_state", lambda *a, **k: None)

    def _fake_llm(system_prompt, user_prompt, temperature=None):
        llm_calls.append(1)
        return {"content": f"post {len(llm_calls)}"}

    monkeypatch.setattr(pt.claude_client, "generate_persona_post_sync", _fake_llm)

    return table, llm_calls


def _run(task_id):
    return pt.generate_feed.apply(
        kwargs={"user_id": "user-1", "num_posts": 2}, task_id=task_id,
    ).result


def test_fresh_feed_redelivery_is_idempotent(stubbed_pipeline):
    table, llm_calls = stubbed_pipeline

    first = _run("task-123")
    expected_feed_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, "ficino:feed:task-123"))
    assert first["feed_id"] == expected_feed_id
    assert first["post_count"] == 2
    assert len(llm_calls) == 2
    assert list(table.rows) == [expected_feed_id]

    # Redelivery: same request.id → same feed_id, entry guard skips the
    # whole pipeline (no extra LLM calls, no second feed row).
    second = _run("task-123")
    assert second["idempotent"] is True
    assert second["feed_id"] == expected_feed_id
    assert second["post_count"] == 2
    assert len(llm_calls) == 2, "pipeline must not be re-entered on redelivery"
    assert len(table.rows) == 1


def test_fresh_feed_new_dispatch_gets_new_feed_id(stubbed_pipeline):
    table, llm_calls = stubbed_pipeline

    first = _run("task-123")
    second = _run("task-456")

    assert second["feed_id"] != first["feed_id"]
    assert "idempotent" not in second
    assert len(table.rows) == 2
    assert len(llm_calls) == 4


def test_empty_feed_redelivery_does_not_error_or_duplicate(stubbed_pipeline, monkeypatch):
    """The no-papers branch stores an empty feed (post_count=0), which the
    post_count>0 entry guard deliberately ignores — the ON CONFLICT clause
    is what keeps that redelivery from raising a unique violation."""
    table, _ = stubbed_pipeline
    monkeypatch.setattr(pt, "_get_paper_ids_for_corpus",
                        lambda corpus_id, tag_filter, user_id: [])

    first = _run("task-empty")
    second = _run("task-empty")

    assert first["post_count"] == 0 and second["post_count"] == 0
    assert first["feed_id"] == second["feed_id"]
    assert len(table.rows) == 1


def test_empty_attempt_then_successful_redelivery_recovers_posts(
    stubbed_pipeline, monkeypatch,
):
    """Attempt 1 reaches the main-path INSERT with zero posts (every slot
    skipped for lack of chunks) and commits an empty feed, then dies
    pre-ack. The redelivered attempt ignores the post_count=0 row in the
    entry guard, regenerates, and the INSERT's ON CONFLICT DO UPDATE must
    REPLACE the empty row's content rather than discarding the new posts."""
    table, llm_calls = stubbed_pipeline

    chunks = [
        {"id": f"chunk-{i}", "paper_id": "paper-1", "paper_title": "T",
         "section": "results", "content": f"evidence {i}", "score": 0.5}
        for i in range(5)
    ]
    have_chunks = {"ready": False}
    monkeypatch.setattr(
        pt.retrieval, "retrieve_for_persona",
        lambda *a, **k: list(chunks) if have_chunks["ready"] else [],
    )

    first = _run("task-flaky")
    assert first["post_count"] == 0
    assert len(llm_calls) == 0  # no chunks → every slot skipped pre-LLM
    feed_id = first["feed_id"]
    assert table.rows[feed_id]["post_count"] == 0

    have_chunks["ready"] = True
    second = _run("task-flaky")

    assert second["post_count"] == 2
    assert "idempotent" not in second
    assert second["feed_id"] == feed_id
    assert len(table.rows) == 1, "upsert must not create a second feed row"
    assert table.rows[feed_id]["post_count"] == 2
    assert len(json.loads(table.rows[feed_id]["posts"])) == 2
