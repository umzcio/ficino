"""Shared constants for the Ficino API."""

STUB_USER_ID = "00000000-0000-0000-0000-000000000000"
DEFAULT_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001"

# Synthetic engagement counts attached to generated posts. These are
# cosmetic — the feed renders like Twitter and an empty-zero display
# reads as "no one cared." Centralized here so both the first-generation
# and regeneration paths (persona_tasks.py) share one source of truth.
ENGAGEMENT_RANGES: dict[str, tuple[int, int]] = {
    "likes": (100, 5000),
    "retweets": (20, 1000),
    "replies": (10, 500),
    "bookmarks": (10, 900),
}
