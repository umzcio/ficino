"""R10 BP-6 characterization: replies.py and personas.py hardcoded
`RateLimit(..., 60)` inline with no env override, while every sibling
dispatch site's per-day cap flowed through `config.Settings`. These two
knobs now exist on Settings (default 60, matching the previous hardcoded
value) so operators can tune them like every other rate limit.

`generation_limit_per_day` is a separate dead/duplicate knob (R10 DEP-5,
owned by a later wave) and is deliberately left alone here."""
from __future__ import annotations

from config import Settings


def test_rate_limit_replies_per_day_defaults_to_60():
    s = Settings()
    assert s.rate_limit_replies_per_day == 60


def test_rate_limit_persona_dm_per_day_defaults_to_60():
    s = Settings()
    assert s.rate_limit_persona_dm_per_day == 60


def test_generation_limit_per_day_untouched():
    """DEP-5 (dead duplicate of rate_limit_generations_per_day) is wave 5's
    responsibility, not this task's — assert it's still present and at its
    long-standing default so an accidental deletion here would be caught."""
    s = Settings()
    assert s.generation_limit_per_day == 20
