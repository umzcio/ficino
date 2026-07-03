"""R10 BP-6 characterization: replies.py and personas.py hardcoded
`RateLimit(..., 60)` inline with no env override, while every sibling
dispatch site's per-day cap flowed through `config.Settings`. These two
knobs now exist on Settings (default 60, matching the previous hardcoded
value) so operators can tune them like every other rate limit.

`generation_limit_per_day` was a separate dead/duplicate knob (R10 DEP-5)
with zero `settings.X` reads anywhere in api/ or worker/ — the live knob is
`rate_limit_generations_per_day` above. Wave 5 deleted the field from
config.py; the test below now asserts its absence instead of its value so
a future re-add of the same dead knob gets caught."""
from __future__ import annotations

from config import Settings


def test_rate_limit_replies_per_day_defaults_to_60():
    s = Settings()
    assert s.rate_limit_replies_per_day == 60


def test_rate_limit_persona_dm_per_day_defaults_to_60():
    s = Settings()
    assert s.rate_limit_persona_dm_per_day == 60


def test_generation_limit_per_day_removed():
    """R10 DEP-5: `generation_limit_per_day` deleted from Settings — it was
    a dead duplicate of `rate_limit_generations_per_day` (0 reads anywhere).
    Asserts the field no longer exists, superseding the wave-3
    characterization test that asserted its presence."""
    s = Settings()
    assert not hasattr(s, "generation_limit_per_day")
