"""Shared constants for the Ficino API."""

from ficino_shared.constants import DEFAULT_WORKSPACE_ID, STUB_USER_ID  # noqa: F401

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
