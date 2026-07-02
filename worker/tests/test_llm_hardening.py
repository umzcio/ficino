"""R10 DUP-7(b): worker's Ollama path gains the api's empty-response guard.

api/services/llm.py's `generate_response` already raises
`RuntimeError("LLM returned empty response")` when Ollama returns HTTP 200
with empty/whitespace content (after the thinking-tag fallback) — see
llm.py:84-85 (now the guard inside `generate_response`'s ollama branch).
worker/lib/claude_client.py's `_generate_ollama` had no equivalent: an
empty-but-200 response silently returned `""` up through `_generate` /
`generate_persona_post`, relying on downstream JSON-parsing code to notice.
This pins the same guard at the source (worker/lib/claude_client.py:64-90
per the brief), matching api's semantics.
"""
import asyncio

import pytest


async def _fast_sleep(_seconds):
    return None


class _FakeEmptyResp:
    status_code = 200

    def json(self):
        return {"message": {"content": "", "thinking": ""}}

    def raise_for_status(self):
        pass


class _FakeAsyncClient:
    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, *a, **k):
        return _FakeEmptyResp()


def test_ollama_empty_response_raises_runtime_error(monkeypatch):
    from lib import claude_client as cc

    monkeypatch.setattr(cc.httpx, "AsyncClient", _FakeAsyncClient)
    monkeypatch.setattr(cc.asyncio, "sleep", _fast_sleep)

    with pytest.raises(RuntimeError, match="LLM returned empty response"):
        asyncio.run(cc._generate_ollama("system", "user"))


class _FakeWhitespaceResp:
    status_code = 200

    def json(self):
        return {"message": {"content": "   \n  "}}

    def raise_for_status(self):
        pass


class _FakeWhitespaceClient:
    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, *a, **k):
        return _FakeWhitespaceResp()


def test_ollama_whitespace_only_response_raises_runtime_error(monkeypatch):
    """Matches api's `.strip()` check — whitespace-only content also counts
    as empty, not just the literal empty string."""
    from lib import claude_client as cc

    monkeypatch.setattr(cc.httpx, "AsyncClient", _FakeWhitespaceClient)
    monkeypatch.setattr(cc.asyncio, "sleep", _fast_sleep)

    with pytest.raises(RuntimeError, match="LLM returned empty response"):
        asyncio.run(cc._generate_ollama("system", "user"))


class _FakeGoodResp:
    status_code = 200

    def json(self):
        return {"message": {"content": "a real answer"}}

    def raise_for_status(self):
        pass


class _FakeGoodClient:
    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, *a, **k):
        return _FakeGoodResp()


def test_ollama_nonempty_response_still_returns_content(monkeypatch):
    """Guard must not false-positive on real content."""
    from lib import claude_client as cc

    monkeypatch.setattr(cc.httpx, "AsyncClient", _FakeGoodClient)
    monkeypatch.setattr(cc.asyncio, "sleep", _fast_sleep)

    out = asyncio.run(cc._generate_ollama("system", "user"))
    assert out == "a real answer"
