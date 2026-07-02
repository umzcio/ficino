"""Tests for R10 BP-10: `record_audit` coverage across destructive endpoints.

BP-10 found an arbitrary subset of destructive endpoints were audited —
deleting one bookmark by id wrote a row, deleting the same bookmark via
`/bookmarks/post/{feed_id}/{post_index}` wrote nothing; the Danger Zone
bulk clears in settings.py (the most destructive actions in the app) wrote
nothing at all. This file locks in the fix two ways:

  1. Two behavioral tests exercise a representative danger-zone clear
     (`clear_all_feeds`, the cheapest one) and a representative keyed
     delete (`delete_bookmark_by_post`, the exact gap BP-10 called out)
     end-to-end against the live audit_log table.
  2. A static sweep asserts `record_audit` appears in the source of every
     other handler BP-10 listed as a gap, without re-running each one
     behaviorally (overkill per the task brief).
"""
from __future__ import annotations

import inspect

import pytest

from tests.conftest import USER_A_ID


# ---------------------------------------------------------------------------
# Behavioral: one danger-zone clear, one keyed delete.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_clear_all_feeds_writes_audit_row(
    client_as_user_a, seeded_users, db_conn,
):
    """POST /settings/clear-feeds records exactly one audit_log row for
    the caller with the documented action name."""
    r = await client_as_user_a.post("/settings/clear-feeds")
    assert r.status_code == 200, r.text

    count = await db_conn.fetchval(
        "SELECT COUNT(*) FROM audit_log WHERE user_id = $1 AND action = $2",
        USER_A_ID, "feed.clear_all",
    )
    assert count == 1


@pytest.mark.asyncio
async def test_delete_bookmark_by_post_writes_audit_row(
    client_as_user_a, seeded_users, db_conn,
):
    """DELETE /bookmarks/post/{feed_id}/{post_index} — the exact gap
    BP-10 flagged (same logical operation as the audited by-id delete,
    but via a composite-key route) — now records an audit row too."""
    feed_id = seeded_users["feed_a"]
    r_create = await client_as_user_a.post("/bookmarks", json={
        "feed_id": feed_id, "post_index": 9, "message_index": -1,
        "post_snapshot": {"t": "post"},
    })
    assert r_create.status_code == 201, r_create.text

    r_del = await client_as_user_a.delete(f"/bookmarks/post/{feed_id}/9")
    assert r_del.status_code == 204, r_del.text

    count = await db_conn.fetchval(
        "SELECT COUNT(*) FROM audit_log WHERE user_id = $1 AND action = $2",
        USER_A_ID, "bookmark.delete",
    )
    assert count == 1


# ---------------------------------------------------------------------------
# Static sweep: every other BP-10 gap handler calls record_audit somewhere
# in its own source.
# ---------------------------------------------------------------------------

# (module path, function name) for every handler BP-10 listed as unaudited,
# minus the two exercised behaviorally above.
_AUDITED_GAP_HANDLERS = [
    ("routers.settings", "clear_all_summaries"),
    ("routers.settings", "clear_all_user_posts"),
    ("routers.settings", "clear_everything"),
    ("routers.settings", "clear_all_papers"),
    ("routers.workspaces", "delete_workspace"),
    ("routers.user_posts", "delete_user_post"),
    ("routers.likes", "delete_like"),
    ("routers.personas", "delete_persona_dm_message"),
    ("routers.personas", "clear_persona_dm"),
    ("routers.replies", "delete_reply_message"),
]


def test_bp10_gap_handlers_call_record_audit():
    import importlib

    offenders: list[str] = []
    for mod_name, func_name in _AUDITED_GAP_HANDLERS:
        mod = importlib.import_module(mod_name)
        func = getattr(mod, func_name, None)
        assert func is not None, f"{mod_name}.{func_name} does not exist"
        source = inspect.getsource(func)
        if "record_audit" not in source:
            offenders.append(f"{mod_name}.{func_name}")

    assert offenders == [], (
        "Handler(s) still missing record_audit (R10 BP-10 gap): " + str(offenders)
    )
