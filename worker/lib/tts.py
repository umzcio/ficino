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


# persona_key → ElevenLabs voice_id. Voices chosen to MATCH each
# persona's visual avatar — gender first, then tone and age. Getting
# gender wrong breaks immersion harder than any other mismatch
# (listeners double-take when the Black man on fire sounds like a
# Southern woman). When possible we keep accents/ages varied so the
# seven speakers still sound clearly distinct on the turbo model.
VOICE_MAP: Final[dict[str, str]] = {
    # Methods Skeptic: young woman in lab coat with magnifying glass → sharp female
    "skeptic":       "AZnzlk1XvdvUeBnXmlld",  # Domi — strong young female, confident
    # Stats Nerd: young woman with curly hair, excited about data → bright female
    "methodologist": "1Hdh5sdoicm1xyz0gQhD",  # Liz — social media / ad female voice
    # Practitioner Pat: white guy, glasses, hoodie, coffee → warm mature male
    "practitioner":  "3nDq4c7a9Pk3q5rxbMJH",  # Matthew — friendly, warm, resonant
    # AI Breakthroughs: stylized Greek philosopher bust → British narrator
    "hype":          "JBFqnCBsd6RMkjVDRZzb",  # George — British warm narration (philosopher energy)
    # PhD Candidate: tired bearded guy, hoodie, laptop → young earnest male
    "gradstudent":   "PzuBz8h2SxBvQ7lnUC44",  # Gregory — tech reviewer social media
    # The Archivist: Greek goddess in laurel crown and white robes → ethereal British female
    "archivist":     "pFZP5JQG7iQjIQuC4Bku",  # Lily — British warm female, measured
    # The Amplifier: Black man, glasses, beard, on fire, charismatic → intense male
    "amplifier":     "MjDkeH2x9hCiWKXZtUPc",  # Marcos — warm, direct, professional
    # Podcast hosts (NotebookLM-style two-host episodes). Not personas —
    # just narrator voices that paraphrase personas + chunks in dialogue.
    "host_a":        "5Q0t7uMcjvnagumLfvZi",  # Paul — warm newscaster male
    "host_b":        "21m00Tcm4TlvDq8ikWAM",  # Rachel — neutral female (== _DEFAULT_VOICE)
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
