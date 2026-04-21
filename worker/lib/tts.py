"""ElevenLabs TTS client for feed audio playback.

Each persona maps to a distinct preset voice so playback sounds like
different speakers on a panel, not one narrator reading labeled lines.
The voice_id map is static — changing a persona's voice is a code-level
decision, not a per-user setting, because the persona's "voice" is part
of its identity (same way its system prompt is).

The seven IDs below are all first-gen ElevenLabs preset voices
(available on the free tier and stable since 2023), so they don't
require a custom voice clone or paid-only model.
"""

from __future__ import annotations

import os
from typing import Final

import httpx


_ELEVENLABS_API = "https://api.elevenlabs.io/v1/text-to-speech"


# persona_key → ElevenLabs voice_id. Chosen for MAXIMAL timbre contrast:
# mixed accents (British / American / Australian / Southern US), mixed
# gender, mixed age. Subtle timbre differences get flattened on the
# turbo model, so we pick voices that differ on features the model
# preserves well (accent, F0, speaking rate).
VOICE_MAP: Final[dict[str, str]] = {
    "skeptic":       "onwK4e9ZLuTAKqWW03F9",  # Daniel — British news anchor, incisive
    "methodologist": "pqHfZKP75CvOlQylNhV4",  # Bill — older American, warm narrator
    "practitioner":  "nPczCjzI2devNBz1zQrb",  # Brian — deep mature American male
    "hype":          "jsCqWAovK2LkecY7zXl4",  # Freya — young American female, bright
    "gradstudent":   "TxGEqnHWrfWFTfGW9XjX",  # Josh — young American male, earnest
    "archivist":     "XB0fDUnXU5powFXDhCwa",  # Charlotte — British female, raspy
    "amplifier":     "oWAxZDx7w5VEj9dCyTzz",  # Grace — Southern American female, energetic
}

_DEFAULT_VOICE: Final[str] = "21m00Tcm4TlvDq8ikWAM"  # Rachel


def voice_id_for(persona_key: str) -> str:
    return VOICE_MAP.get(persona_key, _DEFAULT_VOICE)


class TTSUnavailable(RuntimeError):
    """Raised when ELEVENLABS_API_KEY is unset — caller should mark the
    feed's audio_status='failed' and surface a friendly error."""


def synthesize(text: str, voice_id: str, *, timeout: float = 30.0) -> bytes:
    """Render `text` to mp3 bytes using the given ElevenLabs voice.

    Uses the turbo v2.5 model by default (fast + cheap; fine for
    conversational post-length snippets). Override via
    ELEVENLABS_MODEL_ID. Raises TTSUnavailable when the key is missing
    and httpx.HTTPStatusError for non-2xx responses — the caller is
    expected to handle both.
    """
    api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not api_key:
        raise TTSUnavailable("ELEVENLABS_API_KEY is not set")

    model_id = os.getenv("ELEVENLABS_MODEL_ID", "eleven_turbo_v2_5")
    url = f"{_ELEVENLABS_API}/{voice_id}"
    headers = {
        "xi-api-key": api_key,
        "accept": "audio/mpeg",
        "content-type": "application/json",
    }
    payload = {
        "text": text,
        "model_id": model_id,
        # Default stability/similarity work well for conversational
        # reads. Bump stability higher for longer-form narration if we
        # ever add paper-summary audio.
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
    }
    with httpx.Client(timeout=timeout) as client:
        resp = client.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        return resp.content
