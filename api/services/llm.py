"""LLM provider helper for API routers.

Reads user settings from DB and merges with env defaults.
Routes LLM calls to the correct provider.
"""

import asyncio
import json

import asyncpg
import httpx
import structlog
from fastapi import HTTPException

from config import settings as env_settings
from constants import STUB_USER_ID
from ficino_shared.settings_schema import DEFAULTS as _SCHEMA_DEFAULTS

logger = structlog.get_logger(__name__)


def llm_error_to_http(exc: BaseException, *, event: str = "llm_call_failed") -> HTTPException:
    """Map an exception raised by `generate_response` to the graded HTTPException
    the API returns for LLM failures.

    R10 BP-1: this mapping previously lived duplicated verbatim in
    `personas.send_persona_dm` and `replies.zap_response` (diffed identical
    except for the structlog event name passed to `logger.warn`/`.error` —
    no other drift, so this is a straight move, not a reconciliation).
    `create_reply`'s main-persona `asyncio.gather` path collapsed every
    failure into a blanket 500 instead of using this grading; it now calls
    this too. `event` lets each of the three call sites keep its own
    structlog event name for grep-driven debugging while sharing the
    status-code logic.

    Grading (unchanged from the original duplicated blocks):
      - asyncio.TimeoutError -> 504 (client should retry)
      - httpx connect/read/connect-timeout -> 503 (provider unreachable)
      - httpx.HTTPStatusError, upstream 4xx -> 502; upstream 5xx -> 503
      - ValueError/KeyError/TypeError -> 400 (bad input surfaced as LLM error)
      - anything else -> 500
    """
    if isinstance(exc, asyncio.TimeoutError):
        logger.warning(event, error=str(exc), reason="timeout")
        return HTTPException(status_code=504, detail="LLM request timed out. Try again.")
    if isinstance(exc, (httpx.ConnectError, httpx.ReadTimeout, httpx.ConnectTimeout)):
        logger.warning(event, error=str(exc), reason="llm_unreachable")
        return HTTPException(status_code=503, detail="LLM provider unreachable. Try again in a moment.")
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        logger.warning(event, error=str(exc), reason="llm_http_error", upstream_status=status)
        if 400 <= status < 500:
            return HTTPException(status_code=502, detail="LLM provider rejected our request.")
        return HTTPException(status_code=503, detail="LLM provider error. Try again in a moment.")
    if isinstance(exc, (ValueError, KeyError, TypeError)):
        logger.warning(event, error=str(exc), reason="bad_input")
        return HTTPException(status_code=400, detail=f"Invalid input: {str(exc)[:200]}")
    logger.error(event, error=str(exc), error_type=type(exc).__name__)
    return HTTPException(status_code=500, detail="Internal error. See server logs.")


async def get_llm_config(db: asyncpg.Connection, user_id: str = "") -> dict[str, str]:
    """Load LLM config merged from env defaults + user DB settings."""
    config = {
        "llm_provider": str(_SCHEMA_DEFAULTS["llm_provider"]),
        "ollama_base_url": env_settings.ollama_base_url,  # env-only: SSRF guard
        "ollama_llm_model": str(_SCHEMA_DEFAULTS["ollama_llm_model"]),
        "anthropic_api_key": str(_SCHEMA_DEFAULTS["anthropic_api_key"]),
        "claude_model": str(_SCHEMA_DEFAULTS["claude_model"]),
    }

    # `ollama_base_url` is deliberately NOT user-overridable: a user-controlled
    # URL here makes every downstream LLM call a POST to the attacker-chosen
    # host (authenticated SSRF). It comes from env only.
    USER_OVERRIDABLE = {"llm_provider", "ollama_llm_model", "anthropic_api_key", "claude_model"}

    row = await db.fetchrow(
        "SELECT settings FROM user_settings WHERE user_id = $1",
        user_id or STUB_USER_ID,
    )
    if row:
        user = row["settings"]
        if isinstance(user, str):
            user = json.loads(user)
        for key in USER_OVERRIDABLE:
            if key in user and user[key]:
                config[key] = str(user[key])

    return config


