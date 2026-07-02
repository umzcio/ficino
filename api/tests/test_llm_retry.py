"""R10 DUP-7(a): api's Ollama branch gains the worker's 5xx retry loop.

worker/lib/claude_client.py's `_generate_ollama` retries Ollama 5xx /
connection errors with backoff (2s -> 6s -> 18s) before this task; api's
`services/llm.py.generate_response` had no retry at all, so a transient
Ollama 500 during a reply/zap/interjection call failed the whole request
instead of riding out the blip like the worker's feed-gen path does.

No live httpx harness needed — monkeypatch `httpx.AsyncClient` with a fake
that fails N times then succeeds, same technique as
worker/tests/test_wave3_task_fixes.py's vision-retry tests, adapted to
async-native api code (pytest-asyncio, asyncio_mode=auto per api/pytest.ini).
"""
from __future__ import annotations

import httpx
import pytest

from services import llm as llm_service


async def _fast_sleep(_seconds):
    return None


class _FakeConn:
    """Stand-in asyncpg connection: no user_settings row -> DEFAULTS apply."""

    async def fetchrow(self, *a, **k):
        return None


def _fake_cfg(**overrides):
    cfg = {
        "llm_provider": "ollama",
        "ollama_base_url": "http://fake-ollama:11434",
        "ollama_llm_model": "qwen3.5:latest",
        "claude_model": "claude-sonnet-4-6",
        "anthropic_api_key": "",
    }
    cfg.update(overrides)
    return cfg


class _FakeResp:
    def __init__(self, status_code=200, message=None):
        self.status_code = status_code
        self._message = message or {"content": "hello from ollama"}
        self.request = httpx.Request("POST", "http://fake-ollama:11434/api/chat")

    def json(self):
        return {"message": self._message}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"status {self.status_code}", request=self.request,
                response=httpx.Response(self.status_code, request=self.request),
            )


def _make_fake_client(responses):
    """responses: list of either an Exception instance (to raise) or a
    _FakeResp (to return), consumed in order across calls to post()."""
    calls: list[int] = []

    class _FakeAsyncClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, *a, **k):
            calls.append(1)
            item = responses[len(calls) - 1]
            if isinstance(item, Exception):
                raise item
            return item

    return _FakeAsyncClient, calls


@pytest.mark.asyncio
async def test_ollama_5xx_retries_then_succeeds(monkeypatch):
    """Two 500s then a 200 must succeed — matching the worker's 3-attempt
    retry (R10 DUP-7a)."""
    fake_500 = _FakeResp(status_code=500)
    fake_ok = _FakeResp(status_code=200, message={"content": "recovered"})
    FakeClient, calls = _make_fake_client([fake_500, fake_500, fake_ok])

    async def _fake_get_llm_config(db, user_id=""):
        return _fake_cfg()

    monkeypatch.setattr(llm_service, "get_llm_config", _fake_get_llm_config)
    monkeypatch.setattr(llm_service.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(llm_service.asyncio, "sleep", _fast_sleep)

    result = await llm_service.generate_response(
        _FakeConn(), "system", [{"role": "user", "content": "hi"}],
    )

    assert result == "recovered"
    assert len(calls) == 3, "must retry twice (3 total attempts) before succeeding"


@pytest.mark.asyncio
async def test_ollama_5xx_exhausts_retries_and_raises(monkeypatch):
    """Three consecutive 500s must raise, not retry forever."""
    fake_500 = _FakeResp(status_code=500)
    FakeClient, calls = _make_fake_client([fake_500, fake_500, fake_500])

    async def _fake_get_llm_config(db, user_id=""):
        return _fake_cfg()

    monkeypatch.setattr(llm_service, "get_llm_config", _fake_get_llm_config)
    monkeypatch.setattr(llm_service.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(llm_service.asyncio, "sleep", _fast_sleep)

    with pytest.raises(httpx.HTTPStatusError):
        await llm_service.generate_response(
            _FakeConn(), "system", [{"role": "user", "content": "hi"}],
        )

    assert len(calls) == 3


@pytest.mark.asyncio
async def test_ollama_4xx_is_not_retried(monkeypatch):
    """A 404 (bad model name, wrong path) is a caller error — retrying cannot
    help. Must raise after exactly ONE attempt with no sleep (R10 DUP-7
    follow-up: the first cut of the port retried anything raise_for_status
    threw, including 4xx, contradicting its own docstring)."""
    fake_404 = _FakeResp(status_code=404)
    FakeClient, calls = _make_fake_client([fake_404, fake_404, fake_404])
    sleeps: list[float] = []

    async def _recording_sleep(seconds):
        sleeps.append(seconds)

    async def _fake_get_llm_config(db, user_id=""):
        return _fake_cfg()

    monkeypatch.setattr(llm_service, "get_llm_config", _fake_get_llm_config)
    monkeypatch.setattr(llm_service.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(llm_service.asyncio, "sleep", _recording_sleep)

    with pytest.raises(httpx.HTTPStatusError):
        await llm_service.generate_response(
            _FakeConn(), "system", [{"role": "user", "content": "hi"}],
        )

    assert len(calls) == 1, "4xx must fail fast — one attempt, no retry"
    assert sleeps == [], "no backoff sleep on a non-retryable 4xx"


@pytest.mark.asyncio
async def test_ollama_connect_error_retries_then_succeeds(monkeypatch):
    """Connection errors (Ollama down/restarting) are retried the same as
    5xx — matching claude_client.py's ConnectError handling."""
    fake_ok = _FakeResp(status_code=200, message={"content": "back up"})
    FakeClient, calls = _make_fake_client([
        httpx.ConnectError("blip"), fake_ok,
    ])

    async def _fake_get_llm_config(db, user_id=""):
        return _fake_cfg()

    monkeypatch.setattr(llm_service, "get_llm_config", _fake_get_llm_config)
    monkeypatch.setattr(llm_service.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(llm_service.asyncio, "sleep", _fast_sleep)

    result = await llm_service.generate_response(
        _FakeConn(), "system", [{"role": "user", "content": "hi"}],
    )

    assert result == "back up"
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_ollama_empty_content_still_raises_after_success_status(monkeypatch):
    """A 200 with empty content must still raise RuntimeError (pre-existing
    guard) — retry must not swallow that behavior."""
    fake_empty = _FakeResp(status_code=200, message={"content": ""})
    FakeClient, calls = _make_fake_client([fake_empty])

    async def _fake_get_llm_config(db, user_id=""):
        return _fake_cfg()

    monkeypatch.setattr(llm_service, "get_llm_config", _fake_get_llm_config)
    monkeypatch.setattr(llm_service.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(llm_service.asyncio, "sleep", _fast_sleep)

    with pytest.raises(RuntimeError, match="LLM returned empty response"):
        await llm_service.generate_response(
            _FakeConn(), "system", [{"role": "user", "content": "hi"}],
        )

    assert len(calls) == 1, "empty-but-200 is not retryable — only 5xx/connection errors are"
