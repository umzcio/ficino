"""R10 WORK-1: the auto-tag block calls fetch(...) but ingestion_tasks
never imported it — NameError swallowed by the broad except, so
auto-tagging was silently dead for every ingest.

A monkeypatch-based behavioral test cannot reproduce this bug (setattr
would CREATE the missing module global), so the regression test asserts
the name binding directly; CI's ruff F821 check guards the class.
"""


def test_auto_tag_db_helpers_are_imported():
    import tasks.ingestion_tasks as it

    assert hasattr(it, "fetch"), (
        "ingestion_tasks calls fetch(...) in the auto-tag block; "
        "it must be imported from lib.db (R10 WORK-1)"
    )
    assert hasattr(it, "execute")
