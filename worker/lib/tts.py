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


# persona_key → ElevenLabs voice_id. See lib.persona.get_personas for the
# full list of keys. Personas not listed fall back to _DEFAULT_VOICE.
VOICE_MAP: Final[dict[str, str]] = {
    "skeptic":       "pNInz6obpgDQGcFmaJgB",  # Adam — deep, serious
    "methodologist": "GBv7mTt0atIp3Br8iCZE",  # Thomas — calm, analytical
    "practitioner":  "ErXwobaYiN019PkySvjV",  # Antoni — well-rounded, mature
    "hype":          "EXAVITQu4vr4xnSDxMaL",  # Bella — enthusiastic
    "gradstudent":   "TxGEqnHWrfWFTfGW9XjX",  # Josh — younger, earnest
    "archivist":     "21m00Tcm4TlvDq8ikWAM",  # Rachel — neutral narrator
    "amplifier":     "MF3mGyEYCl7XYWbV9V6O",  # Elli — energetic
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
