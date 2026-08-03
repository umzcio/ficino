"""Plan 017: propose_ordering persists atomically and failures retry.

Covers:
  - lib.db.execute_in_transaction runs all statements in one transaction
    (commit on clean exit, roll back on any failure — nothing half-applied).
  - propose_ordering's persist goes through that single helper (no
    consecutive autocommit execute() calls) with the three expected
    statements in order.
  - A persist failure propagates out of the task body, so the outer
    except's `self.retry` path engages instead of the old log-and-swallow
    (which returned SUCCESS with a possibly chapterless list).
"""
from __future__ import annotations

import json

import pytest


# ---------------------------------------------------------------------------
# lib.db.execute_in_transaction — fake asyncpg pool/conn that mimics
# autocommit semantics: outside a transaction each execute() commits
# immediately; inside conn.transaction() statements are staged and only
# land on a clean context exit (rollback discards them).
# ---------------------------------------------------------------------------


class _FakeTx:
    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        self._conn.in_tx = True
        return self

    async def __aexit__(self, exc_type, exc, tb):
        self._conn.in_tx = False
        if exc_type is None:
            self._conn.committed.extend(self._conn.staged)
        self._conn.staged.clear()
        return False


class _FakeConn:
    def __init__(self, fail_on: str | None = None):
        self.fail_on = fail_on
        self.in_tx = False
        self.staged: list[tuple[str, tuple]] = []
        self.committed: list[tuple[str, tuple]] = []

    def transaction(self):
        return _FakeTx(self)

    async def execute(self, query, *args):
        if self.fail_on and self.fail_on in query:
            raise RuntimeError("boom on third statement")
        if self.in_tx:
            self.staged.append((query, args))
        else:
            # autocommit — lands immediately, no way to roll back
            self.committed.append((query, args))
        return "OK"


class _FakeAcquire:
    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *a):
        return False


class _FakePool:
    def __init__(self, conn):
        self._conn = conn

    def acquire(self):
        return _FakeAcquire(self._conn)


def _patch_pool(monkeypatch, conn):
    from lib import db as db_lib

    async def _fake_ensure_pool():
        return _FakePool(conn)

    monkeypatch.setattr(db_lib, "_ensure_pool", _fake_ensure_pool)
    return db_lib


_STATEMENTS = [
    ("UPDATE reading_lists SET rationale = $1 WHERE id = $2", ("[]", "list-1")),
    ("DELETE FROM reading_list_chapters WHERE reading_list_id = $1", ("list-1",)),
    ("INSERT INTO reading_list_chapters ...", ("list-1", ["p1"])),
]


def test_execute_in_transaction_commits_all_statements(monkeypatch):
    from lib.db import execute_in_transaction

    conn = _FakeConn()
    _patch_pool(monkeypatch, conn)

    execute_in_transaction(_STATEMENTS)

    assert conn.committed == _STATEMENTS, (
        "all statements must commit exactly once, in order"
    )


def test_execute_in_transaction_rolls_back_on_failure(monkeypatch):
    """A failure on the third statement must roll back the first two —
    this is the atomicity plan 017 adds. If the transaction wrapper is
    removed, the fake's autocommit semantics land the UPDATE/DELETE
    immediately and this test fails."""
    from lib.db import execute_in_transaction

    conn = _FakeConn(fail_on="INSERT INTO reading_list_chapters")
    _patch_pool(monkeypatch, conn)

    with pytest.raises(RuntimeError, match="boom on third statement"):
        execute_in_transaction(_STATEMENTS)

    assert conn.committed == [], (
        "nothing may commit when any statement in the transaction fails"
    )


# ---------------------------------------------------------------------------
# tasks.reading_list_tasks.propose_ordering — persist via the helper,
# failure reaches the Celery retry path.
# ---------------------------------------------------------------------------

_P1 = "11111111-1111-1111-1111-111111111111"
_P2 = "22222222-2222-2222-2222-222222222222"
_LIST_ID = "33333333-3333-3333-3333-333333333333"


def _paper_rows():
    return [
        {
            "id": _P1, "title": "Foundations", "authors": ["A"],
            "year": 2001, "filename": "a.pdf", "chunks": ["chunk a"],
        },
        {
            "id": _P2, "title": "Applications", "authors": ["B"],
            "year": 2002, "filename": "b.pdf", "chunks": ["chunk b"],
        },
    ]


def _llm_response(**_kwargs):
    return json.dumps([
        {"paper_id": _P1, "position": 1, "rationale": "first"},
        {"paper_id": _P2, "position": 2, "rationale": "second"},
    ])


def _patch_task_harness(monkeypatch, rt):
    """Stub everything propose_ordering touches before the persist block."""
    monkeypatch.setattr(rt, "apply_provider_settings", lambda uid: {})
    monkeypatch.setattr(rt, "fetch", lambda *a, **kw: _paper_rows())
    monkeypatch.setattr(rt.claude_client, "generate_text_sync", _llm_response)


def test_propose_ordering_persists_in_one_transaction(monkeypatch):
    """The persist must be a single execute_in_transaction call carrying
    UPDATE + DELETE + CHAPTER_INSERT_SQL — not three autocommit execute()
    calls (the pre-plan-017 shape this guards against regressing to)."""
    import tasks.reading_list_tasks as rt

    _patch_task_harness(monkeypatch, rt)

    tx_calls: list[list[tuple[str, tuple]]] = []
    monkeypatch.setattr(
        rt, "execute_in_transaction", lambda statements: tx_calls.append(statements)
    )
    autocommit_calls: list[tuple] = []
    monkeypatch.setattr(
        rt, "execute", lambda *a, **kw: autocommit_calls.append(a)
    )

    result = rt.propose_ordering.apply(
        args=[[_P1, _P2], _LIST_ID],
        kwargs={"user_id": "user-1"},
    )
    assert result.state == "SUCCESS"

    assert autocommit_calls == [], (
        "persist must not use autocommit execute() — the three writes "
        "belong in one transaction"
    )
    assert len(tx_calls) == 1, "exactly one atomic persist per task run"
    statements = tx_calls[0]
    assert len(statements) == 3
    assert statements[0][0].startswith("UPDATE reading_lists SET paper_sequence")
    assert statements[0][1] == ([_P1, _P2], statements[0][1][1], _LIST_ID)
    assert json.loads(statements[0][1][1])[0]["rationale"] == "first"
    assert statements[1][0].startswith("DELETE FROM reading_list_chapters")
    assert statements[1][1] == (_LIST_ID,)
    from ficino_shared.constants import CHAPTER_INSERT_SQL
    assert statements[2] == (CHAPTER_INSERT_SQL, (_LIST_ID, [_P1, _P2]))


def test_propose_ordering_persist_failure_propagates_to_retry(monkeypatch):
    """With the persist raising, the exception must reach the task's outer
    except (which calls self.retry while retries remain) — the old
    try/except-log-only block turned this exact scenario into a silent
    SUCCESS with a chapterless list."""
    import tasks.reading_list_tasks as rt

    _patch_task_harness(monkeypatch, rt)

    def _failing_persist(statements):
        raise RuntimeError("db gone mid-persist")

    monkeypatch.setattr(rt, "execute_in_transaction", _failing_persist)

    result = rt.propose_ordering.apply(
        args=[[_P1, _P2], _LIST_ID],
        kwargs={"user_id": "user-1"},
        retries=0,  # 0 < max_retries=2 -> outer handler takes the retry path
    )
    assert result.state != "SUCCESS", (
        "a persist failure must NOT be swallowed into a successful result — "
        "it must reach the outer handler so Celery retries the task"
    )
