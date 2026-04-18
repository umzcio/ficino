"""LLM provider helper for API routers.

Reads user settings from DB and merges with env defaults.
Routes LLM calls to the correct provider.
"""

import json

import asyncpg
import httpx
import structlog

from config import settings as env_settings
from constants import STUB_USER_ID

logger = structlog.get_logger(__name__)


async def get_llm_config(db: asyncpg.Connection, user_id: str = "") -> dict[str, str]:
    """Load LLM config merged from env defaults + user DB settings."""
    config = {
        "llm_provider": env_settings.llm_provider,
        "ollama_base_url": env_settings.ollama_base_url,
        "ollama_llm_model": env_settings.ollama_llm_model,
        "anthropic_api_key": env_settings.anthropic_api_key,
        "claude_model": env_settings.claude_model,
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
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f"{cfg['ollama_base_url']}/api/chat",
                json={
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
            resp.raise_for_status()
            content = resp.json()["message"]["content"]
            if not content and resp.json()["message"].get("thinking"):
                content = resp.json()["message"]["thinking"]
            return content
    else:
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=cfg["anthropic_api_key"], timeout=120.0)
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
