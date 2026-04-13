"""Preference aggregation — compute learned weights from user likes.

Phase 2 of Like as Training Signal. Queries user_likes, computes
per-persona hit rate, per-post-type affinity, and per-category weighting.
Annotated likes are weighted higher. Stores result in user_settings.preferences.
"""

import json
from collections import defaultdict

import structlog

from celery_app import app
from lib.db import fetch, fetchrow, execute
from lib.settings import STUB_USER_ID

logger = structlog.get_logger(__name__)

# Minimum likes before preferences kick in — below this we don't have enough signal
MIN_LIKES_THRESHOLD = 5

# How much extra weight an annotated like gets (like + annotation = stronger signal)
ANNOTATION_BOOST = 2.0

# Blend ratio: how much learned preferences influence vs manual settings
# 0.0 = only manual, 1.0 = only learned. 0.4 means 40% learned, 60% manual.
PREFERENCE_BLEND = 0.4


@app.task(name="tasks.preference_tasks.compute_preferences")
def compute_preferences(user_id: str | None = None) -> dict:
    """Compute preference profile from user likes data.

    Produces:
      - persona_weights: {persona_key: float} — relative preference per persona
      - post_type_weights: {post_type: float} — relative preference per post type
      - category_weights: {category: float} — relative preference per category
      - liked_paper_titles: [str] — paper titles from liked posts (for retrieval boost)
      - total_likes: int
      - has_signal: bool — whether we have enough data to influence generation
    """
    uid = user_id or STUB_USER_ID
    log = logger.bind(user_id=uid)

    # Get all likes with their metadata
    likes = fetch(
        """SELECT ul.feed_id, ul.post_index, ul.persona_key, ul.post_type, ul.category, ul.liked_at
           FROM user_likes ul
           WHERE ul.user_id = $1""",
        uid,
    )

    total = len(likes)
    if total < MIN_LIKES_THRESHOLD:
        preferences = {
            "persona_weights": {},
            "post_type_weights": {},
            "category_weights": {},
            "liked_paper_titles": [],
            "total_likes": total,
            "has_signal": False,
        }
        _store_preferences(uid, preferences)
        log.info("preferences_computed", total_likes=total, has_signal=False)
        return preferences

    # Check which liked posts also have annotations (stronger signal)
    annotated = set()
    if likes:
        annotation_rows = fetch(
            """SELECT DISTINCT feed_id, post_index FROM annotations
               WHERE user_id = $1""",
            uid,
        )
        for row in annotation_rows:
            annotated.add((str(row["feed_id"]), row["post_index"]))

    # Count weighted occurrences
    persona_counts: dict[str, float] = defaultdict(float)
    type_counts: dict[str, float] = defaultdict(float)
    category_counts: dict[str, float] = defaultdict(float)
    total_weight = 0.0

    for like in likes:
        weight = 1.0
        if (str(like["feed_id"]), like["post_index"]) in annotated:
            weight = ANNOTATION_BOOST

        if like["persona_key"]:
            persona_counts[like["persona_key"]] += weight
        if like["post_type"]:
            type_counts[like["post_type"]] += weight
        if like["category"]:
            category_counts[like["category"]] += weight
        total_weight += weight

    # Normalize to relative weights (sum to 1.0)
    persona_weights = _normalize(persona_counts)
    post_type_weights = _normalize(type_counts)
    category_weights = _normalize(category_counts)

    # Extract paper titles from liked posts' sources for retrieval boost
    liked_paper_titles = _get_liked_paper_titles(uid)

    preferences = {
        "persona_weights": persona_weights,
        "post_type_weights": post_type_weights,
        "category_weights": category_weights,
        "liked_paper_titles": liked_paper_titles,
        "total_likes": total,
        "has_signal": True,
    }

    _store_preferences(uid, preferences)
    log.info("preferences_computed",
             total_likes=total,
             personas=persona_weights,
             types=post_type_weights,
             categories=category_weights,
             liked_papers=len(liked_paper_titles))

    return preferences


def _normalize(counts: dict[str, float]) -> dict[str, float]:
    """Normalize counts to weights summing to 1.0."""
    total = sum(counts.values())
    if total == 0:
        return {}
    return {k: round(v / total, 4) for k, v in counts.items()}


def _get_liked_paper_titles(user_id: str) -> list[str]:
    """Extract unique paper titles from the source chunks of liked posts."""
    # Get feed_id + post_index for all likes
    likes = fetch(
        "SELECT feed_id, post_index FROM user_likes WHERE user_id = $1",
        user_id,
    )
    if not likes:
        return []

    # For each liked post, extract paper_ref from the feed's JSONB posts array
    paper_titles: set[str] = set()
    # Group by feed to minimize queries
    feeds: dict[str, list[int]] = defaultdict(list)
    for like in likes:
        feeds[str(like["feed_id"])].append(like["post_index"])

    for feed_id, indices in feeds.items():
        row = fetchrow("SELECT posts FROM feeds WHERE id = $1", feed_id)
        if not row:
            continue
        posts = row["posts"]
        if isinstance(posts, str):
            posts = json.loads(posts)

        for idx in indices:
            if idx < len(posts):
                post = posts[idx]
                # Get paper_ref (the citation line)
                ref = post.get("paper_ref")
                if ref:
                    paper_titles.add(ref)
                # Also get paper titles from sources
                for src in post.get("sources", []):
                    title = src.get("paper_title")
                    if title:
                        paper_titles.add(title)

    return list(paper_titles)


def _store_preferences(user_id: str, preferences: dict) -> None:
    """Store computed preferences in user_settings JSONB."""
    row = fetchrow(
        "SELECT settings FROM user_settings WHERE user_id = $1",
        user_id,
    )
    existing = {}
    if row:
        existing = row["settings"]
        if isinstance(existing, str):
            existing = json.loads(existing)

    existing["preferences"] = preferences
    settings_json = json.dumps(existing)

    execute(
        """INSERT INTO user_settings (user_id, settings, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (user_id) DO UPDATE SET settings = $2, updated_at = NOW()""",
        user_id, settings_json,
    )


def get_preferences(user_id: str | None = None) -> dict | None:
    """Read stored preferences from user_settings. Returns None if not computed yet."""
    uid = user_id or STUB_USER_ID
    row = fetchrow(
        "SELECT settings FROM user_settings WHERE user_id = $1",
        uid,
    )
    if not row:
        return None
    settings = row["settings"]
    if isinstance(settings, str):
        settings = json.loads(settings)
    return settings.get("preferences")
