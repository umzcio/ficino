"""Load user settings from DB for use in worker tasks."""

import json
from lib.db import fetchrow

STUB_USER_ID = "00000000-0000-0000-0000-000000000000"

DEFAULTS = {
    "llm_provider": "ollama",
    "embed_provider": "ollama",
    "ollama_llm_model": "qwen3.5:latest",
    "ollama_embed_model": "bge-m3:latest",
    "ollama_vision_model": "gemma4:latest",
    "personas_enabled": {
        "skeptic": True,
        "hype": True,
        "practitioner": True,
        "methodologist": True,
        "gradstudent": True,
    },
    "persona_temperature": 0.8,
    "posts_per_generation": 12,
    "post_type_weights": {
        "post": 0.35,
        "thread": 0.10,
        "quote": 0.20,
        "reply": 0.25,
        "figure": 0.10,
    },
    "auto_generate_on_upload": False,
    "extraction_mode": "auto",
    "chunk_max_tokens": 800,
}


def get_user_settings() -> dict:
    """Fetch and merge user settings with defaults."""
    row = fetchrow(
        "SELECT settings FROM user_settings WHERE user_id = $1",
        STUB_USER_ID,
    )
    user = {}
    if row:
        user = row["settings"]
        if isinstance(user, str):
            user = json.loads(user)

    merged = {**DEFAULTS}
    for key, value in user.items():
        if key in merged and isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key] = {**merged[key], **value}
        else:
            merged[key] = value
    return merged
