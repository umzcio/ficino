"""LLM provider helper for API routers.

Reads user settings from DB and merges with env defaults.
Routes LLM calls to the correct provider.
"""

import asyncio
import json

import asyncpg
import httpx
import structlog

from config import settings as env_settings
from constants import STUB_USER_ID
from ficino_shared.settings_schema import DEFAULTS as _SCHEMA_DEFAULTS

logger = structlog.get_logger(__name__)


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
            last_exc = e
            if attempt == 2:
                break
            wait = 2 * (3 ** attempt)  # 2s, 6s, (18s if a 4th attempt existed)
            logger.warn(
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