async def _post_ollama_chat_with_retry(
    cfg: dict[str, str], payload: dict, timeout: float = 120.0,
) -> httpx.Response:
    """POST to Ollama's /api/chat with exponential backoff on transient
    failures (connection errors and 5xx responses).

    Ported from worker/lib/claude_client.py's `_generate_ollama` (R10
    DUP-7a) — the worker's feed-generation path already rode out Ollama
    blips this way; the api's reply/zap/interjection path had no retry at
    all, so the same transient 500 that the worker shrugs off failed the
    api request outright. Same shape: 3 attempts, backoff 2s -> 6s ->
    (18s if a 4th attempt existed), async via `asyncio.sleep`. 4xx and
    JSON/parse errors are NOT retried — only connection errors and 5xx.
    """
    last_exc: Exception | None = None
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(
                    f"{cfg['ollama_base_url']}/api/chat", json=payload,
                )
                if 500 <= resp.status_code < 600:
                    # Server-side transient — retryable
                    raise httpx.HTTPStatusError(
                        f"ollama 5xx: {resp.status_code}",
                        request=resp.request, response=resp,
                    )
                resp.raise_for_status()
                return resp
        except (httpx.ConnectError, httpx.ReadTimeout, httpx.HTTPStatusError) as e:
            if isinstance(e, httpx.HTTPStatusError) and e.response.status_code < 500:
                raise  # 4xx = caller error (bad model name etc.) — retrying can't help
            last_exc = e
            if attempt == 2:
                break
            wait = 2 * (3 ** attempt)  # 2s, 6s, (18s if a 4th attempt existed)
            logger.warning(
                "ollama_transient_error_retrying",
                attempt=attempt + 1, wait_seconds=wait, error=str(e)[:120],
            )
            await asyncio.sleep(wait)
    assert last_exc is not None
    raise last_exc


async def generate_response(
    db: asyncpg.Connection,
    system: str,
    messages: list[dict[str, str]],
    max_tokens: int = 512,
    temperature: float = 0.7,
    user_id: str = "",
) -> str:
    """Generate an LLM response using the user's configured provider."""
    cfg = await get_llm_config(db, user_id=user_id)

    if cfg["llm_provider"] == "ollama":
        resp = await _post_ollama_chat_with_retry(
            cfg,
            {
                "model": cfg["ollama_llm_model"],
                "messages": [
                    {"role": "system", "content": system},
                    *messages,
                ],
                "stream": False,
                "think": False,
                "options": {"temperature": temperature, "num_predict": max_tokens},
            },
        )
        payload = resp.json()
        content = payload["message"]["content"]
        if not content and payload["message"].get("thinking"):
            content = payload["message"]["thinking"]
        # Ollama can return HTTP 200 with empty content (model hit
        # num_predict with no text, or whitespace-only). Raise here so
        # callers see a concrete failure instead of persisting an empty
        # bubble into post_replies.messages.
        if not content or not content.strip():
            raise RuntimeError("LLM returned empty response")
        return content
    else:
        import anthropic
        # max_retries=0 pins the SDK off its default of 2 retries. At 120s
        # timeout × 3 total attempts (1 + 2 retries) a flaky Anthropic
        # upstream would otherwise hold a uvicorn worker for up to 6
        # minutes; 5 concurrent /replies from one user can pin most of
        # the pool. We already handle transient failures higher up.
        client = anthropic.AsyncAnthropic(
            api_key=cfg["anthropic_api_key"],
            timeout=120.0,
            max_retries=0,
        )
        # Prior code omitted `temperature`, so every Claude call ran at the
        # provider default (~1.0) regardless of the per-persona temperature
        # column. Pass it through so personas keep their distinctive voices.
        resp = await client.messages.create(
            model=cfg["claude_model"],
            max_tokens=max_tokens,
            system=system,
            messages=messages,
            temperature=temperature,
        )
        return resp.content[0].text
