"""R10 Wave-3 Task 4: WORK-7, WORK-8, WORK-9, WORK-17.

Four independent worker fixes, each with its own RED-first test:
  - WORK-7:  generate_chapter must sync posts into the feed_posts search index.
  - WORK-8:  summary/synthesis JSON parsing must drop non-dict message elements.
  - WORK-9:  vision page extraction must retry transient HTTP failures.
  - WORK-17: persona fallback must exclude reply-only (feed_eligible=false) personas.
"""
import asyncio
import inspect

import httpx


def test_generate_chapter_writes_feed_posts_index():
    """R10 WORK-7: reading-list chapter posts must be synced into feed_posts
    (the search index) the same way generate_feed does, or chapter content
    is invisible to /search once SEARCH_USE_NORMALIZED_POSTS is on."""
    from tasks.reading_list_tasks import generate_chapter

    src = inspect.getsource(generate_chapter)
    assert "_write_feed_posts_index" in src, (
        "generate_chapter must call _write_feed_posts_index after the feeds "
        "upsert so chapter posts land in the search index (R10 WORK-7)"
    )


def test_coerce_messages_drops_non_dict_elements():
    """R10 WORK-8: a parsed JSON array of bare strings (or a mix of dicts and
    junk) must not pass through to persistence untouched — frontend consumers
    read message.role / message.content, so non-dict elements must be
    filtered out before the caller's `if not messages:` fallback runs."""
    from tasks.summary_tasks import _coerce_messages

    assert _coerce_messages(["a", "b"]) == []
    assert _coerce_messages([{"role": "x", "content": "hi"}, "junk", {"content": ""}]) == [
        {"role": "x", "content": "hi"}
    ]


async def _fast_sleep(_seconds):
    return None


def test_ollama_page_extract_retries_transient_failures(monkeypatch):
    """R10 WORK-9: a transient ConnectError on the ollama vision endpoint
    must be retried (2 failures then success), not abort the whole paper.

    _extract_page_ollama is `async def` and uses `httpx.AsyncClient` (not
    the sync `httpx.Client` in the brief's fake), so the fake and the call
    site are adapted to that actual shape: async context manager, async
    `post`, driven via `asyncio.run`. The retry-count assertion (2 failures
    then success, result returned) is unchanged.
    """
    from lib import vision_extractor as vx

    calls = []

    class _FakeResp:
        status_code = 200

        def json(self):
            return {"message": {"content": "page text"}}

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
            calls.append(1)
            if len(calls) < 3:
                raise httpx.ConnectError("blip")
            return _FakeResp()

    monkeypatch.setattr(vx.httpx, "AsyncClient", _FakeAsyncClient)
    monkeypatch.setattr(vx.asyncio, "sleep", _fast_sleep)

    out = asyncio.run(vx._extract_page_ollama(b"fake-png-bytes", 1))
    assert out == "page text"
    assert len(calls) == 3


def test_claude_page_extract_retries_transient_failures(monkeypatch):
    """R10 WORK-9: the Claude Vision SDK call must get the same 3-attempt
    retry as the ollama path. Vision extraction is the priciest worker code
    path; without retry, one transient blip on page N re-bills every prior
    page's vision spend when Celery re-runs the whole paper.
    """
    import anthropic

    from lib import vision_extractor as vx

    calls = []
    fake_request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")

    class _FakeContentBlock:
        text = "page text"

    class _FakeResponse:
        content = [_FakeContentBlock()]

    class _FakeMessages:
        async def create(self, *a, **k):
            calls.append(1)
            if len(calls) < 3:
                raise anthropic.APIConnectionError(request=fake_request)
            return _FakeResponse()

    class _FakeAsyncAnthropic:
        def __init__(self, *a, **k):
            self.messages = _FakeMessages()

    monkeypatch.setattr(anthropic, "AsyncAnthropic", _FakeAsyncAnthropic)
    monkeypatch.setattr(vx.asyncio, "sleep", _fast_sleep)

    out = asyncio.run(vx._extract_page_claude(b"fake-png-bytes", 1))
    assert out == "page text"
    assert len(calls) == 3
