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

# --- Collection LIMIT caps (R10 BP-18) ---
# List-endpoint SQL previously buried a bare integer LIMIT per site with no
# shared place to see or tune them. These are Python constants interpolated
# into f-string SQL at query-build time, NOT user input — every call site
# passes them as a literal into the query text, never through a request
# param, so there is no injection surface. Named per distinct collection;
# where a name lists more than one file, those sites cap conceptually the
# same kind of list (same value, same rationale) and intentionally share
# one constant rather than one per file, matching how R10's review grouped
# them.
MAX_FEEDS_LIST = 20  # feed.py: list_feeds
MAX_CONTENT_LIST = 50  # user_posts.py: list_user_posts; messages.py: list_group_chats
MAX_ALERTS_LIST = 50  # alerts.py: list_alerts (own constant despite equal value -- different collection, not a maintenance-shared cap)
MAX_ACTIVITY_FEED = 100  # replies.py: list_conversations; personas.py: persona interjection activity
MAX_PAPER_SUMMARIES_LIST = 200  # messages.py: list of paper-summary (DM) threads
MAX_LIBRARY_LIST = 500  # papers.py: list_papers; bookmarks.py: list_bookmarks
MAX_ANNOTATIONS_LIST = 1000  # annotations.py: list_annotations
MAX_SEARCH_RESULTS = 10  # search.py: paper hits + post hits (same cap, parallel prominence in the combined response)
MAX_SEARCH_CHUNKS = 15  # search.py: chunk (full-text passage) hits
