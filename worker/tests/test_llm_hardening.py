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


class _FakeThinkingResp:
    status_code = 200

    def json(self):
        return {"message": {"content": "", "thinking": "reasoned answer"}}

    def raise_for_status(self):
        pass


class _FakeThinkingClient:
    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, *a, **k):
        return _FakeThinkingResp()


def test_ollama_empty_content_with_thinking_falls_back_not_raises(monkeypatch):
    """Pin the ordering: the empty-response guard runs AFTER the qwen-style
    thinking fallback. Empty content + populated thinking must return the
    thinking text, not raise (R10 DUP-7b reviewer Minor)."""
    from lib import claude_client as cc

    monkeypatch.setattr(cc.httpx, "AsyncClient", _FakeThinkingClient)
    monkeypatch.setattr(cc.asyncio, "sleep", _fast_sleep)

    out = asyncio.run(cc._generate_ollama("system", "user"))
    assert out == "reasoned answer"


class _Fake404Resp:
    status_code = 404

    def __init__(self):
        import httpx
        self.request = httpx.Request("POST", "http://fake-ollama:11434/api/chat")

    def json(self):
        return {"error": "model not found"}

    def raise_for_status(self):
        import httpx
        raise httpx.HTTPStatusError(
            "404 Not Found", request=self.request,
            response=httpx.Response(404, request=self.request),
        )


def test_ollama_4xx_is_not_retried(monkeypatch):
    """A 404 (bad model name) is a caller error — must raise after exactly
    ONE attempt with no backoff sleep (R10 DUP-7 follow-up: the retry loop
    previously caught anything raise_for_status threw, including 4xx,
    contradicting the docstring's 'non-retryable 4xx' claim)."""
    import httpx

    from lib import claude_client as cc

    calls: list[int] = []
    sleeps: list[float] = []

    class _Fake404Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, *a, **k):
            calls.append(1)
            return _Fake404Resp()

    async def _recording_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(cc.httpx, "AsyncClient", _Fake404Client)
    monkeypatch.setattr(cc.asyncio, "sleep", _recording_sleep)

    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(cc._generate_ollama("system", "user"))

    assert len(calls) == 1, "4xx must fail fast — one attempt, no retry"
    assert sleeps == [], "no backoff sleep on a non-retryable 4xx"
