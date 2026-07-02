"""R10 Wave-3 Task 10 — error contract standardization (BP-1/BP-2/BP-3).

BP-1: `services.llm.llm_error_to_http` is the single exception->status
mapping shared by personas.send_persona_dm, replies.zap_response, and
replies.create_reply's main-persona `asyncio.gather` result (previously
duplicated verbatim between personas.py and replies.py, and blanket-500'd
in create_reply).
"""
from __future__ import annotations

import asyncio

import httpx
import pytest

from services.llm import llm_error_to_http


# ---------------------------------------------------------------------------
# BP-1: llm_error_to_http unit tests
# ---------------------------------------------------------------------------

def test_timeout_error_maps_to_504():
    exc = llm_error_to_http(asyncio.TimeoutError())
    assert exc.status_code == 504


def test_connect_error_maps_to_503():
    exc = llm_error_to_http(httpx.ConnectError("x"))
    assert exc.status_code == 503


def test_value_error_maps_to_400():
    exc = llm_error_to_http(ValueError("x"))
    assert exc.status_code == 400


def test_generic_exception_maps_to_500():
    exc = llm_error_to_http(RuntimeError("x"))
    assert exc.status_code == 500


def test_upstream_4xx_http_status_error_maps_to_502():
    request = httpx.Request("POST", "http://fake/api/chat")
    resp = httpx.Response(400, request=request)
    exc = llm_error_to_http(httpx.HTTPStatusError("bad request", request=request, response=resp))
    assert exc.status_code == 502


def test_upstream_5xx_http_status_error_maps_to_503():
    request = httpx.Request("POST", "http://fake/api/chat")
    resp = httpx.Response(500, request=request)
    exc = llm_error_to_http(httpx.HTTPStatusError("server error", request=request, response=resp))
    assert exc.status_code == 503


def test_event_name_is_independent_of_mapping():
    """Each call site keeps its own structlog event name (personas.py's
    "persona_dm_failed" vs replies.py's "zap_failed"/"reply_generation_failed")
    without affecting the status-code grading."""
    exc_a = llm_error_to_http(ValueError("x"), event="persona_dm_failed")
    exc_b = llm_error_to_http(ValueError("x"), event="reply_generation_failed")
    assert exc_a.status_code == exc_b.status_code == 400


# ---------------------------------------------------------------------------
# BP-1: create_reply's gather path now uses the graded mapping, not a
# blanket 500.
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_create_reply_main_persona_timeout_maps_to_504(client_as_user_a, seeded_users, monkeypatch):
    from routers import replies as replies_router

    async def _raise_timeout(*a, **k):
        raise asyncio.TimeoutError()

    monkeypatch.setattr(replies_router, "generate_response", _raise_timeout)

    r = await client_as_user_a.post(
        "/replies",
        json={
            "feed_id": seeded_users["feed_a"],
            "post_index": 0,
            "persona_key": "skeptic",
            "user_message": "hello",
            "post_content": "some post content",
        },
    )
    # Previously a blanket 500 ("Failed to generate persona response");
    # now graded the same as zap_response/send_persona_dm (R10 BP-1).
    assert r.status_code == 504, r.text


@pytest.mark.asyncio
async def test_create_reply_main_persona_bad_input_maps_to_400(client_as_user_a, seeded_users, monkeypatch):
    from routers import replies as replies_router

    async def _raise_value_error(*a, **k):
        raise ValueError("bad prompt")

    monkeypatch.setattr(replies_router, "generate_response", _raise_value_error)

    r = await client_as_user_a.post(
        "/replies",
        json={
            "feed_id": seeded_users["feed_a"],
            "post_index": 0,
            "persona_key": "skeptic",
            "user_message": "hello",
            "post_content": "some post content",
        },
    )
    assert r.status_code == 400, r.text
